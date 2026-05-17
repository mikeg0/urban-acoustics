"""Single-process supervisor.

One async task per concern, all sharing the same event loop:

* ``_capture_loop``: pulls 1 s PCM blocks from ``arecord``, pushes them into
  the ring buffer, computes telemetry, feeds the detector, and queues events
  for upload.
* ``_telemetry_loop``: not needed — telemetry is produced inside the capture
  loop because it has to be aligned with the 1 s block boundary.
* ``_health_loop``: per-minute health publish + RSS check.
* ``_drain_mqtt_loop``: replays queued MQTT messages while the broker is up.
* ``_uploader_loop``: walks pending event uploads.
* ``_watchdog_loop``: notices when the capture loop has gone quiet and
  bumps a counter so the systemd watchdog can restart us.

The supervisor stops cleanly on SIGTERM (systemd's normal stop path) and
SIGINT (Ctrl-C during dev). On any unrecoverable error we exit non-zero so
systemd restarts the unit.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import time
from uuid import uuid4

from .calibration import from_config as calibration_from_config
from .capture import AudioCapture, PcmBlock
from .config import Config
from .detector import EventCandidate, EventDetector
from .dsp import compute_telemetry
from .encoder import FlacEncoderError, encode_flac
from .health import HealthPublisher
from .queue_store import QueueStore
from .ringbuffer import AudioRingBuffer
from .telemetry import TelemetryPublisher, TelemetrySample
from .transport import ApiTransport, MqttTransport
from .uploader import EventUploader


log = logging.getLogger(__name__)


# Knobs that don't deserve a config field yet.
_HEALTH_FIRST_DELAY_S = 5.0
_MQTT_DRAIN_PERIOD_S = 2.0
_UPLOADER_DRAIN_PERIOD_S = 5.0
_WATCHDOG_PERIOD_S = 15.0
_WATCHDOG_STALL_S = 30.0


class Supervisor:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self._stop_event: asyncio.Event | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._started_at = time.time()

        cfg.audio_dir.mkdir(parents=True, exist_ok=True)

        self.calibration = calibration_from_config(cfg)
        self.queue = QueueStore(cfg.queue_db_path, max_bytes=cfg.queue_max_bytes)
        self.capture = AudioCapture(
            alsa_device=cfg.alsa_device,
            sample_rate=cfg.sample_rate,
            channels=cfg.channels,
            pcm_format=cfg.pcm_format,
            block_seconds=cfg.telemetry_period_s,
        )
        # Ring buffer must hold at least pre-roll + the longest event + a
        # small safety margin so a late detector close still finds the audio.
        ring_seconds = cfg.event_pre_roll_s + cfg.event_max_duration_s + cfg.event_post_roll_s + 2.0
        self.ringbuffer = AudioRingBuffer(sample_rate=cfg.sample_rate, seconds=ring_seconds)
        self.detector = EventDetector(
            threshold_db=cfg.event_threshold_db,
            hysteresis_db=cfg.event_hysteresis_db,
            min_duration_s=cfg.event_min_duration_s,
            max_duration_s=cfg.event_max_duration_s,
            pre_roll_s=cfg.event_pre_roll_s,
            post_roll_s=cfg.event_post_roll_s,
            cooldown_s=cfg.event_cooldown_s,
        )

        # Components needing the event loop are wired up in run().
        self.mqtt: MqttTransport | None = None
        self.api: ApiTransport | None = None
        self.telemetry: TelemetryPublisher | None = None
        self.health: HealthPublisher | None = None
        self.uploader: EventUploader | None = None
        self._pending_events: list[EventCandidate] = []
        self._last_capture_at = self._started_at

    # --- lifecycle --------------------------------------------------------

    async def run(self) -> int:
        self._loop = asyncio.get_running_loop()
        self._stop_event = asyncio.Event()
        self._install_signal_handlers()

        self.queue.open()

        self.mqtt = MqttTransport(
            device_id=self.cfg.device_id,
            broker_host=self.cfg.mqtt_broker_host,
            broker_port=self.cfg.mqtt_broker_port,
            ca_file=self.cfg.mqtt_ca_file,
            cert_file=self.cfg.mqtt_cert_file,
            key_file=self.cfg.mqtt_key_file,
            keepalive_s=self.cfg.mqtt_keepalive_s,
            loop=self._loop,
        )
        self.api = ApiTransport(
            device_id=self.cfg.device_id,
            api_base=self.cfg.api_base,
            ca_file=self.cfg.mqtt_ca_file,
            cert_file=self.cfg.mqtt_cert_file,
            key_file=self.cfg.mqtt_key_file,
            timeout_s=self.cfg.api_timeout_s,
        )
        self.telemetry = TelemetryPublisher(
            device_id=self.cfg.device_id, mqtt=self.mqtt, queue=self.queue,
        )
        self.health = HealthPublisher(
            device_id=self.cfg.device_id,
            cfg=self.cfg,
            mqtt=self.mqtt,
            queue=self.queue,
            started_at=self._started_at,
        )
        self.uploader = EventUploader(
            device_id=self.cfg.device_id, mqtt=self.mqtt, api=self.api, queue=self.queue,
        )
        self.mqtt.start()

        tasks = [
            asyncio.create_task(self._capture_loop(), name="capture"),
            asyncio.create_task(self._health_loop(), name="health"),
            asyncio.create_task(self._drain_mqtt_loop(), name="mqtt-drain"),
            asyncio.create_task(self._uploader_loop(), name="uploader"),
            asyncio.create_task(self._watchdog_loop(), name="watchdog"),
        ]
        log.info(
            "supervisor: running (device=%s fw=%s config=%s)",
            self.cfg.device_id, self.cfg.fw_version, self.cfg.config_version,
        )
        rc = 0
        try:
            await self._stop_event.wait()
        except Exception as exc:  # noqa: BLE001
            log.exception("supervisor: unexpected error: %s", exc)
            rc = 1
        finally:
            log.info("supervisor: stopping")
            for t in tasks:
                t.cancel()
            for t in tasks:
                try:
                    await t
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
            try:
                self.mqtt.stop()
            except Exception:  # noqa: BLE001
                pass
            try:
                await self.api.aclose()
            except Exception:  # noqa: BLE001
                pass
            self.queue.close()
        return rc

    def _install_signal_handlers(self) -> None:
        assert self._loop is not None and self._stop_event is not None
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                self._loop.add_signal_handler(sig, self._stop_event.set)
            except NotImplementedError:
                signal.signal(sig, lambda *_: self._stop_event.set())  # type: ignore[union-attr]

    # --- capture / DSP / detection ---------------------------------------

    async def _capture_loop(self) -> None:
        assert self._stop_event is not None
        assert self.telemetry is not None
        async for block in self.capture.blocks(self._stop_event):
            try:
                await self._handle_block(block)
            except Exception as exc:  # noqa: BLE001
                log.exception("capture: block handling failed: %s", exc)

    async def _handle_block(self, block: PcmBlock) -> None:
        assert self.telemetry is not None
        self._last_capture_at = time.time()
        self.ringbuffer.append(block.samples, block.ts)

        # DSP is CPU-bound but very short at 48 kHz / 1 s; ~20-40 ms on a
        # Pi Zero 2 W. Run in a worker thread anyway so the asyncio loop
        # stays responsive to MQTT callbacks.
        laeq, lafmax, lcpeak = await asyncio.to_thread(
            compute_telemetry, block.samples, block.sample_rate, self.calibration,
        )
        sample = TelemetrySample(ts=block.ts, laeq=laeq, lafmax=lafmax, lcpeak=lcpeak)
        await self.telemetry.emit(sample)

        candidate = self.detector.feed(ts=block.ts, lafmax_db=lafmax)
        if candidate is not None:
            self._pending_events.append(candidate)
        await self._flush_pending_events(now=block.ts + block.samples.size / block.sample_rate)

    async def _flush_pending_events(self, *, now: float) -> None:
        """Promote events whose post-roll window is now in the ring buffer
        to actual encode + upload work. Each event is processed at most
        once per call so encoding does not stall the capture loop."""
        if not self._pending_events:
            return
        remaining: list[EventCandidate] = []
        for cand in self._pending_events:
            if now < cand.end_ts:
                remaining.append(cand)
                continue
            try:
                await self._materialise_event(cand)
            except Exception as exc:  # noqa: BLE001
                log.exception("event materialise failed: %s", exc)
        self._pending_events = remaining

    async def _materialise_event(self, cand: EventCandidate) -> None:
        samples, actual_start = self.ringbuffer.extract(cand.start_ts, cand.end_ts)
        if samples.size == 0:
            log.warning("event %.3f: no audio available in ring buffer", cand.triggered_ts)
            return

        try:
            encoded = await asyncio.to_thread(encode_flac, samples, self.cfg.sample_rate)
        except FlacEncoderError as exc:
            log.error("event %.3f: encode failed: %s", cand.triggered_ts, exc)
            return

        event_id = str(uuid4())
        flac_path = self.cfg.audio_dir / f"{event_id}.flac"
        try:
            flac_path.write_bytes(encoded.data)
        except OSError as exc:
            log.error("event %s: failed to spool FLAC: %s", event_id, exc)
            return

        await self.queue.add_event_upload(
            event_id=event_id,
            ts=actual_start,
            duration_s=encoded.duration_s,
            peak_db=cand.peak_db,
            sha256=encoded.sha256,
            size=encoded.size,
            flac_path=flac_path,
        )
        # Announce inline so the cloud sees it ASAP; if the broker is down
        # the publish gets queued. The actual PUT happens in the uploader.
        assert self.uploader is not None
        from .queue_store import QueuedUpload
        upload = QueuedUpload(
            event_id=event_id,
            ts=actual_start,
            duration_s=encoded.duration_s,
            peak_db=cand.peak_db,
            sha256=encoded.sha256,
            size=encoded.size,
            flac_path=flac_path,
            status="pending",
            storage_key=None,
            attempt_count=0,
        )
        await self.uploader.announce(upload)
        log.info(
            "event %s: spooled %d B (sha=%s peak=%.1f dB duration=%.1fs)",
            event_id, encoded.size, encoded.sha256[:8], cand.peak_db, encoded.duration_s,
        )

    # --- periodic loops ---------------------------------------------------

    async def _health_loop(self) -> None:
        assert self._stop_event is not None
        assert self.health is not None
        first = True
        while not self._stop_event.is_set():
            wait = _HEALTH_FIRST_DELAY_S if first else self.cfg.health_period_s
            first = False
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=wait)
            except asyncio.TimeoutError:
                pass
            else:
                return
            try:
                await self.health.emit()
            except Exception as exc:  # noqa: BLE001
                log.exception("health: emit failed: %s", exc)
            rss_mb = HealthPublisher.memory_rss_mb()
            if rss_mb > self.cfg.memory_soft_cap_mb:
                log.warning("supervisor: RSS %.1f MB above soft cap %d MB", rss_mb, self.cfg.memory_soft_cap_mb)

    async def _drain_mqtt_loop(self) -> None:
        assert self._stop_event is not None
        assert self.mqtt is not None
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=_MQTT_DRAIN_PERIOD_S)
                return
            except asyncio.TimeoutError:
                pass
            if not self.mqtt.connected:
                continue
            now = time.time()
            try:
                due = await self.queue.pop_due_mqtt(now=now, limit=64)
            except Exception as exc:  # noqa: BLE001
                log.exception("mqtt drain: pop failed: %s", exc)
                continue
            for msg in due:
                result = self.mqtt.publish(msg.topic, msg.payload, qos=msg.qos, timeout=3.0)
                if result.ok:
                    await self.queue.ack_mqtt(msg.id)
                else:
                    await self.queue.fail_mqtt(msg.id)
                    # Broker may have just dropped; stop draining this tick.
                    break

    async def _uploader_loop(self) -> None:
        assert self._stop_event is not None
        assert self.uploader is not None
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=_UPLOADER_DRAIN_PERIOD_S)
                return
            except asyncio.TimeoutError:
                pass
            try:
                await self.uploader.drain_once()
            except Exception as exc:  # noqa: BLE001
                log.exception("uploader: drain raised: %s", exc)

    async def _watchdog_loop(self) -> None:
        assert self._stop_event is not None
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=_WATCHDOG_PERIOD_S)
                return
            except asyncio.TimeoutError:
                pass
            stale = time.time() - self._last_capture_at
            if stale > _WATCHDOG_STALL_S:
                log.error(
                    "watchdog: no capture block for %.1fs (last=%.1f, restarts=%d) — exiting for systemd",
                    stale, self._last_capture_at, self.capture.restart_count,
                )
                self._stop_event.set()
                return

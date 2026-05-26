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
import json
import logging
import signal
import time
from uuid import uuid4

import numpy as np

from .calibration import from_config as calibration_from_config
from .capture import AudioCapture, PcmBlock
from .classifier import Classifier, load_classifier
from .config import (
    Config,
    MUTABLE_FIELDS,
    load_config,
    write_overlay,
)
from .detector import EventCandidate, EventDetector
from .dsp import STFTBander, compute_telemetry
from .encoder import FlacEncoderError, encode_flac
from .gpio import LedController
from .health import HealthPublisher
from .queue_store import QueueStore
from .ringbuffer import AudioRingBuffer
from .telemetry import (
    SpectrogramPublisher,
    SpectrogramSample,
    TelemetryPublisher,
    TelemetrySample,
)
from .transport import ApiTransport, MqttTransport
from .uploader import EventUploader


log = logging.getLogger(__name__)


# Knobs that don't deserve a config field yet.
_HEALTH_FIRST_DELAY_S = 5.0
_MQTT_DRAIN_PERIOD_S = 2.0
_UPLOADER_DRAIN_PERIOD_S = 5.0
_WATCHDOG_PERIOD_S = 15.0
_WATCHDOG_STALL_S = 30.0

# BCM pin for the on-board "identify" LED. Toggled by the dashboard via the
# `led` MQTT command.
_LED_GPIO = 4


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

        self.led = LedController(_LED_GPIO)
        # LED mode is one of:
        #   'auto' — follows the live breach state (default)
        #   'on'   — held high regardless of LAFmax
        #   'off'  — held low regardless of LAFmax
        # ``_led_state`` mirrors the last physical write so we don't thrash
        # sysfs every 1 s when the auto-mode value hasn't changed.
        self._led_mode: str = "auto"
        self._led_state: bool = False

        # Components needing the event loop are wired up in run().
        self.mqtt: MqttTransport | None = None
        self.api: ApiTransport | None = None
        self.telemetry: TelemetryPublisher | None = None
        self.health: HealthPublisher | None = None
        self.uploader: EventUploader | None = None
        self.spectrogram: SpectrogramPublisher | None = None
        # Lazily constructed when the first PCM block arrives — keeps the
        # sample-rate/calibration dependency local to the capture loop.
        self.stft_bander: STFTBander | None = None
        self._spect_frame_counter: int = 0
        self._pending_events: list[EventCandidate] = []
        self._last_capture_at = self._started_at

        # Pi-side classifier (Track 1). Optional — if the weights file
        # is missing or unreadable, this stays None and the supervisor
        # behaves exactly as it did before classification existed.
        self.classifier: Classifier | None = load_classifier(cfg.classifier_path)
        if cfg.upload_all_events:
            log.info(
                "supervisor: URBAN_ACOUSTICS_UPLOAD_ALL_EVENTS is on — "
                "no events will be suppressed by the classifier"
            )

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
            command_handler=self._on_command,
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
        if self.cfg.spectrogram_enabled:
            self.spectrogram = SpectrogramPublisher(
                device_id=self.cfg.device_id, mqtt=self.mqtt,
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

    # --- command channel --------------------------------------------------

    async def _on_command(self, topic: str, payload: bytes) -> None:
        """Apply a retained ``dev/<id>/cmd/<verb>`` envelope.

        Runs on the asyncio loop (paho dispatches via run_coroutine_threadsafe,
        see transport.py). Only ``cmd=config`` is wired in v1; other verbs
        get logged and dropped so a stray retained message doesn't crash the
        supervisor.
        """
        verb = topic.rsplit("/", 1)[-1] if "/" in topic else ""
        try:
            envelope = json.loads(payload.decode())
        except (json.JSONDecodeError, UnicodeDecodeError):
            log.warning("cmd: malformed JSON on %s (len=%d) — dropping", topic, len(payload))
            return
        if not isinstance(envelope, dict):
            log.warning("cmd: non-object envelope on %s — dropping", topic)
            return
        env_cmd = envelope.get("cmd")
        if env_cmd != verb:
            log.warning(
                "cmd: topic verb %r != envelope cmd %r on %s — dropping",
                verb, env_cmd, topic,
            )
            return

        if verb == "config":
            await self._apply_config_command(envelope.get("args") or {})
            return
        if verb == "led":
            await self._apply_led_command(envelope.get("args") or {})
            return
        log.info("cmd: unsupported verb %r on %s — ignoring", verb, topic)

    async def _apply_led_command(self, args: dict) -> None:
        """Apply a ``led`` command — switch between auto/on/off modes.

        ``auto`` releases the LED back to the capture loop's breach
        indicator; ``on`` / ``off`` latch the LED and suspend auto updates
        until the next ``auto`` command arrives. Malformed envelopes are
        dropped so a stray retained payload can't wedge the supervisor.
        """
        if not isinstance(args, dict):
            log.warning("cmd/led: args is not an object — dropping")
            return
        mode = args.get("mode")
        if mode not in ("auto", "on", "off"):
            log.warning("cmd/led: unsupported mode %r — dropping", mode)
            return

        self._led_mode = mode
        log.info("cmd/led: mode=%s", mode)
        if mode == "on":
            await self._set_led_state(True)
        elif mode == "off":
            await self._set_led_state(False)
        # 'auto' takes effect on the next capture block — no immediate
        # write here so the auto-mode logic owns the decision.

    async def _set_led_state(self, on: bool) -> None:
        """Idempotent LED write; logs and swallows OSError so a transient
        sysfs hiccup can't kill the capture loop."""
        if on == self._led_state:
            return
        try:
            await asyncio.to_thread(self.led.set_state, on)
        except OSError as exc:
            log.warning("led: gpio write failed: %s", exc)
            return
        self._led_state = on

    async def _update_breach_led(self, lafmax_db: float) -> None:
        """Auto-mode tick: drive the LED from the current LAFmax block.

        Uses the same threshold + hysteresis pair as the event detector
        so the visual state matches the dashboard's notion of a breach.
        No-op when the operator has latched the LED into ``on``/``off``.
        """
        if self._led_mode != "auto":
            return
        threshold = self.cfg.event_threshold_db
        close_db = threshold - self.cfg.event_hysteresis_db
        if self._led_state:
            if lafmax_db < close_db:
                await self._set_led_state(False)
        else:
            if lafmax_db >= threshold:
                await self._set_led_state(True)

    async def _apply_config_command(self, args: dict) -> None:
        """Apply a ``config`` command. The envelope's ``args`` carries the
        full overlay the cloud wants in effect; we filter to MUTABLE_FIELDS,
        validate the values, persist them, and update the running detector.
        """
        if not isinstance(args, dict):
            log.warning("cmd/config: args is not an object — dropping")
            return
        updates: dict = {}
        for key, value in args.items():
            if key not in MUTABLE_FIELDS:
                log.warning("cmd/config: dropping unknown key %r", key)
                continue
            if key == "event_threshold_db":
                try:
                    v = float(value)
                except (TypeError, ValueError):
                    log.warning("cmd/config: event_threshold_db %r is not numeric — dropping", value)
                    continue
                # Belt-and-braces range check; the backend already enforces
                # this but the Pi shouldn't trust the wire.
                if not 50.0 <= v <= 110.0:
                    log.warning("cmd/config: event_threshold_db %.2f out of range — dropping", v)
                    continue
                updates[key] = v
            elif key == "paused":
                if not isinstance(value, bool):
                    log.warning("cmd/config: paused %r is not boolean — dropping", value)
                    continue
                updates[key] = value
        if not updates:
            log.info("cmd/config: no applicable updates after filtering")
            return

        try:
            new_overlay = write_overlay(updates)
        except (OSError, ValueError) as exc:
            log.error("cmd/config: persist failed: %s", exc)
            return

        if "event_threshold_db" in updates and self.detector is not None:
            new_threshold = float(updates["event_threshold_db"])
            # Detector reads these attributes on every feed() call, so a
            # straight assignment is enough — no detector restart needed.
            self.detector.threshold_db = new_threshold
            self.detector.close_db = new_threshold - self.cfg.event_hysteresis_db

        # Rebuild Config so config_version reflects the new overlay; the
        # health publisher captures cfg by reference so this propagates on
        # its next emit.
        try:
            new_cfg = load_config()
        except SystemExit as exc:
            log.error("cmd/config: reload failed: %s", exc)
            return
        self.cfg = new_cfg
        if self.health is not None:
            self.health._cfg = new_cfg  # noqa: SLF001 — same package, narrow seam
        log.info(
            "cmd/config: applied %s → config_version=%s",
            new_overlay, new_cfg.config_version,
        )

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

        # Spectrogram: run a separate windowed STFT over the same audio.
        # Skips entirely when disabled in config or the broker is offline
        # (no replay queue — frames are ephemeral).
        if self.spectrogram is not None:
            await self._emit_spectrogram_frames(block)

        await self._update_breach_led(lafmax)

        candidate = self.detector.feed(ts=block.ts, lafmax_db=lafmax)
        if candidate is not None:
            self._pending_events.append(candidate)
        await self._flush_pending_events(now=block.ts + block.samples.size / block.sample_rate)

    async def _emit_spectrogram_frames(self, block: PcmBlock) -> None:
        assert self.spectrogram is not None
        if self.stft_bander is None:
            self.stft_bander = STFTBander(
                sample_rate=block.sample_rate, calib=self.calibration,
            )
        bander = self.stft_bander
        frames = await asyncio.to_thread(bander.feed, block.samples, block.ts)
        decim = max(1, self.cfg.spectrogram_decimate)
        for ts, bands in frames:
            self._spect_frame_counter += 1
            if self._spect_frame_counter % decim != 0:
                continue
            await self.spectrogram.emit(
                SpectrogramSample(ts=ts, bands=tuple(bands.tolist())),
            )

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
        if self.cfg.paused:
            log.debug("event %.3f: skipped (paused)", cand.triggered_ts)
            return
        samples, actual_start = self.ringbuffer.extract(cand.start_ts, cand.end_ts)
        if samples.size == 0:
            log.warning("event %.3f: no audio available in ring buffer", cand.triggered_ts)
            return

        # --- Pi-side prelim classification ---
        # Run the classifier BEFORE we encode FLAC: if we're going to
        # suppress this event, there's no point spending CPU on the
        # encode or disk on the spool file. ``classify`` returns None
        # when the classifier is disabled (no weights loaded) — in
        # that case we always upload, the "fail open" property of
        # Track 1.
        prelim = await asyncio.to_thread(self._classify_event_window, samples, actual_start)
        if prelim is not None and self._should_suppress(prelim, cand.duration_s):
            log.info(
                "event %.3f: suppressing (label=%s confidence=%.2f duration=%.1fs)",
                cand.triggered_ts,
                prelim.label,
                prelim.confidence,
                cand.duration_s,
            )
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

        prelim_class = prelim.label if prelim is not None else None
        prelim_conf = prelim.confidence if prelim is not None else None
        prelim_model = prelim.model_version if prelim is not None else None
        await self.queue.add_event_upload(
            event_id=event_id,
            ts=actual_start,
            duration_s=encoded.duration_s,
            peak_db=cand.peak_db,
            sha256=encoded.sha256,
            size=encoded.size,
            flac_path=flac_path,
            prelim_classification=prelim_class,
            prelim_confidence=prelim_conf,
            prelim_model_version=prelim_model,
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
            prelim_classification=prelim_class,
            prelim_confidence=prelim_conf,
            prelim_model_version=prelim_model,
        )
        await self.uploader.announce(upload)
        log.info(
            "event %s: spooled %d B (sha=%s peak=%.1f dB duration=%.1fs prelim=%s)",
            event_id, encoded.size, encoded.sha256[:8], cand.peak_db, encoded.duration_s,
            prelim_class or "none",
        )

    def _classify_event_window(self, samples: np.ndarray, ts_start: float):
        """Compute bands over the event audio and run the classifier.

        Runs in a worker thread (called via ``asyncio.to_thread``) so
        the few ms of STFT work doesn't stall the capture loop. Returns
        None when classification is disabled or the band buffer is too
        short to be meaningful.
        """
        if self.classifier is None:
            return None
        # Fresh bander so we don't mutate the live one's sliding buffer.
        # Calibration is identical to the live path, so the bands match
        # what the backend stored in spectrogram_frames at training time.
        bander = STFTBander(sample_rate=self.cfg.sample_rate, calib=self.calibration)
        frames = bander.feed(samples, ts_start)
        if not frames:
            return None
        bands = np.stack([b for _ts, b in frames])
        try:
            return self.classifier.predict(bands)
        except Exception as exc:  # noqa: BLE001
            log.exception("classifier: predict raised: %s", exc)
            return None

    def _should_suppress(self, prelim, duration_s: float) -> bool:
        """Suppression check matching the plan's wind/rain/thunder rule.

        Three short-circuits, in order:
        1. Debug env var overrides everything — upload all events.
        2. Predicted class isn't on the suppress list — upload.
        3. Confidence is below threshold — upload, the classifier isn't
           confident enough for us to throw away the audio.
        """
        if self.cfg.upload_all_events:
            return False
        if prelim.label not in self.cfg.classifier_suppress_labels:
            return False
        if prelim.confidence < self.cfg.classifier_suppress_min_confidence:
            return False
        return True

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

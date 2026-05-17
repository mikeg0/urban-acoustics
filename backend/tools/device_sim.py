"""Software device simulator.

Replaces the Raspberry Pi during cloud-side development and CI. Speaks the
same Phase 1 contracts the firmware will: per-device mTLS to the broker,
1 Hz telemetry, periodic health, `POST /api/v1/events/intent`, presigned
PUT to MinIO, and `event/done` on MQTT.

Run inside the compose stack (the simplest path; cert/CA paths and DNS
already match the broker and API):

    docker compose run --rm --entrypoint "" backend \
        python -m tools.device_sim \
            --device-id 00000000-0000-4000-8000-00000000000a \
            --once

Or from a host that can reach Mosquitto on :8883 and the API at some URL,
pointing at the dev cert tree directly:

    python -m backend.tools.device_sim \
        --device-id 00000000-0000-4000-8000-00000000000a \
        --broker-host localhost --broker-port 8883 \
        --ca backend/certs/root-ca.crt \
        --cert backend/certs/devices/<uuid>.crt \
        --key  backend/certs/devices/<uuid>.key \
        --api-base http://localhost:8000 \
        --fixture backend/tests/fixtures/event_audio/silence.flac \
        --once

The device must be registered first (``python -m scripts.register_device``)
so the ingest worker and API accept its publishes.

Failure modes (one per run) make the simulator emit something the ingest
or broker should reject — useful for poking the negative paths without
hand-crafted payloads:

    --bad-payload     publishes a telemetry message that violates the contract
    --dup-announce    sends ``event/announce`` twice (idempotency check)
    --dup-done        sends ``event/done`` twice    (idempotency check)
    --wrong-topic     publishes to *another* device's topic; broker ACL denies
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import math
import os
import pathlib
import random
import secrets
import signal
import ssl
import sys
import time
from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

from urllib.parse import urlparse, urlunparse

import httpx
import paho.mqtt.client as mqtt
from paho.mqtt.enums import CallbackAPIVersion

# Importable both as ``tools.device_sim`` (cwd=/app inside the container) and
# as ``backend.tools.device_sim`` from a repo-root checkout.
try:
    from app.contracts import (
        EventAnnounce,
        EventDone,
        EventIntentRequest,
        EventIntentResponse,
        Health,
        Telemetry,
        event_announce_topic,
        event_done_topic,
        health_topic,
        telemetry_topic,
    )
except ImportError:  # pragma: no cover — repo-root invocation
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
    from app.contracts import (  # noqa: E402
        EventAnnounce,
        EventDone,
        EventIntentRequest,
        EventIntentResponse,
        Health,
        Telemetry,
        event_announce_topic,
        event_done_topic,
        health_topic,
        telemetry_topic,
    )


log = logging.getLogger("device-sim")


TELEMETRY_HZ = 1.0
HEALTH_PERIOD_S = 60.0
EVENT_SPIKE_THRESHOLD_DB = 90.0
# After a natural spike we wait this long before another auto-event so we
# don't flood the broker if the noise model parks above threshold for a while.
EVENT_COOLDOWN_S = 30.0


# --- Synthetic acoustic model ----------------------------------------------


@dataclass
class _NoiseModel:
    """LAeq drifts around a mean with a slow diurnal swing; LAFmax sits
    a few dB above LAeq, LCpeak a few more. Occasionally we inject a
    short spike to exercise the event flow on real telemetry."""

    base_db: float = 55.0
    diurnal_amp_db: float = 8.0
    noise_db: float = 3.5
    spike_prob_per_sec: float = 1 / 90.0    # ~one spike every 90 s
    spike_height_db: tuple[float, float] = (30.0, 45.0)

    _last_spike_at: float = 0.0
    _started_at: float = 0.0

    def __post_init__(self) -> None:
        self._started_at = time.time()

    def sample(self, now: float, *, force_spike: bool = False) -> tuple[float, float, float, bool]:
        # Diurnal: one period per minute (sim time), so demos feel alive
        # without waiting 24 hours.
        phase = (now - self._started_at) * (2 * math.pi / 60.0)
        baseline = self.base_db + self.diurnal_amp_db * math.sin(phase)
        laeq = baseline + random.gauss(0.0, self.noise_db)

        spike_now = force_spike or (
            (now - self._last_spike_at > 10.0)
            and random.random() < self.spike_prob_per_sec
        )
        if spike_now:
            bump = random.uniform(*self.spike_height_db)
            laeq += bump
            self._last_spike_at = now

        lafmax = laeq + random.uniform(4.0, 9.0)
        lcpeak = lafmax + random.uniform(5.0, 12.0)
        # Clamp to the contract's accepted dB range.
        clamp = lambda v: max(-20.0, min(200.0, v))  # noqa: E731
        return clamp(laeq), clamp(lafmax), clamp(lcpeak), spike_now


# --- Failure modes --------------------------------------------------------


@dataclass(frozen=True)
class FailureModes:
    bad_payload: bool = False
    dup_announce: bool = False
    dup_done: bool = False
    wrong_topic_device: UUID | None = None  # publish here using *our* cert


# --- Simulator ------------------------------------------------------------


class DeviceSim:
    def __init__(
        self,
        *,
        device_id: UUID,
        broker_host: str,
        broker_port: int,
        ca_file: pathlib.Path,
        cert_file: pathlib.Path,
        key_file: pathlib.Path,
        api_base: str,
        fixture_path: pathlib.Path,
        fw_version: str,
        config_version: str,
        failure_modes: FailureModes,
        upload_rewrite: str | None = None,
    ) -> None:
        for label, p in (("CA", ca_file), ("cert", cert_file), ("key", key_file), ("fixture", fixture_path)):
            if not p.exists():
                raise SystemExit(f"{label} file not found: {p}")

        self.device_id = device_id
        self.broker_host = broker_host
        self.broker_port = broker_port
        self.ca_file = ca_file
        self.cert_file = cert_file
        self.key_file = key_file
        self.api_base = api_base.rstrip("/")
        self.fixture_path = fixture_path
        self.fixture_bytes = fixture_path.read_bytes()
        self.fixture_sha256 = hashlib.sha256(self.fixture_bytes).hexdigest()
        self.fixture_size = len(self.fixture_bytes)
        self.fw_version = fw_version
        self.config_version = config_version
        self.failure_modes = failure_modes
        self.upload_rewrite = upload_rewrite
        self.started_at = time.time()
        self.noise = _NoiseModel()

        self._loop: asyncio.AbstractEventLoop | None = None
        self._stop_event: asyncio.Event | None = None
        self._last_auto_event_at = 0.0
        self._event_in_flight = False
        self._http: httpx.AsyncClient | None = None

        self._mqtt = mqtt.Client(
            callback_api_version=CallbackAPIVersion.VERSION2,
            client_id=f"sim-{device_id}",
            clean_session=True,
            protocol=mqtt.MQTTv311,
        )
        self._mqtt.tls_set(
            ca_certs=str(ca_file),
            certfile=str(cert_file),
            keyfile=str(key_file),
            cert_reqs=ssl.CERT_REQUIRED,
            tls_version=ssl.PROTOCOL_TLSv1_2,
        )
        self._mqtt.on_connect = self._on_connect
        self._mqtt.on_disconnect = self._on_disconnect
        self._mqtt.on_publish = self._on_publish

        # PUBACK tracking for ACL-denied publishes. paho doesn't surface ACL
        # rejections in the on_publish callback directly (the broker just
        # disconnects on Mosquitto 2.x for non-allowed topics), so we keep
        # a small ledger and let the test mode print the outcome.
        self._published_mids: dict[int, str] = {}

    # --- paho callbacks (run on MQTT thread) ------------------------------

    def _on_connect(self, _c, _u, _f, reason_code, _p=None) -> None:
        if getattr(reason_code, "is_failure", False):
            log.error("mqtt connect failed: %s", reason_code)
            return
        log.info("mqtt connected (device=%s broker=%s:%s)",
                 self.device_id, self.broker_host, self.broker_port)

    def _on_disconnect(self, _c, _u, _f, reason_code, _p=None) -> None:
        log.warning("mqtt disconnected: reason=%s", reason_code)

    def _on_publish(self, _c, _u, mid, _reason=None, _p=None) -> None:
        topic = self._published_mids.pop(mid, None)
        if topic is not None:
            log.debug("publish ack mid=%s topic=%s", mid, topic)

    # --- publish helpers --------------------------------------------------

    def _publish(self, topic: str, payload: str, qos: int) -> None:
        info = self._mqtt.publish(topic, payload, qos=qos)
        if qos > 0:
            self._published_mids[info.mid] = topic
            # We don't wait_for_publish on the hot path — telemetry would
            # block the event loop. Event-flow publishes use _publish_blocking.

    def _publish_blocking(self, topic: str, payload: str, qos: int, timeout: float = 5.0) -> bool:
        info = self._mqtt.publish(topic, payload, qos=qos)
        try:
            info.wait_for_publish(timeout=timeout)
        except RuntimeError:
            log.warning("publish to %s did not ack within %.1fs", topic, timeout)
            return False
        return info.rc == mqtt.MQTT_ERR_SUCCESS

    # --- async tasks ------------------------------------------------------

    async def _telemetry_loop(self) -> None:
        assert self._stop_event is not None
        period = 1.0 / TELEMETRY_HZ
        bad_payload_used = False
        while not self._stop_event.is_set():
            now = time.time()
            laeq, lafmax, lcpeak, spike = self.noise.sample(now)

            if self.failure_modes.bad_payload and not bad_payload_used:
                # Out-of-range LAeq must round-trip and surface as a
                # validation error in the ingest worker logs.
                payload = json.dumps({"ts": now, "laeq": 999.9, "lafmax": lafmax, "lcpeak": lcpeak})
                log.info("→ telemetry (bad payload, expect ingest validation error)")
                self._publish(telemetry_topic(self.device_id), payload, qos=0)
                bad_payload_used = True
            else:
                t = Telemetry(ts=now, laeq=laeq, lafmax=lafmax, lcpeak=lcpeak)
                self._publish(telemetry_topic(self.device_id), t.model_dump_json(), qos=0)

            # Threshold spike → optional auto event (only if not in --once mode,
            # not already running an event, and respecting cooldown).
            if (
                spike
                and not self._event_in_flight
                and (now - self._last_auto_event_at) > EVENT_COOLDOWN_S
            ):
                self._last_auto_event_at = now
                asyncio.create_task(self._run_event_flow(reason=f"spike laeq={laeq:.1f}"))

            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=period)
            except asyncio.TimeoutError:
                continue

    async def _health_loop(self) -> None:
        assert self._stop_event is not None
        # Emit the first one promptly so the device's row picks up a
        # `last_seen` without waiting a minute.
        first = True
        while not self._stop_event.is_set():
            now = time.time()
            h = Health(
                ts=now,
                uptime_s=now - self.started_at,
                cpu_pct=random.uniform(4.0, 18.0),
                cpu_temp_c=random.uniform(38.0, 55.0),
                mem_used_mb=random.uniform(110.0, 180.0),
                disk_free_mb=random.uniform(1024.0, 4096.0),
                wifi_rssi_dbm=random.uniform(-72.0, -45.0),
                queue_depth=random.randint(0, 3),
                queue_bytes=random.randint(0, 4096),
                mic_gain_db=0.0,
                ntp_offset_ms=random.uniform(-12.0, 12.0),
                fw_version=self.fw_version,
                config_version=self.config_version,
            )
            self._publish(health_topic(self.device_id), h.model_dump_json(), qos=1)
            log.info("→ health uptime=%.0fs queue_depth=%d", h.uptime_s, h.queue_depth)

            wait = 2.0 if first else HEALTH_PERIOD_S
            first = False
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=wait)
            except asyncio.TimeoutError:
                continue

    async def _event_scheduler(self, interval_s: float) -> None:
        assert self._stop_event is not None
        if interval_s <= 0:
            return
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=interval_s)
            except asyncio.TimeoutError:
                if not self._event_in_flight:
                    asyncio.create_task(self._run_event_flow(reason="scheduled"))

    # --- event flow -------------------------------------------------------

    async def _run_event_flow(self, *, reason: str) -> None:
        if self._event_in_flight:
            return
        self._event_in_flight = True
        event_id = uuid4()
        announce_ts = time.time()
        try:
            log.info("event %s: starting (%s)", event_id, reason)
            ann = EventAnnounce(
                event_id=event_id,
                ts=announce_ts,
                duration_s=15.0,
                peak_db=92.5,
                sha256=self.fixture_sha256,
                size=self.fixture_size,
                content_type="audio/flac",
            )
            ann_json = ann.model_dump_json()
            topic = event_announce_topic(self.device_id)
            ok = self._publish_blocking(topic, ann_json, qos=1)
            if not ok:
                log.warning("event %s: announce publish not acked — broker may have rejected it", event_id)
                return
            log.info("event %s: announce sent", event_id)

            if self.failure_modes.dup_announce:
                self._publish_blocking(topic, ann_json, qos=1)
                log.info("event %s: duplicate announce sent (idempotency check)", event_id)

            intent = await self._request_intent(event_id, announce_ts)
            if intent is None:
                log.error("event %s: intent request failed — aborting flow", event_id)
                return
            log.info("event %s: intent ok (storage_key=%s)", event_id, intent.storage_key)

            uploaded = await self._put_fixture(intent)
            if not uploaded:
                log.error("event %s: PUT to presigned URL failed", event_id)
                return
            uploaded_at = time.time()
            log.info("event %s: uploaded %d bytes", event_id, self.fixture_size)

            done = EventDone(
                event_id=event_id,
                storage_key=intent.storage_key,
                sha256=self.fixture_sha256,
                size=self.fixture_size,
                uploaded_at=uploaded_at,
            )
            done_json = done.model_dump_json()
            done_topic = event_done_topic(self.device_id)
            self._publish_blocking(done_topic, done_json, qos=1)
            log.info("event %s: done sent", event_id)

            if self.failure_modes.dup_done:
                self._publish_blocking(done_topic, done_json, qos=1)
                log.info("event %s: duplicate done sent (idempotency check)", event_id)

            if self.failure_modes.wrong_topic_device is not None:
                wrong = event_announce_topic(self.failure_modes.wrong_topic_device)
                # Use a fresh event_id so it wouldn't collide if it *did* land.
                bogus = ann.model_copy(update={"event_id": uuid4()}).model_dump_json()
                # QoS 1 so we can observe the broker's rejection. Mosquitto 2.x
                # disconnects on an ACL-denied publish; paho will reconnect.
                ok = self._publish_blocking(wrong, bogus, qos=1, timeout=3.0)
                log.info(
                    "event %s: wrong-topic publish to %s → ack=%s (expected denial / disconnect)",
                    event_id, wrong, ok,
                )
        finally:
            self._event_in_flight = False

    async def _request_intent(self, event_id: UUID, ts: float) -> EventIntentResponse | None:
        assert self._http is not None
        body = EventIntentRequest(
            event_id=event_id,
            ts=ts,
            duration_s=15.0,
            peak_db=92.5,
            sha256=self.fixture_sha256,
            size=self.fixture_size,
            content_type="audio/flac",
            nonce=secrets.token_hex(8),
        )
        try:
            resp = await self._http.post(
                f"{self.api_base}/api/v1/events/intent",
                json=json.loads(body.model_dump_json()),
                headers={"X-Device-Id": str(self.device_id)},
                timeout=10.0,
            )
        except httpx.HTTPError as exc:
            log.warning("intent http error: %s", exc)
            return None
        if resp.status_code != 200:
            log.warning("intent rejected: status=%s body=%s", resp.status_code, resp.text)
            return None
        return EventIntentResponse.model_validate(resp.json())

    async def _put_fixture(self, intent: EventIntentResponse) -> bool:
        assert self._http is not None
        url = self._maybe_rewrite_upload_url(intent.upload_url)
        try:
            resp = await self._http.put(
                url,
                content=self.fixture_bytes,
                headers=intent.required_headers,
                timeout=15.0,
            )
        except httpx.HTTPError as exc:
            log.warning("upload http error: %s", exc)
            return False
        if resp.status_code not in (200, 201, 204):
            log.warning("upload rejected: status=%s body=%s", resp.status_code, resp.text[:200])
            return False
        return True

    def _maybe_rewrite_upload_url(self, url: str) -> str:
        """Optional scheme+host swap on the presigned PUT URL.

        The backend signs URLs against the internal MinIO endpoint and host-
        swaps them to the public Traefik hostname so a real device on the
        internet can reach them. SigV4 puts ``Host`` in the signed header
        list, but MinIO accepts a different ``Host`` as long as the path and
        query (where the signature lives) are unchanged — so we can swap
        right back when the simulator runs inside the cluster network.
        """
        if not self.upload_rewrite:
            return url
        target = urlparse(self.upload_rewrite)
        if not target.scheme or not target.netloc:
            log.warning("ignoring invalid --upload-rewrite=%r", self.upload_rewrite)
            return url
        parsed = urlparse(url)
        return urlunparse(parsed._replace(scheme=target.scheme, netloc=target.netloc))

    # --- lifecycle --------------------------------------------------------

    async def run(self, *, once: bool, duration_s: float, event_interval_s: float) -> int:
        self._loop = asyncio.get_running_loop()
        self._stop_event = asyncio.Event()

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                self._loop.add_signal_handler(sig, self._stop_event.set)
            except NotImplementedError:
                signal.signal(sig, lambda *_: self._stop_event.set())  # type: ignore[union-attr]

        self._mqtt.connect(self.broker_host, self.broker_port, keepalive=30)
        self._mqtt.loop_start()
        # Give paho a beat to finish the TLS handshake before we start firing.
        await asyncio.sleep(0.5)

        self._http = httpx.AsyncClient(verify=False)
        try:
            tasks = [
                asyncio.create_task(self._telemetry_loop(), name="telemetry"),
                asyncio.create_task(self._health_loop(), name="health"),
            ]
            if once:
                # Run the event flow once, then stop. Telemetry/health stay
                # alive until the flow completes so the device looks live.
                event_task = asyncio.create_task(self._run_event_flow(reason="--once"))
                # Wait for the event flow + a short tail so health/telemetry
                # have a chance to land in the DB.
                await event_task
                await asyncio.sleep(2.0)
                self._stop_event.set()
            else:
                tasks.append(
                    asyncio.create_task(
                        self._event_scheduler(event_interval_s), name="events"
                    )
                )
                if duration_s > 0:
                    asyncio.create_task(self._auto_stop(duration_s))
                await self._stop_event.wait()

            for t in tasks:
                t.cancel()
            for t in tasks:
                try:
                    await t
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
        finally:
            await self._http.aclose()
            self._mqtt.loop_stop()
            try:
                self._mqtt.disconnect()
            except Exception:  # noqa: BLE001
                pass
        return 0

    async def _auto_stop(self, after_s: float) -> None:
        assert self._stop_event is not None
        try:
            await asyncio.wait_for(self._stop_event.wait(), timeout=after_s)
        except asyncio.TimeoutError:
            log.info("duration %.0fs reached — shutting down", after_s)
            self._stop_event.set()


# --- CLI -------------------------------------------------------------------


def _default_path(env: str, fallback: pathlib.Path) -> pathlib.Path:
    val = os.environ.get(env)
    return pathlib.Path(val) if val else fallback


def _resolve_cert_paths(device_id: UUID, args: argparse.Namespace) -> tuple[pathlib.Path, pathlib.Path, pathlib.Path]:
    # In the compose container the cert tree lives at /app/certs. From the
    # repo root it lives at backend/certs. Either works as long as --ca/
    # --cert/--key are consistent.
    in_container = pathlib.Path("/app/certs").is_dir()
    default_root = pathlib.Path("/app/certs") if in_container else pathlib.Path("backend/certs")

    ca = args.ca or _default_path("MQTT_CA_FILE", default_root / "root-ca.crt")
    cert = args.cert or _default_path(
        "MQTT_CLIENT_CERT", default_root / "devices" / f"{device_id}.crt"
    )
    key = args.key or _default_path(
        "MQTT_CLIENT_KEY", default_root / "devices" / f"{device_id}.key"
    )
    return pathlib.Path(ca), pathlib.Path(cert), pathlib.Path(key)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Urban Acoustics device simulator (Phase 1)")
    p.add_argument("--device-id", required=True, type=UUID)
    p.add_argument("--broker-host", default=os.environ.get("MQTT_BROKER_HOST", "mosquitto"))
    p.add_argument("--broker-port", default=int(os.environ.get("MQTT_BROKER_PORT", "8883")), type=int)
    p.add_argument("--ca", type=pathlib.Path, default=None, help="Root CA PEM")
    p.add_argument("--cert", type=pathlib.Path, default=None, help="Device client cert PEM")
    p.add_argument("--key", type=pathlib.Path, default=None, help="Device private key PEM")
    p.add_argument(
        "--api-base",
        default=os.environ.get("API_BASE", "http://backend:8000"),
        help="Backend API base URL (events/intent etc.)",
    )
    p.add_argument(
        "--fixture",
        type=pathlib.Path,
        default=_default_path(
            "EVENT_FIXTURE",
            pathlib.Path("/app/tests/fixtures/event_audio/silence.flac")
            if pathlib.Path("/app/tests").is_dir()
            else pathlib.Path("backend/tests/fixtures/event_audio/silence.flac"),
        ),
        help="Path to an audio fixture uploaded for each simulated event",
    )
    p.add_argument("--fw-version", default="0.1.0+sim")
    p.add_argument("--config-version", default="dev-1")
    p.add_argument("--once", action="store_true",
                   help="Emit one full event cycle (announce → intent → PUT → done) and exit")
    p.add_argument("--event-interval", default=120, type=int,
                   help="Seconds between scheduled events (0 disables; spikes still trigger)")
    p.add_argument("--duration", default=0, type=int,
                   help="Stop after N seconds (0 = run until SIGINT)")

    p.add_argument("--bad-payload", action="store_true",
                   help="Publish one telemetry message that violates the contract")
    p.add_argument("--dup-announce", action="store_true",
                   help="Send event/announce twice for the next event")
    p.add_argument("--dup-done", action="store_true",
                   help="Send event/done twice for the next event")
    p.add_argument("--wrong-topic", type=UUID, default=None,
                   help="UUID of another device — publish to its topic to trigger ACL denial")
    p.add_argument(
        "--upload-rewrite",
        default=os.environ.get("UPLOAD_REWRITE"),
        help=(
            "Optional scheme://host[:port] to rewrite the presigned PUT URL "
            "host before upload. Use http://minio:9000 when running inside the "
            "compose network to bypass the public Traefik path."
        ),
    )

    p.add_argument("--log-level", default=os.environ.get("LOG_LEVEL", "INFO"))
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    ca, cert, key = _resolve_cert_paths(args.device_id, args)
    sim = DeviceSim(
        device_id=args.device_id,
        broker_host=args.broker_host,
        broker_port=args.broker_port,
        ca_file=ca,
        cert_file=cert,
        key_file=key,
        api_base=args.api_base,
        fixture_path=args.fixture,
        fw_version=args.fw_version,
        config_version=args.config_version,
        failure_modes=FailureModes(
            bad_payload=args.bad_payload,
            dup_announce=args.dup_announce,
            dup_done=args.dup_done,
            wrong_topic_device=args.wrong_topic,
        ),
        upload_rewrite=args.upload_rewrite,
    )
    try:
        return asyncio.run(
            sim.run(
                once=args.once,
                duration_s=float(args.duration),
                event_interval_s=float(args.event_interval),
            )
        )
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())

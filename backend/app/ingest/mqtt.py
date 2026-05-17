"""MQTT ingest worker.

Subscribes to Phase 1 device topics, validates payloads against
``app.contracts``, batches writes into Timescale/Postgres, and emits
Postgres ``NOTIFY`` events so the FastAPI WebSocket layer can fan out live
updates without polling.

Threading model
---------------
paho-mqtt runs its own network thread (``loop_start``). Its callbacks must
not block on database I/O — slow writes would back the broker's inflight
queue up and trigger spurious disconnects. So callbacks only do:

  1. cheap topic parse + ``json.loads``
  2. ``loop.call_soon_threadsafe(queue.put_nowait, ...)``

All validation and SQL work happens in the asyncio consumer task running
on the main event loop. If the queue is full we drop the message and log
— backpressure must be visible (per task 04 risks).

Batching policy
---------------
- Telemetry (1 Hz/device, QoS 0): batched, flushed every
  ``TELEMETRY_FLUSH_SECONDS`` or when the buffer reaches
  ``TELEMETRY_BATCH_MAX``.
- Health (1/min/device, QoS 1): batched the same way but with a smaller
  threshold — at fleet sizes we care about, health writes are cheap.
- Event announce/done (QoS 1): handled one-at-a-time so we get
  per-message idempotency semantics.
- LWT: best-effort ``last_seen`` mark; broker-retained so we receive it
  at subscription time too.

Reconnects
----------
paho's built-in ``reconnect_delay_set`` handles exponential backoff for
us — we just log connect/disconnect events and re-subscribe in
``on_connect`` (re-subscribing is necessary because clean_session=False
isn't enough on QoS 0 subscriptions surviving a paho reconnect).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import ssl
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse
from uuid import UUID

import paho.mqtt.client as mqtt
from paho.mqtt.enums import CallbackAPIVersion
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from ..contracts import (
    NOTIFY_SPECTROGRAM_CHANNEL,
    EventAnnounce,
    EventDone,
    EventStatus,
    Health,
    LastWill,
    Spectrogram,
    Telemetry,
    is_valid_event_transition,
)
from ..models import Device, DeviceHealth, Event, SpectrogramFrame
from ..models import Telemetry as TelemetryRow


log = logging.getLogger("urban-acoustics.ingest")


# --- Tunables ---------------------------------------------------------------

TELEMETRY_FLUSH_SECONDS = 1.0
TELEMETRY_BATCH_MAX = 500
# Spectrogram persistence — batched at the same cadence as telemetry. The
# live fan-out still happens per-frame via pg_notify; this is the
# historical-ribbon write path. At ~10 Hz a flush every 1 s carries ~10
# frames; on multi-device fleets the batch will be larger but is bounded
# below.
SPECT_BATCH_MAX = 1000
HEALTH_FLUSH_SECONDS = 2.0
HEALTH_BATCH_MAX = 100
LAST_SEEN_FLUSH_SECONDS = 5.0
INGEST_QUEUE_MAX = 10_000
NOTIFY_CHANNEL = "urban_acoustics"

# Reconnect backoff bounds (seconds). paho's default is 1..120; we want a
# tighter ceiling so a Mosquitto restart re-attaches within ~30 s.
_RECONNECT_MIN = 1
_RECONNECT_MAX = 30


# --- Message envelope -------------------------------------------------------


@dataclass
class _RawMessage:
    """Cheap shape produced on the paho thread, consumed on the asyncio loop."""

    kind: str  # "tlm" | "spect" | "health" | "event_announce" | "event_done" | "lwt"
    device_id: UUID
    topic: str
    payload: dict[str, Any]
    received_at: datetime


def _parse_topic(topic: str) -> tuple[str, UUID] | None:
    """Return ``(kind, device_id)`` or ``None`` if the topic is unrecognized.

    The device_id always comes from the topic — payload device_id (if any)
    is checked for *consistency* but never used as the source of truth.
    """
    parts = topic.split("/")
    if len(parts) < 3 or parts[0] != "dev":
        return None
    try:
        device_id = UUID(parts[1])
    except (ValueError, AttributeError):
        return None

    if len(parts) == 3:
        tail = parts[2]
        if tail == "tlm":
            return ("tlm", device_id)
        if tail == "spect":
            return ("spect", device_id)
        if tail == "health":
            return ("health", device_id)
        if tail == "lwt":
            return ("lwt", device_id)
        return None
    if len(parts) == 4 and parts[2] == "event":
        if parts[3] == "announce":
            return ("event_announce", device_id)
        if parts[3] == "done":
            return ("event_done", device_id)
        return None
    return None


# --- Worker -----------------------------------------------------------------


class IngestWorker:
    def __init__(
        self,
        *,
        database_url: str | None = None,
        broker_url: str | None = None,
        ca_file: str | None = None,
        client_cert: str | None = None,
        client_key: str | None = None,
        client_id: str = "ingest",
    ) -> None:
        # Read env directly: the ingest worker doesn't need S3/JWT settings
        # the API needs, and bundling them through ``Settings`` would force
        # the compose ingest service to carry env it never uses.
        self._database_url = database_url or os.environ.get("DATABASE_URL")
        self._broker_url = broker_url or os.environ.get("MQTT_BROKER_URL")
        self._ca_file = ca_file or os.environ.get("MQTT_CA_FILE")
        self._client_cert = client_cert or os.environ.get("MQTT_CLIENT_CERT")
        self._client_key = client_key or os.environ.get("MQTT_CLIENT_KEY")
        if not self._database_url:
            raise RuntimeError("DATABASE_URL is required for the ingest worker")
        if not self._broker_url:
            raise RuntimeError("MQTT_BROKER_URL is required for the ingest worker")
        self._client_id = client_id

        # State -------------------------------------------------------------
        self._engine = create_async_engine(self._database_url, pool_pre_ping=True, future=True)
        self._session_factory: async_sessionmaker[AsyncSession] = async_sessionmaker(
            self._engine, expire_on_commit=False, class_=AsyncSession
        )
        self._known_devices: set[UUID] = set()
        self._last_seen_dirty: dict[UUID, datetime] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue: asyncio.Queue[_RawMessage] | None = None
        self._stop_event: asyncio.Event | None = None
        self._dropped_messages = 0

        # Counters used in heartbeat logs.
        self._counts = {
            "tlm": 0,
            "spect": 0,
            "spect_dropped": 0,
            "health": 0,
            "event_announce": 0,
            "event_done": 0,
            "lwt": 0,
            "validation_errors": 0,
            "unknown_device": 0,
        }

        # MQTT client (created here, configured in ``_setup_mqtt``).
        self._mqtt = mqtt.Client(
            callback_api_version=CallbackAPIVersion.VERSION2,
            client_id=self._client_id,
            clean_session=False,
            protocol=mqtt.MQTTv311,
        )
        self._setup_mqtt()

    # --- MQTT setup ----------------------------------------------------

    def _setup_mqtt(self) -> None:
        parsed = urlparse(self._broker_url)
        if parsed.scheme not in ("mqtts", "mqtt"):
            raise RuntimeError(f"MQTT_BROKER_URL scheme must be mqtts:// or mqtt://: {self._broker_url}")
        if parsed.scheme == "mqtts":
            if not (self._ca_file and self._client_cert and self._client_key):
                raise RuntimeError(
                    "mqtts:// requires MQTT_CA_FILE, MQTT_CLIENT_CERT, MQTT_CLIENT_KEY"
                )
            self._mqtt.tls_set(
                ca_certs=self._ca_file,
                certfile=self._client_cert,
                keyfile=self._client_key,
                cert_reqs=ssl.CERT_REQUIRED,
                tls_version=ssl.PROTOCOL_TLSv1_2,
            )

        self._mqtt.reconnect_delay_set(min_delay=_RECONNECT_MIN, max_delay=_RECONNECT_MAX)
        self._mqtt.on_connect = self._on_connect
        self._mqtt.on_disconnect = self._on_disconnect
        self._mqtt.on_message = self._on_message

    # --- paho callbacks (run on MQTT thread) ---------------------------

    def _on_connect(self, _client, _userdata, _flags, reason_code, _properties=None) -> None:
        if getattr(reason_code, "is_failure", False):
            log.error("mqtt connect failed: %s", reason_code)
            return
        log.info("mqtt connected to %s", self._broker_url)
        # QoS per Phase 1 contract:
        #  tlm        QoS 0  (1 Hz firehose, drops are tolerable)
        #  health     QoS 1
        #  event/*    QoS 1
        #  lwt        QoS 1 (retained)
        subs = [
            ("dev/+/tlm", 0),
            # Spectrogram bands are ephemeral live data — same QoS as tlm.
            ("dev/+/spect", 0),
            ("dev/+/health", 1),
            ("dev/+/event/announce", 1),
            ("dev/+/event/done", 1),
            ("dev/+/lwt", 1),
        ]
        result, _mid = self._mqtt.subscribe(subs)
        if result != mqtt.MQTT_ERR_SUCCESS:
            log.error("mqtt subscribe failed: %s", mqtt.error_string(result))

    def _on_disconnect(self, _client, _userdata, _flags, reason_code, _properties=None) -> None:
        # paho will auto-reconnect; this is informational only.
        log.warning("mqtt disconnected: reason=%s — paho will reconnect", reason_code)

    def _on_message(self, _client, _userdata, msg: mqtt.MQTTMessage) -> None:
        parsed = _parse_topic(msg.topic)
        if parsed is None:
            log.warning("ingest: unknown topic shape, dropping: %r", msg.topic)
            return
        kind, device_id = parsed

        try:
            payload = json.loads(msg.payload)
        except (json.JSONDecodeError, UnicodeDecodeError):
            log.warning(
                "ingest: malformed JSON on topic=%s device=%s len=%d",
                msg.topic,
                device_id,
                len(msg.payload),
            )
            return
        if not isinstance(payload, dict):
            log.warning("ingest: non-object JSON on topic=%s device=%s", msg.topic, device_id)
            return

        # Contract: reject payloads whose embedded device_id disagrees with the
        # topic. Schemas use extra="ignore", so we have to check the raw dict
        # before pydantic strips it.
        embedded = payload.get("device_id")
        if embedded is not None and str(embedded) != str(device_id):
            log.warning(
                "ingest: device_id mismatch: topic=%s payload=%s — dropping",
                device_id,
                embedded,
            )
            return

        item = _RawMessage(
            kind=kind,
            device_id=device_id,
            topic=msg.topic,
            payload=payload,
            received_at=datetime.now(timezone.utc),
        )

        loop = self._loop
        queue = self._queue
        if loop is None or queue is None:
            # Shutting down or not yet started — drop quietly.
            return
        try:
            loop.call_soon_threadsafe(self._enqueue_or_drop, item)
        except RuntimeError:
            # event loop is closing; nothing we can do.
            pass

    def _enqueue_or_drop(self, item: _RawMessage) -> None:
        # Runs on asyncio thread.
        assert self._queue is not None
        try:
            self._queue.put_nowait(item)
        except asyncio.QueueFull:
            self._dropped_messages += 1
            # Log at most ~once per 100 drops so we don't spin the disk.
            if self._dropped_messages % 100 == 1:
                log.error(
                    "ingest: queue full, dropped %d messages (latest kind=%s device=%s)",
                    self._dropped_messages,
                    item.kind,
                    item.device_id,
                )

    # --- asyncio entrypoint --------------------------------------------

    async def run(self) -> int:
        self._loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue(maxsize=INGEST_QUEUE_MAX)
        self._stop_event = asyncio.Event()

        await self._prime_known_devices()

        # Install signal handlers on the event loop so shutdown is cooperative.
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                self._loop.add_signal_handler(sig, self._request_shutdown)
            except NotImplementedError:
                # Windows / non-main-thread fallback — should not hit here.
                signal.signal(sig, lambda *_: self._request_shutdown())

        parsed = urlparse(self._broker_url)
        host = parsed.hostname or "localhost"
        port = parsed.port or (8883 if parsed.scheme == "mqtts" else 1883)
        log.info("ingest: connecting to mqtt host=%s port=%s tls=%s", host, port, parsed.scheme == "mqtts")
        try:
            self._mqtt.connect_async(host, port, keepalive=30)
        except Exception:  # noqa: BLE001 — log and retry via paho's reconnect
            log.exception("ingest: initial mqtt connect_async raised; paho will retry")
        self._mqtt.loop_start()

        consumer = asyncio.create_task(self._consume(), name="ingest-consumer")
        heartbeat = asyncio.create_task(self._heartbeat(), name="ingest-heartbeat")

        try:
            await self._stop_event.wait()
        finally:
            log.info("ingest: shutting down")
            consumer.cancel()
            heartbeat.cancel()
            for t in (consumer, heartbeat):
                try:
                    await t
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
            self._mqtt.loop_stop()
            try:
                self._mqtt.disconnect()
            except Exception:  # noqa: BLE001
                pass
            await self._engine.dispose()

        return 0

    def _request_shutdown(self) -> None:
        if self._stop_event is not None and not self._stop_event.is_set():
            self._stop_event.set()

    # --- consumer loop -------------------------------------------------

    async def _consume(self) -> None:
        assert self._queue is not None
        tlm_buf: list[_RawMessage] = []
        health_buf: list[_RawMessage] = []
        # Per-frame validated payloads queued for batched persistence. The
        # live-notify path inside ``_handle_spect`` is per-frame; this
        # buffer only feeds the history table.
        spect_buf: list[tuple[UUID, Spectrogram]] = []
        next_flush = time.monotonic() + TELEMETRY_FLUSH_SECONDS

        while True:
            timeout = max(0.0, next_flush - time.monotonic())
            try:
                item = await asyncio.wait_for(self._queue.get(), timeout=timeout)
            except asyncio.TimeoutError:
                item = None

            if item is not None:
                self._counts[item.kind] = self._counts.get(item.kind, 0) + 1
                if item.kind == "tlm":
                    tlm_buf.append(item)
                    if len(tlm_buf) >= TELEMETRY_BATCH_MAX:
                        await self._flush_tlm(tlm_buf)
                        tlm_buf = []
                elif item.kind == "spect":
                    # Live notify runs per-frame so the scrolling
                    # spectrogram stays at ~10 Hz; the validated payload
                    # is queued for batched persistence on the flush sweep.
                    spec = await self._handle_spect(item)
                    if spec is not None:
                        spect_buf.append((item.device_id, spec))
                        if len(spect_buf) >= SPECT_BATCH_MAX:
                            await self._flush_spect(spect_buf)
                            spect_buf = []
                elif item.kind == "health":
                    health_buf.append(item)
                    if len(health_buf) >= HEALTH_BATCH_MAX:
                        await self._flush_health(health_buf)
                        health_buf = []
                elif item.kind == "event_announce":
                    await self._handle_event_announce(item)
                elif item.kind == "event_done":
                    await self._handle_event_done(item)
                elif item.kind == "lwt":
                    await self._handle_lwt(item)

            now = time.monotonic()
            if now >= next_flush:
                if tlm_buf:
                    await self._flush_tlm(tlm_buf)
                    tlm_buf = []
                if spect_buf:
                    await self._flush_spect(spect_buf)
                    spect_buf = []
                if health_buf:
                    await self._flush_health(health_buf)
                    health_buf = []
                await self._flush_last_seen()
                next_flush = now + TELEMETRY_FLUSH_SECONDS

    async def _heartbeat(self) -> None:
        # Periodic visibility — also surfaces backpressure (queue depth, drops).
        while True:
            await asyncio.sleep(60)
            qsize = self._queue.qsize() if self._queue is not None else -1
            log.info(
                "ingest: heartbeat counts=%s queue_depth=%d dropped=%d known_devices=%d",
                self._counts,
                qsize,
                self._dropped_messages,
                len(self._known_devices),
            )

    # --- device cache --------------------------------------------------

    async def _prime_known_devices(self) -> None:
        try:
            async with self._session_factory() as session:
                rows = await session.execute(select(Device.device_id))
                self._known_devices = {r[0] for r in rows.all()}
        except SQLAlchemyError:
            log.exception("ingest: failed to prime device cache; will keep empty set")
            self._known_devices = set()
        log.info("ingest: loaded %d known devices", len(self._known_devices))

    async def _ensure_device_known(self, session: AsyncSession, device_id: UUID) -> bool:
        if device_id in self._known_devices:
            return True
        # The broker only allowed this client because its cert was valid; if
        # the device row is missing it usually means provisioning is incomplete.
        # Re-check the DB before giving up so a freshly-registered device
        # doesn't have to wait for a worker restart.
        row = await session.get(Device, device_id)
        if row is None:
            self._counts["unknown_device"] = self._counts.get("unknown_device", 0) + 1
            return False
        self._known_devices.add(device_id)
        return True

    # --- telemetry -----------------------------------------------------

    async def _flush_tlm(self, items: list[_RawMessage]) -> None:
        if not items:
            return
        rows: list[dict[str, Any]] = []
        touched: set[UUID] = set()
        for it in items:
            try:
                t = Telemetry.model_validate(it.payload)
            except ValidationError as e:
                self._counts["validation_errors"] = self._counts.get("validation_errors", 0) + 1
                log.warning(
                    "ingest: invalid telemetry device=%s errors=%s",
                    it.device_id,
                    _summarize_errors(e),
                )
                continue
            rows.append(
                {
                    "ts": datetime.fromtimestamp(t.ts, tz=timezone.utc),
                    "device_id": it.device_id,
                    "laeq": t.laeq,
                    "lafmax": t.lafmax,
                    "lcpeak": t.lcpeak,
                }
            )
            touched.add(it.device_id)
            self._last_seen_dirty[it.device_id] = it.received_at

        if not rows:
            return

        async with self._session_factory() as session:
            # Skip rows for unknown devices instead of letting the FK explode
            # the entire batch.
            valid_rows: list[dict[str, Any]] = []
            for r in rows:
                if await self._ensure_device_known(session, r["device_id"]):
                    valid_rows.append(r)
                else:
                    log.warning("ingest: telemetry from unknown device=%s — skipping", r["device_id"])
            if not valid_rows:
                return

            stmt = pg_insert(TelemetryRow.__table__).values(valid_rows)
            # (device_id, ts) duplicates can come from a device that resends
            # after a brief reconnect — we'd rather drop the dupe than fail
            # the whole batch.
            stmt = stmt.on_conflict_do_nothing(constraint="pk_telemetry_db")
            try:
                await session.execute(stmt)
                await self._notify(
                    session,
                    {
                        "type": "telemetry",
                        "device_ids": [str(d) for d in sorted(touched, key=str)],
                        "rows": len(valid_rows),
                    },
                )
                await session.commit()
            except SQLAlchemyError:
                await session.rollback()
                log.exception("ingest: telemetry batch insert failed (count=%d)", len(valid_rows))

    # --- spectrogram ---------------------------------------------------

    async def _handle_spect(self, item: _RawMessage) -> Spectrogram | None:
        """Validate a band frame and fan it out via pg_notify.

        Returns the validated frame so the caller can buffer it for batched
        persistence (see ``_flush_spect``). The notify path remains
        per-frame so live WebSocket consumers see scrolling-spectrogram
        latency in tens of milliseconds.
        """
        try:
            spec = Spectrogram.model_validate(item.payload)
        except ValidationError as e:
            self._counts["validation_errors"] = self._counts.get("validation_errors", 0) + 1
            log.warning(
                "ingest: invalid spect device=%s errors=%s",
                item.device_id,
                _summarize_errors(e),
            )
            return None

        payload_json = json.dumps(
            {
                "device_id": str(item.device_id),
                "ts": spec.ts,
                "bands": spec.bands,
            },
            separators=(",", ":"),
        )
        try:
            async with self._session_factory() as session:
                await session.execute(
                    text("SELECT pg_notify(:chan, :payload)"),
                    {"chan": NOTIFY_SPECTROGRAM_CHANNEL, "payload": payload_json},
                )
                await session.commit()
        except SQLAlchemyError:
            # NOTIFY failures shouldn't crash the worker — count and move on.
            self._counts["spect_dropped"] = self._counts.get("spect_dropped", 0) + 1
            if self._counts["spect_dropped"] % 100 == 1:
                log.exception(
                    "ingest: pg_notify failed for spect device=%s (total dropped=%d)",
                    item.device_id,
                    self._counts["spect_dropped"],
                )
        return spec

    async def _flush_spect(self, items: list[tuple[UUID, Spectrogram]]) -> None:
        """Persist validated spect frames into ``spectrogram_frames``.

        Errors are swallowed (logged at most every 100 failures) so a DB
        hiccup doesn't take down the live notify path — these rows back the
        history ribbon, which is allowed to have gaps.
        """
        if not items:
            return
        rows: list[dict[str, Any]] = []
        for device_id, spec in items:
            rows.append(
                {
                    "ts": datetime.fromtimestamp(spec.ts, tz=timezone.utc),
                    "device_id": device_id,
                    "bands": list(spec.bands),
                }
            )
        async with self._session_factory() as session:
            valid_rows: list[dict[str, Any]] = []
            for r in rows:
                if await self._ensure_device_known(session, r["device_id"]):
                    valid_rows.append(r)
            if not valid_rows:
                return
            stmt = pg_insert(SpectrogramFrame.__table__).values(valid_rows)
            # Duplicate (device_id, ts) can arrive when a device reconnects
            # and replays its outbox. Last-write-wins is wrong (frames are
            # immutable), so drop the dupe.
            stmt = stmt.on_conflict_do_nothing(constraint="pk_spectrogram_frames")
            try:
                await session.execute(stmt)
                await session.commit()
            except SQLAlchemyError:
                await session.rollback()
                self._counts["spect_dropped"] = (
                    self._counts.get("spect_dropped", 0) + len(valid_rows)
                )
                if self._counts["spect_dropped"] % 100 < len(valid_rows):
                    log.exception(
                        "ingest: spect batch insert failed (count=%d)",
                        len(valid_rows),
                    )

    # --- health --------------------------------------------------------

    async def _flush_health(self, items: list[_RawMessage]) -> None:
        if not items:
            return
        rows: list[dict[str, Any]] = []
        for it in items:
            try:
                h = Health.model_validate(it.payload)
            except ValidationError as e:
                self._counts["validation_errors"] = self._counts.get("validation_errors", 0) + 1
                log.warning(
                    "ingest: invalid health device=%s errors=%s",
                    it.device_id,
                    _summarize_errors(e),
                )
                continue
            rows.append(
                {
                    "ts": datetime.fromtimestamp(h.ts, tz=timezone.utc),
                    "device_id": it.device_id,
                    "uptime_s": h.uptime_s,
                    "cpu_pct": h.cpu_pct,
                    "cpu_temp_c": h.cpu_temp_c,
                    "mem_used_mb": h.mem_used_mb,
                    "disk_free_mb": h.disk_free_mb,
                    "wifi_rssi_dbm": h.wifi_rssi_dbm,
                    "queue_depth": h.queue_depth,
                    "queue_bytes": h.queue_bytes,
                    "mic_gain_db": h.mic_gain_db,
                    "ntp_offset_ms": h.ntp_offset_ms,
                    "fw_version": h.fw_version,
                    "config_version": h.config_version,
                }
            )
            self._last_seen_dirty[it.device_id] = it.received_at

        if not rows:
            return

        async with self._session_factory() as session:
            valid_rows: list[dict[str, Any]] = []
            for r in rows:
                if await self._ensure_device_known(session, r["device_id"]):
                    valid_rows.append(r)
                else:
                    log.warning("ingest: health from unknown device=%s — skipping", r["device_id"])
            if not valid_rows:
                return

            stmt = pg_insert(DeviceHealth.__table__).values(valid_rows)
            stmt = stmt.on_conflict_do_nothing(constraint="pk_device_health")
            try:
                await session.execute(stmt)
                await session.commit()
            except SQLAlchemyError:
                await session.rollback()
                log.exception("ingest: health batch insert failed (count=%d)", len(valid_rows))

    # --- events --------------------------------------------------------

    async def _handle_event_announce(self, item: _RawMessage) -> None:
        try:
            ann = EventAnnounce.model_validate(item.payload)
        except ValidationError as e:
            self._counts["validation_errors"] = self._counts.get("validation_errors", 0) + 1
            log.warning(
                "ingest: invalid event/announce device=%s errors=%s",
                item.device_id,
                _summarize_errors(e),
            )
            return

        now = item.received_at
        async with self._session_factory() as session:
            if not await self._ensure_device_known(session, item.device_id):
                log.warning(
                    "ingest: event/announce from unknown device=%s event_id=%s",
                    item.device_id,
                    ann.event_id,
                )
                return

            existing = await session.get(Event, ann.event_id)
            if existing is not None:
                # Contract: announce is idempotent. Reject mismatched
                # (sha256, size) — the device shouldn't re-announce a
                # different file under the same event_id.
                if existing.sha256 != ann.sha256 or existing.size != ann.size:
                    log.warning(
                        "ingest: event/announce sha256/size mismatch event_id=%s — keeping original",
                        ann.event_id,
                    )
                self._last_seen_dirty[item.device_id] = now
                return

            row = Event(
                event_id=ann.event_id,
                device_id=item.device_id,
                ts=datetime.fromtimestamp(ann.ts, tz=timezone.utc),
                duration_s=ann.duration_s,
                peak_db=ann.peak_db,
                sha256=ann.sha256,
                size=ann.size,
                content_type=ann.content_type,
                storage_key=None,
                status=EventStatus.ANNOUNCED.value,
                created_at=now,
                updated_at=now,
            )
            session.add(row)
            try:
                await self._notify(
                    session,
                    {
                        "type": "event",
                        "event_id": str(ann.event_id),
                        "device_id": str(item.device_id),
                        "status": EventStatus.ANNOUNCED.value,
                    },
                )
                await session.commit()
            except IntegrityError:
                # Race: another publish landed first. Treated as idempotent.
                await session.rollback()
            except SQLAlchemyError:
                await session.rollback()
                log.exception("ingest: event/announce insert failed event_id=%s", ann.event_id)
                return

            self._last_seen_dirty[item.device_id] = now

    async def _handle_event_done(self, item: _RawMessage) -> None:
        try:
            done = EventDone.model_validate(item.payload)
        except ValidationError as e:
            self._counts["validation_errors"] = self._counts.get("validation_errors", 0) + 1
            log.warning(
                "ingest: invalid event/done device=%s errors=%s",
                item.device_id,
                _summarize_errors(e),
            )
            return

        now = item.received_at
        async with self._session_factory() as session:
            existing = await session.get(Event, done.event_id)
            if existing is None:
                log.warning(
                    "ingest: event/done with no prior announce device=%s event_id=%s",
                    item.device_id,
                    done.event_id,
                )
                return
            if existing.device_id != item.device_id:
                log.warning(
                    "ingest: event/done device mismatch event_id=%s topic_device=%s row_device=%s",
                    done.event_id,
                    item.device_id,
                    existing.device_id,
                )
                return

            current = EventStatus(existing.status)
            if current in (EventStatus.UPLOADED, EventStatus.AVAILABLE):
                # Idempotent: nothing to do.
                self._last_seen_dirty[item.device_id] = now
                return

            # Verify the (sha256, size) reported on done agrees with the
            # announce/intent row. Mismatch → failed, device may retry.
            if existing.sha256 != done.sha256 or existing.size != done.size:
                target = EventStatus.FAILED
            else:
                target = EventStatus.UPLOADED

            if not is_valid_event_transition(current, target):
                log.warning(
                    "ingest: event/done invalid transition event_id=%s from=%s to=%s",
                    done.event_id,
                    current.value,
                    target.value,
                )
                return

            existing.status = target.value
            existing.storage_key = done.storage_key
            existing.uploaded_at = datetime.fromtimestamp(done.uploaded_at, tz=timezone.utc)
            existing.updated_at = now
            try:
                await self._notify(
                    session,
                    {
                        "type": "event",
                        "event_id": str(done.event_id),
                        "device_id": str(item.device_id),
                        "status": target.value,
                    },
                )
                await session.commit()
            except SQLAlchemyError:
                await session.rollback()
                log.exception("ingest: event/done update failed event_id=%s", done.event_id)
                return

            self._last_seen_dirty[item.device_id] = now

    async def _handle_lwt(self, item: _RawMessage) -> None:
        # Phase 1 just logs disconnects; offline state is observable from a
        # stale ``devices.last_seen`` plus the retained LWT. We validate
        # so deformed messages don't fly silently.
        try:
            lw = LastWill.model_validate(item.payload)
        except ValidationError as e:
            self._counts["validation_errors"] = self._counts.get("validation_errors", 0) + 1
            log.warning(
                "ingest: invalid lwt device=%s errors=%s",
                item.device_id,
                _summarize_errors(e),
            )
            return
        if lw.device_id != item.device_id:
            log.warning(
                "ingest: lwt device_id mismatch topic=%s payload=%s",
                item.device_id,
                lw.device_id,
            )
            return
        log.info("ingest: device offline device=%s ts=%s", item.device_id, lw.ts)

    # --- liveness ------------------------------------------------------

    async def _flush_last_seen(self) -> None:
        if not self._last_seen_dirty:
            return
        # Snapshot and clear so callers that fire during the flush don't lose updates.
        pending = self._last_seen_dirty
        self._last_seen_dirty = {}
        async with self._session_factory() as session:
            try:
                # One UPDATE per device — small fleet sizes in Phase 1 make
                # the chattier path simpler than a CTE/VALUES join, and it
                # keeps last_seen monotonic per-device.
                for device_id, ts in pending.items():
                    await session.execute(
                        text("UPDATE devices SET last_seen = :ts WHERE device_id = :id AND (last_seen IS NULL OR last_seen < :ts)"),
                        {"ts": ts, "id": device_id},
                    )
                await session.commit()
            except SQLAlchemyError:
                await session.rollback()
                log.exception("ingest: last_seen update failed for %d devices", len(pending))
                # Re-merge: don't drop these updates entirely.
                for device_id, ts in pending.items():
                    prev = self._last_seen_dirty.get(device_id)
                    if prev is None or prev < ts:
                        self._last_seen_dirty[device_id] = ts

    # --- pg_notify -----------------------------------------------------

    async def _notify(self, session: AsyncSession, payload: dict[str, Any]) -> None:
        """Emit a pg_notify within the same txn so listeners and rows commit atomically."""
        await session.execute(
            text("SELECT pg_notify(:chan, :payload)"),
            {"chan": NOTIFY_CHANNEL, "payload": json.dumps(payload, separators=(",", ":"))},
        )


# --- helpers -----------------------------------------------------------------


def _summarize_errors(e: ValidationError) -> str:
    # Compact per-field summary: "ts:value_error,laeq:greater_than_equal"
    parts = []
    for err in e.errors()[:5]:
        loc = ".".join(str(x) for x in err.get("loc", ()))
        parts.append(f"{loc}:{err.get('type')}")
    return ",".join(parts)


# --- module entrypoint -------------------------------------------------------


def _configure_logging() -> None:
    level_name = os.environ.get("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, level_name, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def main() -> int:
    _configure_logging()
    worker = IngestWorker()
    try:
        return asyncio.run(worker.run())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())

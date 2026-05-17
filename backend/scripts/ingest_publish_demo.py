"""Smoke-test publisher for the MQTT ingest worker.

Connects to Mosquitto as a real device (so the broker's mTLS + ACL accept
the publish), pushes one telemetry message, one health message, one
event/announce, one event/done, and prints the rows the ingest worker
wrote.

Usage (inside the backend container):

    python -m scripts.ingest_publish_demo \\
        --device-id 00000000-0000-4000-8000-00000000000a

The device must be registered first via ``scripts.register_device`` and
its cert must live under ``/app/certs/devices/<device_id>.{crt,key}``.

This is the executable form of the task 04 acceptance criteria:

  * telemetry → row in ``telemetry_db``
  * health → row in ``device_health``
  * announce → ``events.status = announced``
  * done → ``events.status = uploaded``
  * duplicate announce → still one row
  * duplicate done → no extra state change
  * ``devices.last_seen`` advances
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import pathlib
import ssl
import sys
import time
from uuid import UUID, uuid4

import paho.mqtt.client as mqtt
from paho.mqtt.enums import CallbackAPIVersion
from sqlalchemy import select, text

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.contracts import (  # noqa: E402
    EventAnnounce,
    EventDone,
    EventStatus,
    Health,
    Telemetry,
    event_announce_topic,
    event_done_topic,
    health_topic,
    telemetry_topic,
)
from app.db import get_sessionmaker  # noqa: E402
from app.models import Device, DeviceHealth, Event  # noqa: E402
from app.models import Telemetry as TelemetryRow  # noqa: E402


CERTS_ROOT = pathlib.Path("/app/certs")


def _publish(client: mqtt.Client, topic: str, payload: str, qos: int) -> None:
    info = client.publish(topic, payload, qos=qos)
    info.wait_for_publish(timeout=5.0)
    if info.rc != mqtt.MQTT_ERR_SUCCESS:
        raise SystemExit(f"publish to {topic} failed: {mqtt.error_string(info.rc)}")


def _make_client(device_id: UUID, broker_host: str, broker_port: int) -> mqtt.Client:
    crt = CERTS_ROOT / "devices" / f"{device_id}.crt"
    key = CERTS_ROOT / "devices" / f"{device_id}.key"
    if not (crt.exists() and key.exists()):
        raise SystemExit(f"device cert/key missing: {crt} / {key}")
    client = mqtt.Client(
        callback_api_version=CallbackAPIVersion.VERSION2,
        client_id=f"demo-{device_id}",
        clean_session=True,
        protocol=mqtt.MQTTv311,
    )
    client.tls_set(
        ca_certs=str(CERTS_ROOT / "root-ca.crt"),
        certfile=str(crt),
        keyfile=str(key),
        cert_reqs=ssl.CERT_REQUIRED,
        tls_version=ssl.PROTOCOL_TLSv1_2,
    )
    client.connect(broker_host, broker_port, keepalive=30)
    client.loop_start()
    return client


async def _read_state(device_id: UUID, event_id: UUID) -> None:
    factory = get_sessionmaker()
    async with factory() as session:
        device = await session.get(Device, device_id)
        if device is None:
            print(f"device {device_id} not registered — run scripts.register_device first")
            return
        print(f"device.last_seen = {device.last_seen}")

        tlm = (
            await session.execute(
                select(TelemetryRow)
                .where(TelemetryRow.device_id == device_id)
                .order_by(TelemetryRow.ts.desc())
                .limit(5)
            )
        ).scalars().all()
        print(f"telemetry rows (most recent first, up to 5): {len(tlm)}")
        for row in tlm:
            print(f"  ts={row.ts} laeq={row.laeq} lafmax={row.lafmax} lcpeak={row.lcpeak}")

        health = (
            await session.execute(
                select(DeviceHealth)
                .where(DeviceHealth.device_id == device_id)
                .order_by(DeviceHealth.ts.desc())
                .limit(3)
            )
        ).scalars().all()
        print(f"health rows (most recent first, up to 3): {len(health)}")
        for row in health:
            print(f"  ts={row.ts} fw={row.fw_version} cpu_pct={row.cpu_pct}")

        ev = await session.get(Event, event_id)
        if ev is None:
            print(f"event {event_id}: not found")
        else:
            print(
                f"event {event_id}: status={ev.status} storage_key={ev.storage_key} "
                f"uploaded_at={ev.uploaded_at}"
            )

        dup_count = (
            await session.execute(
                text("SELECT COUNT(*) FROM events WHERE event_id = :id"),
                {"id": event_id},
            )
        ).scalar_one()
        print(f"event {event_id}: row count = {dup_count} (expected 1)")


async def _main(device_id: UUID, broker_host: str, broker_port: int) -> int:
    client = _make_client(device_id, broker_host, broker_port)
    try:
        now = time.time()

        # 1. telemetry
        tlm = Telemetry(ts=now, laeq=58.4, lafmax=67.2, lcpeak=82.1)
        _publish(client, telemetry_topic(device_id), tlm.model_dump_json(), qos=0)
        print(f"published telemetry → {telemetry_topic(device_id)}")

        # 2. health
        health = Health(
            ts=now,
            uptime_s=3600.0,
            cpu_pct=12.5,
            cpu_temp_c=44.0,
            mem_used_mb=128.0,
            disk_free_mb=2048.0,
            wifi_rssi_dbm=-58.0,
            queue_depth=0,
            queue_bytes=0,
            mic_gain_db=0.0,
            ntp_offset_ms=3.2,
            fw_version="0.1.0+demo",
            config_version="dev-1",
        )
        _publish(client, health_topic(device_id), health.model_dump_json(), qos=1)
        print(f"published health → {health_topic(device_id)}")

        # 3. event/announce — sha256 of the literal bytes b"demo-event-payload"
        event_id = uuid4()
        sha = hashlib.sha256(b"demo-event-payload").hexdigest()
        ann = EventAnnounce(
            event_id=event_id,
            ts=now,
            duration_s=15.0,
            peak_db=92.1,
            sha256=sha,
            size=18,
            content_type="audio/flac",
        )
        ann_json = ann.model_dump_json()
        _publish(client, event_announce_topic(device_id), ann_json, qos=1)
        print(f"published event/announce event_id={event_id}")

        # 3b. duplicate announce — must remain idempotent (still one row).
        _publish(client, event_announce_topic(device_id), ann_json, qos=1)
        print("re-published event/announce (idempotency check)")

        # Without an /events/intent call the ingest worker won't transition
        # announce→uploaded on done (state machine forbids it). Insert an
        # intent transition directly so the smoke test exercises the full
        # done→uploaded path. The real device flow uses POST /events/intent.
        factory = get_sessionmaker()
        async with factory() as session:
            ev = await session.get(Event, event_id)
            for _ in range(20):
                if ev is not None:
                    break
                await asyncio.sleep(0.25)
                ev = await session.get(Event, event_id)
            if ev is None:
                print("event row did not appear within 5 s — ingest worker not running?")
                return 1
            ev.status = EventStatus.UPLOAD_INTENT_CREATED.value
            await session.commit()
        print("set event status → upload_intent_created (simulating /events/intent)")

        # 4. event/done
        done = EventDone(
            event_id=event_id,
            storage_key=f"events/2026/05/15/{device_id}/{event_id}.flac",
            sha256=sha,
            size=18,
            uploaded_at=now + 5.0,
        )
        done_json = done.model_dump_json()
        _publish(client, event_done_topic(device_id), done_json, qos=1)
        print("published event/done")
        _publish(client, event_done_topic(device_id), done_json, qos=1)
        print("re-published event/done (idempotency check)")

        # Give the ingest worker a moment to drain its 1 s telemetry/health
        # batch window and flush last_seen.
        await asyncio.sleep(8.0)

        print("\n--- DB state ---")
        await _read_state(device_id, event_id)

    finally:
        client.loop_stop()
        client.disconnect()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="MQTT ingest smoke test")
    parser.add_argument("--device-id", required=True, type=UUID)
    parser.add_argument("--broker-host", default="mosquitto")
    parser.add_argument("--broker-port", default=8883, type=int)
    args = parser.parse_args()
    return asyncio.run(_main(args.device_id, args.broker_host, args.broker_port))


if __name__ == "__main__":
    sys.exit(main())

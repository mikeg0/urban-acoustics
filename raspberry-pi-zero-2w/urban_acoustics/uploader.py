"""Event upload pipeline: announce → intent → PUT → done.

State lives in :class:`QueueStore`. On startup the supervisor calls
``drain()`` once to pick up anything that survived a reboot, then schedules
a periodic drain so retries happen on the configured backoff. Each call
walks at most one upload to completion to keep memory steady on a Pi Zero.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from uuid import UUID

import httpx

from .queue_store import (
    PRIO_EVENT_ANNOUNCE,
    PRIO_EVENT_DONE,
    QueueStore,
    QueuedUpload,
)
from .transport import (
    ApiTransport,
    MqttTransport,
    event_announce_topic,
    event_done_topic,
)


log = logging.getLogger(__name__)


class EventUploader:
    def __init__(
        self,
        *,
        device_id: UUID,
        mqtt: MqttTransport,
        api: ApiTransport,
        queue: QueueStore,
    ) -> None:
        self._device_id = device_id
        self._mqtt = mqtt
        self._api = api
        self._queue = queue

    async def announce(self, upload: QueuedUpload) -> bool:
        """Publish the announce envelope. Queued if MQTT is down."""
        payload = json.dumps(
            {
                "event_id": upload.event_id,
                "ts": upload.ts,
                "duration_s": upload.duration_s,
                "peak_db": upload.peak_db,
                "sha256": upload.sha256,
                "size": upload.size,
                "content_type": "audio/flac",
            },
            separators=(",", ":"),
        )
        topic = event_announce_topic(self._device_id)
        if self._mqtt.connected:
            result = self._mqtt.publish(topic, payload, qos=1, timeout=5.0)
            if result.ok:
                return True
            log.warning("uploader: announce publish failed (%s) — queueing", result.reason)
        await self._queue.enqueue_mqtt(
            topic=topic, payload=payload, qos=1, priority=PRIO_EVENT_ANNOUNCE,
        )
        return False

    async def drain_once(self, *, now: float | None = None) -> int:
        """Advance up to one due upload by one step. Returns the number of
        uploads acted upon (0 or 1)."""
        ts = now if now is not None else time.time()
        due = await self._queue.list_pending_uploads(now=ts, limit=1)
        if not due:
            return 0
        upload = due[0]
        try:
            if upload.status == "pending":
                ok = await self._do_intent_and_put(upload)
                if not ok:
                    await self._queue.fail_upload(upload.event_id)
                    return 1
            # If we got here, the FLAC bytes are in the bucket and we have a
            # storage_key. Now publish ``event/done``.
            ok = await self._publish_done(upload)
            if ok:
                flac_path = await self._queue.remove_event_upload(upload.event_id)
                if flac_path is not None:
                    try:
                        flac_path.unlink()
                    except FileNotFoundError:
                        pass
                log.info("uploader: event %s complete", upload.event_id)
            else:
                await self._queue.fail_upload(upload.event_id)
        except Exception as exc:  # noqa: BLE001
            log.exception("uploader: event %s step raised: %s", upload.event_id, exc)
            await self._queue.fail_upload(upload.event_id)
        return 1

    async def _do_intent_and_put(self, upload: QueuedUpload) -> bool:
        body = {
            "event_id": upload.event_id,
            "ts": upload.ts,
            "duration_s": upload.duration_s,
            "peak_db": upload.peak_db,
            "sha256": upload.sha256,
            "size": upload.size,
            "content_type": "audio/flac",
            # Nonce is per-request replay protection; 16 hex chars fits the
            # ``8..64`` contract bound and is plenty of entropy for a 24 h
            # window.
            "nonce": secrets.token_hex(8),
        }
        try:
            resp = await self._api.post_intent(body)
        except httpx.HTTPError as exc:
            log.warning("uploader: intent http error for %s: %s", upload.event_id, exc)
            return False
        if resp.status_code != 200:
            log.warning(
                "uploader: intent rejected for %s status=%s body=%s",
                upload.event_id, resp.status_code, resp.text[:200],
            )
            # A 409 means the cloud already saw a *different* announce for
            # this event_id — we cannot recover, so drop it so the queue
            # does not park here forever.
            if resp.status_code == 409:
                await self._queue.mark_upload_progress(upload.event_id, status="done")
                flac_path = await self._queue.remove_event_upload(upload.event_id)
                if flac_path is not None:
                    try:
                        flac_path.unlink()
                    except FileNotFoundError:
                        pass
            return False

        intent = resp.json()
        upload_url = intent["upload_url"]
        storage_key = intent["storage_key"]
        headers = intent.get("required_headers", {})

        try:
            data = upload.flac_path.read_bytes()
        except FileNotFoundError:
            log.error("uploader: spool file missing for %s — dropping", upload.event_id)
            await self._queue.mark_upload_progress(upload.event_id, status="done")
            await self._queue.remove_event_upload(upload.event_id)
            return False

        try:
            put = await self._api.put_object(upload_url, data, headers)
        except httpx.HTTPError as exc:
            log.warning("uploader: PUT http error for %s: %s", upload.event_id, exc)
            return False
        if put.status_code not in (200, 201, 204):
            log.warning(
                "uploader: PUT rejected for %s status=%s body=%s",
                upload.event_id, put.status_code, put.text[:200],
            )
            return False

        await self._queue.mark_upload_progress(
            upload.event_id, status="uploaded", storage_key=storage_key,
        )
        # Reload the row so subsequent calls see the updated storage_key.
        return True

    async def _publish_done(self, upload: QueuedUpload) -> bool:
        # If we just transitioned to "uploaded" inside the same drain, refresh
        # the storage_key from the DB. Otherwise the in-memory object is stale.
        if upload.storage_key is None:
            refreshed = await self._queue.list_pending_uploads(now=time.time(), limit=8)
            for r in refreshed:
                if r.event_id == upload.event_id:
                    upload = r
                    break
        if upload.storage_key is None:
            log.error("uploader: cannot publish done — no storage_key for %s", upload.event_id)
            return False

        payload = json.dumps(
            {
                "event_id": upload.event_id,
                "storage_key": upload.storage_key,
                "sha256": upload.sha256,
                "size": upload.size,
                "uploaded_at": time.time(),
            },
            separators=(",", ":"),
        )
        topic = event_done_topic(self._device_id)
        if self._mqtt.connected:
            result = self._mqtt.publish(topic, payload, qos=1, timeout=5.0)
            if result.ok:
                await self._queue.mark_upload_progress(upload.event_id, status="done")
                return True
            log.warning("uploader: done publish failed (%s) — queueing", result.reason)
        await self._queue.enqueue_mqtt(
            topic=topic, payload=payload, qos=1, priority=PRIO_EVENT_DONE,
        )
        await self._queue.mark_upload_progress(upload.event_id, status="done")
        return True

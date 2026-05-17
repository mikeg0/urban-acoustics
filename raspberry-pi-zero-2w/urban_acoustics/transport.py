"""Network transport: MQTT (paho) + HTTPS (httpx).

The MQTT side is a thin wrapper around paho's threaded loop. The supervisor
hands us a payload + topic, we publish if connected, and report success or
failure synchronously so the queue store can advance state. Reconnection is
delegated to paho's built-in ``reconnect_delay_set``.

The HTTPS side is an :class:`httpx.AsyncClient` with mTLS (client cert +
client key). For Phase 1 we also send ``X-Device-Id`` as the
backend-side dev auth path expects — see ``backend/app/auth/device.py``.
"""

from __future__ import annotations

import asyncio
import logging
import ssl
import threading
from dataclasses import dataclass
from typing import Awaitable, Callable
from uuid import UUID

import httpx
import paho.mqtt.client as mqtt
from paho.mqtt.enums import CallbackAPIVersion


log = logging.getLogger(__name__)


# Topic format strings mirror plans/phase-1-contracts.md. Inlined here so
# the firmware package doesn't pull in the backend ``contracts.py`` module —
# but the strings MUST stay in lockstep with that file.
def telemetry_topic(device_id: UUID) -> str:
    return f"dev/{device_id}/tlm"


def spectrogram_topic(device_id: UUID) -> str:
    return f"dev/{device_id}/spect"


def health_topic(device_id: UUID) -> str:
    return f"dev/{device_id}/health"


def event_announce_topic(device_id: UUID) -> str:
    return f"dev/{device_id}/event/announce"


def event_done_topic(device_id: UUID) -> str:
    return f"dev/{device_id}/event/done"


def lwt_topic(device_id: UUID) -> str:
    return f"dev/{device_id}/lwt"


def command_wildcard_topic(device_id: UUID) -> str:
    return f"dev/{device_id}/cmd/+"


CommandHandler = Callable[[str, bytes], Awaitable[None]]


@dataclass
class MqttPublishResult:
    ok: bool
    reason: str | None = None


class MqttTransport:
    def __init__(
        self,
        *,
        device_id: UUID,
        broker_host: str,
        broker_port: int,
        ca_file,
        cert_file,
        key_file,
        keepalive_s: int,
        loop: asyncio.AbstractEventLoop,
        command_handler: CommandHandler | None = None,
    ) -> None:
        self.device_id = device_id
        self.broker_host = broker_host
        self.broker_port = broker_port
        self.keepalive_s = keepalive_s
        self._loop = loop
        self._command_handler = command_handler
        self._connected = threading.Event()

        client = mqtt.Client(
            callback_api_version=CallbackAPIVersion.VERSION2,
            client_id=f"pi-{device_id}",
            clean_session=True,
            protocol=mqtt.MQTTv311,
        )
        client.tls_set(
            ca_certs=str(ca_file),
            certfile=str(cert_file),
            keyfile=str(key_file),
            cert_reqs=ssl.CERT_REQUIRED,
            tls_version=ssl.PROTOCOL_TLSv1_2,
        )
        client.reconnect_delay_set(min_delay=1, max_delay=120)

        # Retained LWT — broker republishes this on unexpected disconnect.
        lwt_payload = (
            f'{{"device_id":"{device_id}","status":"offline","ts":0.0}}'
        )
        client.will_set(
            lwt_topic(device_id),
            payload=lwt_payload,
            qos=1,
            retain=True,
        )

        client.on_connect = self._on_connect
        client.on_disconnect = self._on_disconnect
        client.on_message = self._on_message
        self._client = client

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    def start(self) -> None:
        log.info(
            "mqtt: connecting to %s:%s as device %s",
            self.broker_host, self.broker_port, self.device_id,
        )
        try:
            self._client.connect_async(self.broker_host, self.broker_port, keepalive=self.keepalive_s)
        except Exception as exc:  # noqa: BLE001
            log.warning("mqtt: connect_async raised %s — relying on paho reconnect loop", exc)
        self._client.loop_start()

    def stop(self) -> None:
        try:
            self._client.disconnect()
        finally:
            self._client.loop_stop()

    def publish(self, topic: str, payload: str, qos: int, *, timeout: float = 5.0) -> MqttPublishResult:
        if not self._connected.is_set():
            return MqttPublishResult(ok=False, reason="not connected")
        info = self._client.publish(topic, payload, qos=qos)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            return MqttPublishResult(ok=False, reason=f"rc={info.rc}")
        if qos == 0:
            return MqttPublishResult(ok=True)
        try:
            info.wait_for_publish(timeout=timeout)
        except RuntimeError:
            return MqttPublishResult(ok=False, reason="puback timeout")
        return MqttPublishResult(ok=True) if info.is_published() else MqttPublishResult(
            ok=False, reason=f"not published (rc={info.rc})"
        )

    # --- paho callbacks (run on the paho thread) --------------------------

    def _on_connect(self, _c, _u, _f, reason_code, _props=None) -> None:
        if getattr(reason_code, "is_failure", False):
            log.error("mqtt: connect failed: %s", reason_code)
            return
        log.info("mqtt: connected")
        self._connected.set()
        if self._command_handler is not None:
            self._client.subscribe(command_wildcard_topic(self.device_id), qos=1)

    def _on_disconnect(self, _c, _u, _f, reason_code, _p=None) -> None:
        log.warning("mqtt: disconnected (%s)", reason_code)
        self._connected.clear()

    def _on_message(self, _c, _u, msg) -> None:
        if self._command_handler is None:
            return
        coro = self._command_handler(msg.topic, msg.payload)
        # Bridge back to the supervisor loop.
        asyncio.run_coroutine_threadsafe(coro, self._loop)


class ApiTransport:
    """HTTPS client for the backend events/intent + PUT flow."""

    def __init__(
        self,
        *,
        device_id: UUID,
        api_base: str,
        ca_file,
        cert_file,
        key_file,
        timeout_s: float,
    ) -> None:
        self.device_id = device_id
        self.api_base = api_base.rstrip("/")
        # API client: mTLS against the backend, validated by our pinned root CA.
        # ``X-Device-Id`` is the Phase 1 dev-mode auth header; Task 08 swaps
        # this for a JWT minted off the mTLS handshake.
        self._api = httpx.AsyncClient(
            verify=str(ca_file),
            cert=(str(cert_file), str(key_file)),
            timeout=timeout_s,
            headers={"X-Device-Id": str(device_id), "User-Agent": "urban-acoustics-pi/0.1"},
        )
        # Upload client: plain HTTPS against the MinIO presigned-URL host.
        # In dev the MinIO endpoint is fronted by a private CA, so we reuse
        # the same pinned bundle as the API client. Presigned URLs are
        # sha256-bound, so no client cert on the PUT side.
        self._upload = httpx.AsyncClient(verify=str(ca_file), timeout=timeout_s)

    async def aclose(self) -> None:
        await self._api.aclose()
        await self._upload.aclose()

    async def post_intent(self, body: dict) -> httpx.Response:
        return await self._api.post(f"{self.api_base}/api/v1/events/intent", json=body)

    async def put_object(self, url: str, data: bytes, headers: dict[str, str]) -> httpx.Response:
        return await self._upload.put(url, content=data, headers=headers)

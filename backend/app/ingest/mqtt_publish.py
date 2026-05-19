"""Outbound MQTT command publisher (API process).

The ingest worker is inbound-only — it subscribes to ``dev/+/...`` topics
and never publishes. This module gives the FastAPI process a small, separate
paho client whose only job is to publish retained command envelopes to
``dev/{device_id}/cmd/{cmd}``.

Why a separate client?
- Process isolation: a misbehaving publisher must not stall the ingest
  consumer loop, and vice-versa.
- Lifecycle: ingest is a long-lived worker, the API may scale horizontally;
  each API replica gets its own outbound session.
- Retained semantics: the publisher controls retain=true on every message
  so a device reconnect (or broker restart) re-applies the last known
  command without operator intervention.

The publisher is intentionally optional. If ``MQTT_BROKER_URL`` is not
configured (e.g. unit tests, or a deployment that doesn't expose commands
yet), :func:`get_command_publisher` returns ``None`` and the API endpoints
that need it return 503. This keeps the rest of the API working when the
broker is misconfigured.
"""

from __future__ import annotations

import json
import logging
import ssl
import threading
import time
from typing import Optional
from urllib.parse import urlparse
from uuid import UUID, uuid4

import paho.mqtt.client as mqtt
from paho.mqtt.enums import CallbackAPIVersion

from ..contracts import CommandEnvelope, CommandName
from ..settings import Settings


log = logging.getLogger("urban-acoustics.publish")


# Reconnect ceiling — match the ingest worker so a Mosquitto restart is
# papered over within ~30 s.
_RECONNECT_MIN = 1
_RECONNECT_MAX = 30


class CommandPublisher:
    """Thin wrapper around paho with retain=true semantics for cmd publishes."""

    def __init__(
        self,
        *,
        broker_url: str,
        ca_file: str | None,
        client_cert: str | None,
        client_key: str | None,
        client_id: str = "api-publisher",
    ) -> None:
        self._broker_url = broker_url
        self._ca_file = ca_file
        self._client_cert = client_cert
        self._client_key = client_key
        self._client_id = client_id
        self._connected = threading.Event()
        self._client = mqtt.Client(
            callback_api_version=CallbackAPIVersion.VERSION2,
            client_id=client_id,
            clean_session=True,
            protocol=mqtt.MQTTv311,
        )
        self._setup_mqtt()

    def _setup_mqtt(self) -> None:
        parsed = urlparse(self._broker_url)
        if parsed.scheme not in ("mqtts", "mqtt"):
            raise RuntimeError(
                f"MQTT_BROKER_URL scheme must be mqtts:// or mqtt://: {self._broker_url}"
            )
        if parsed.scheme == "mqtts":
            if not (self._ca_file and self._client_cert and self._client_key):
                raise RuntimeError(
                    "mqtts:// requires MQTT_CA_FILE, MQTT_CLIENT_CERT, MQTT_CLIENT_KEY"
                )
            self._client.tls_set(
                ca_certs=self._ca_file,
                certfile=self._client_cert,
                keyfile=self._client_key,
                cert_reqs=ssl.CERT_REQUIRED,
                tls_version=ssl.PROTOCOL_TLSv1_2,
            )
        self._client.reconnect_delay_set(min_delay=_RECONNECT_MIN, max_delay=_RECONNECT_MAX)
        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect

    def start(self) -> None:
        parsed = urlparse(self._broker_url)
        host = parsed.hostname or "localhost"
        port = parsed.port or (8883 if parsed.scheme == "mqtts" else 1883)
        log.info("publisher: connecting to mqtt host=%s port=%s tls=%s", host, port, parsed.scheme == "mqtts")
        try:
            self._client.connect_async(host, port, keepalive=30)
        except Exception:  # noqa: BLE001
            log.exception("publisher: initial connect_async raised; paho will retry")
        self._client.loop_start()

    def stop(self) -> None:
        try:
            self._client.disconnect()
        finally:
            self._client.loop_stop()

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    # --- paho callbacks --------------------------------------------------

    def _on_connect(self, _c, _u, _f, reason_code, _props=None) -> None:
        if getattr(reason_code, "is_failure", False):
            log.error("publisher: connect failed: %s", reason_code)
            return
        log.info("publisher: connected to %s", self._broker_url)
        self._connected.set()

    def _on_disconnect(self, _c, _u, _f, reason_code, _p=None) -> None:
        self._connected.clear()
        log.warning("publisher: disconnected (%s) — paho will reconnect", reason_code)

    # --- public surface --------------------------------------------------

    def publish_command(
        self,
        *,
        device_id: UUID,
        cmd: CommandName,
        args: dict,
        retain: bool = True,
        wait_timeout_s: float = 5.0,
    ) -> None:
        """Build a CommandEnvelope and publish it retained to dev/{id}/cmd/{cmd}.

        Raises ``RuntimeError`` on publish failure so the API handler can
        return 503 and the caller can retry. The retain flag means a device
        that's offline now will receive the command on its next reconnect.
        """
        envelope = CommandEnvelope(
            cmd_id=uuid4(),
            cmd=cmd,
            issued_at=time.time(),
            args=args,
        )
        payload = envelope.model_dump_json()
        topic = f"dev/{device_id}/cmd/{cmd}"
        info = self._client.publish(topic, payload, qos=1, retain=retain)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            raise RuntimeError(
                f"publisher: enqueue failed for {topic}: rc={info.rc} ({mqtt.error_string(info.rc)})"
            )
        # Block for the PUBACK so the API caller knows the broker accepted
        # it before we 200 to the dashboard.
        try:
            info.wait_for_publish(timeout=wait_timeout_s)
        except (RuntimeError, ValueError) as exc:
            raise RuntimeError(f"publisher: wait_for_publish raised: {exc}") from exc
        if not info.is_published():
            raise RuntimeError(f"publisher: PUBACK timed out for {topic} (rc={info.rc})")
        log.info("publisher: published cmd=%s to %s retain=%s", cmd, topic, retain)


# --- singleton accessor ------------------------------------------------------
#
# Initialised in app/main.py startup. The accessor returns None until init
# runs (or stays None forever when MQTT_BROKER_URL is unset), letting tests
# and broker-less deployments use the rest of the API.

_PUBLISHER: Optional[CommandPublisher] = None
_PUBLISHER_LOCK = threading.Lock()


def init_command_publisher(settings: Settings) -> CommandPublisher | None:
    """Idempotent: returns the existing publisher when already initialised.

    Returns ``None`` if no broker URL is configured; callers should treat
    that as "command publish unavailable" and surface a 503 to the user.
    """
    global _PUBLISHER
    with _PUBLISHER_LOCK:
        if _PUBLISHER is not None:
            return _PUBLISHER
        if not settings.MQTT_BROKER_URL:
            log.info("publisher: MQTT_BROKER_URL not set — command publish disabled")
            return None
        pub = CommandPublisher(
            broker_url=settings.MQTT_BROKER_URL,
            ca_file=settings.MQTT_CA_FILE,
            client_cert=settings.MQTT_CLIENT_CERT,
            client_key=settings.MQTT_CLIENT_KEY,
        )
        pub.start()
        _PUBLISHER = pub
        return pub


def get_command_publisher() -> CommandPublisher | None:
    return _PUBLISHER


def shutdown_command_publisher() -> None:
    global _PUBLISHER
    with _PUBLISHER_LOCK:
        if _PUBLISHER is None:
            return
        try:
            _PUBLISHER.stop()
        except Exception:  # noqa: BLE001
            log.exception("publisher: stop raised; ignoring")
        _PUBLISHER = None


# Internal helper exposed to the API router and to tests — kept here so the
# JSON envelope shape stays in lockstep with what the publisher emits.
def serialize_command_envelope(*, cmd: CommandName, args: dict) -> str:
    return CommandEnvelope(
        cmd_id=uuid4(),
        cmd=cmd,
        issued_at=time.time(),
        args=args,
    ).model_dump_json()


__all__ = [
    "CommandPublisher",
    "init_command_publisher",
    "get_command_publisher",
    "shutdown_command_publisher",
    "serialize_command_envelope",
]

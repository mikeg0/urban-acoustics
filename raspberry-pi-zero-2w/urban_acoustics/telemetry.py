"""Telemetry publisher.

Bridges the DSP layer to the MQTT transport and the queue store. Telemetry
is QoS 0 / fire-and-forget when the broker is connected; when disconnected,
samples are queued in SQLite and replayed by the supervisor's drain loop.

We do not buffer telemetry in memory beyond the queue store — the 1 Hz rate
plus the size cap on ``mqtt_queue`` already bounds memory exposure during
an outage.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from uuid import UUID

from .queue_store import PRIO_TELEMETRY, QueueStore
from .transport import MqttTransport, telemetry_topic


log = logging.getLogger(__name__)


@dataclass(frozen=True)
class TelemetrySample:
    ts: float
    laeq: float
    lafmax: float
    lcpeak: float

    def to_payload(self) -> str:
        return json.dumps(
            {"ts": self.ts, "laeq": self.laeq, "lafmax": self.lafmax, "lcpeak": self.lcpeak},
            separators=(",", ":"),
        )


class TelemetryPublisher:
    def __init__(self, *, device_id: UUID, mqtt: MqttTransport, queue: QueueStore) -> None:
        self._device_id = device_id
        self._mqtt = mqtt
        self._queue = queue
        self._topic = telemetry_topic(device_id)

    async def emit(self, sample: TelemetrySample) -> None:
        payload = sample.to_payload()
        if self._mqtt.connected:
            result = self._mqtt.publish(self._topic, payload, qos=0)
            if result.ok:
                return
            log.debug("telemetry: publish failed (%s) — queueing", result.reason)
        await self._queue.enqueue_mqtt(
            topic=self._topic, payload=payload, qos=0, priority=PRIO_TELEMETRY,
        )

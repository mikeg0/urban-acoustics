"""Telemetry publisher.

Bridges the DSP layer to the MQTT transport and the queue store. Telemetry
is QoS 0 / fire-and-forget when the broker is connected; when disconnected,
samples are queued in SQLite and replayed by the supervisor's drain loop.

We do not buffer telemetry in memory beyond the queue store — the 1 Hz rate
plus the size cap on ``mqtt_queue`` already bounds memory exposure during
an outage.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from uuid import UUID

from .queue_store import PRIO_TELEMETRY, QueueStore
from .transport import MqttTransport, spectrogram_topic, telemetry_topic


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


@dataclass(frozen=True)
class SpectrogramSample:
    ts: float
    bands: tuple[float, ...]

    def to_payload(self) -> str:
        # Round to 0.1 dB so the JSON line stays tight (~360 B) and
        # spectrogram pixel quantisation isn't visible anyway.
        return json.dumps(
            {"ts": self.ts, "bands": [round(b, 1) for b in self.bands]},
            separators=(",", ":"),
        )


# Pacing bounds for the drain loop (seconds).
_SPECT_MAX_PACE_S = 0.2   # never sleep longer than this between frames (gaps)
_SPECT_PACE_SLACK_S = 0.1  # if we're this far behind schedule, re-base to now


class SpectrogramPublisher:
    """Best-effort spectrogram emitter with paced delivery.

    Unlike :class:`TelemetryPublisher` we deliberately do **not** queue on
    failure — the band frames are a live visual aid; dropping during an
    outage and resuming when the broker is back is the correct behaviour.
    Keeping the SQLite queue out of the hot path also stops a 10 Hz emitter
    from churning the WAL.

    The capture loop hands us a whole 1 s block's worth of frames at once
    (~12 frames back-to-back). Publishing them in that burst makes the
    cloud fan them out in a burst too, so the browser receives ~1 s of
    silence then a clump — which forces the dashboard to hold a large
    playback buffer to scroll smoothly. Instead, :meth:`emit` only enqueues;
    a background :meth:`run` loop republishes at the frames' own ~85 ms
    cadence (derived from their timestamps), turning the burst into a steady
    stream so the dashboard buffer can be small. The queue is bounded and
    drops the oldest frame on overflow, keeping the stream live (never
    replaying stale frames) if the broker briefly stalls.
    """

    # Bound on in-flight frames. ~4 s at 12 Hz — comfortably covers one
    # capture block plus transient broker slowness before we shed oldest.
    _QUEUE_MAX = 48

    def __init__(self, *, device_id: UUID, mqtt: MqttTransport) -> None:
        self._device_id = device_id
        self._mqtt = mqtt
        self._topic = spectrogram_topic(device_id)
        self._dropped = 0
        self._queue: asyncio.Queue[SpectrogramSample] = asyncio.Queue(
            maxsize=self._QUEUE_MAX,
        )

    @property
    def dropped(self) -> int:
        return self._dropped

    async def emit(self, sample: SpectrogramSample) -> None:
        # Non-blocking: never stall the capture loop. On overflow (drain or
        # broker behind) shed the oldest frame so we stay live, not buffered.
        try:
            self._queue.put_nowait(sample)
        except asyncio.QueueFull:
            try:
                self._queue.get_nowait()
                self._dropped += 1
            except asyncio.QueueEmpty:
                pass
            self._queue.put_nowait(sample)

    async def run(self) -> None:
        """Drain the queue, pacing publishes at the frames' own cadence so
        delivery is a steady stream rather than a per-block burst."""
        prev_ts: float | None = None
        schedule: float | None = None  # monotonic time the next frame is due
        while True:
            sample = await self._queue.get()
            now = time.monotonic()
            if prev_ts is None or schedule is None:
                schedule = now
            else:
                dt = sample.ts - prev_ts
                if dt < 0:
                    dt = 0.0
                elif dt > _SPECT_MAX_PACE_S:
                    dt = _SPECT_MAX_PACE_S  # don't pace out a capture gap
                schedule += dt
                if schedule < now - _SPECT_PACE_SLACK_S:
                    schedule = now  # fell behind — re-base, don't accrue lag
            delay = schedule - now
            if delay > 0:
                await asyncio.sleep(delay)
            self._publish(sample)
            prev_ts = sample.ts

    def _publish(self, sample: SpectrogramSample) -> None:
        if not self._mqtt.connected:
            self._dropped += 1
            return
        result = self._mqtt.publish(self._topic, sample.to_payload(), qos=0)
        if not result.ok:
            self._dropped += 1
            # Don't log per-failure at 10 Hz; periodically surface the rate.
            if self._dropped % 100 == 1:
                log.debug(
                    "spectrogram: publish failed (%s) — dropped=%d",
                    result.reason, self._dropped,
                )

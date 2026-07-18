"""Unit tests for SpectrogramPublisher's paced delivery.

The capture loop hands the publisher a whole 1 s block's worth of frames at
once; the publisher must (a) never block the capture loop and shed the oldest
frame on overflow, and (b) republish at the frames' own ~85 ms cadence so the
cloud fan-out — and therefore the dashboard — sees a steady stream rather than
a per-block burst.

Driven via ``asyncio.run`` to keep the Pi venv free of a pytest-asyncio dep
(same convention as test_supervisor_command). Pacing is verified against a
fake monotonic clock + a fake ``asyncio.sleep`` so the test is deterministic
and instant rather than sleeping real wall-clock time.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from uuid import uuid4

from urban_acoustics import telemetry
from urban_acoustics.telemetry import SpectrogramPublisher, SpectrogramSample
from urban_acoustics.transport import MqttPublishResult


class _FakeMqtt:
    def __init__(
        self,
        *,
        connected: bool = True,
        on_publish: Callable[[], None] | None = None,
    ) -> None:
        self._connected = connected
        self._on_publish = on_publish
        self.published: list[tuple[str, str]] = []

    @property
    def connected(self) -> bool:
        return self._connected

    def publish(self, topic: str, payload: str, qos: int, *, timeout: float = 5.0) -> MqttPublishResult:
        self.published.append((topic, payload))
        if self._on_publish is not None:
            self._on_publish()
        return MqttPublishResult(ok=True)


def _sample(ts: float) -> SpectrogramSample:
    return SpectrogramSample(ts=ts, bands=(0.0,) * 30)


def test_emit_is_nonblocking_and_sheds_oldest_on_overflow() -> None:
    pub = SpectrogramPublisher(device_id=uuid4(), mqtt=_FakeMqtt())
    overflow = 10

    async def go() -> None:
        # No drain running, so emit() fills the queue; the extra frames must
        # not raise and must drop the *oldest* to keep the stream live.
        for i in range(SpectrogramPublisher._QUEUE_MAX + overflow):
            await pub.emit(_sample(float(i)))

    asyncio.run(go())

    assert pub._queue.qsize() == SpectrogramPublisher._QUEUE_MAX
    assert pub.dropped == overflow
    # The frames left behind are the most recent ones (oldest were shed).
    remaining = [pub._queue.get_nowait().ts for _ in range(pub._queue.qsize())]
    assert remaining[0] == float(overflow)            # oldest survivor
    assert remaining[-1] == float(SpectrogramPublisher._QUEUE_MAX + overflow - 1)


def test_run_paces_a_burst_into_a_steady_stream(monkeypatch) -> None:
    fake_t = {"v": 0.0}
    real_sleep = asyncio.sleep
    recorded: list[float] = []

    async def fake_sleep(delay: float) -> None:
        recorded.append(delay)
        if delay > 0:
            fake_t["v"] += delay
        await real_sleep(0)  # yield without burning wall-clock time

    monkeypatch.setattr(telemetry.time, "monotonic", lambda: fake_t["v"])
    monkeypatch.setattr(asyncio, "sleep", fake_sleep)

    mqtt = _FakeMqtt()
    pub = SpectrogramPublisher(device_id=uuid4(), mqtt=mqtt)
    period = 0.085

    async def go() -> None:
        # A burst of 6 frames spaced one column apart, all enqueued at once.
        for i in range(6):
            await pub.emit(_sample(i * period))
        task = asyncio.create_task(pub.run())
        for _ in range(200):
            await real_sleep(0)
            if len(mqtt.published) >= 6:
                break
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(go())

    # All frames delivered, in order.
    assert len(mqtt.published) == 6
    # The first goes out immediately; each subsequent one is paced ~one column
    # apart instead of all firing back-to-back.
    paced = [d for d in recorded if d > 0]
    assert len(paced) == 5
    assert all(abs(d - period) < 1e-9 for d in paced)


def test_run_rebases_instead_of_replaying_after_a_gap(monkeypatch) -> None:
    """A large gap in frame timestamps must not translate into a long sleep —
    pacing is capped and an empty queue re-bases after a publisher stall."""
    fake_t = {"v": 0.0}
    real_sleep = asyncio.sleep
    recorded: list[float] = []
    publish_times: list[float] = []

    async def fake_sleep(delay: float) -> None:
        recorded.append(delay)
        if delay > 0:
            fake_t["v"] += delay
        await real_sleep(0)

    monkeypatch.setattr(telemetry.time, "monotonic", lambda: fake_t["v"])
    monkeypatch.setattr(asyncio, "sleep", fake_sleep)

    def record_and_stall() -> None:
        publish_times.append(fake_t["v"])
        if len(publish_times) == 1:
            fake_t["v"] += 1.0

    mqtt = _FakeMqtt(on_publish=record_and_stall)
    pub = SpectrogramPublisher(device_id=uuid4(), mqtt=mqtt)

    async def go() -> None:
        await pub.emit(_sample(0.0))
        await pub.emit(_sample(30.0))  # 30 s gap (e.g. capture stall)
        task = asyncio.create_task(pub.run())
        for _ in range(200):
            await real_sleep(0)
            if len(mqtt.published) >= 2:
                break
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(go())

    assert len(mqtt.published) == 2
    # The first publish stalls for a second. Once the second frame has been
    # taken from the queue, the queue is empty, so the overdue schedule is
    # re-based and the frame publishes immediately instead of replaying debt.
    assert publish_times == [0.0, 1.0]
    paced = [d for d in recorded if d > 0]
    assert paced == []


def test_run_catches_up_while_queue_is_backlogged(monkeypatch) -> None:
    """A transient stall must drain backlog faster than frame cadence."""
    fake_t = {"v": 0.0}
    real_sleep = asyncio.sleep
    publish_times: list[float] = []

    async def fake_sleep(delay: float) -> None:
        if delay > 0:
            fake_t["v"] += delay
        await real_sleep(0)

    monkeypatch.setattr(telemetry.time, "monotonic", lambda: fake_t["v"])
    monkeypatch.setattr(asyncio, "sleep", fake_sleep)

    def record_and_stall() -> None:
        publish_times.append(fake_t["v"])
        if len(publish_times) == 1:
            fake_t["v"] += 0.3

    mqtt = _FakeMqtt(on_publish=record_and_stall)
    pub = SpectrogramPublisher(device_id=uuid4(), mqtt=mqtt)
    period = 0.085

    async def go() -> None:
        for i in range(8):
            await pub.emit(_sample(i * period))
        task = asyncio.create_task(pub.run())
        for _ in range(200):
            await real_sleep(0)
            if len(mqtt.published) >= 8:
                break
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(go())

    assert len(mqtt.published) == 8
    # The first publish incurs a 300 ms stall. Since more frames remain queued,
    # schedule debt is retained and several frames publish back-to-back at the
    # new wall time. Re-basing here would pace the third frame 85 ms later.
    assert publish_times[:4] == [0.0, 0.3, 0.3, 0.3]
    assert publish_times[-1] < 0.6

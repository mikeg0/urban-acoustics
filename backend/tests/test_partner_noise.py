"""Partner noise-curve handler — pure-logic checks with a stub session.

Calls ``partner.get_device_noise`` directly with a stubbed async session that
returns pre-seeded telemetry rows, matching the rest of the suite (no Postgres).
Asserts the response shape, ISO-8601 ``ts`` serialization, and the 400/404
error paths shared with the dashboard telemetry read.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID

import pytest
from fastapi import HTTPException

from app.api.v1 import partner
from app.contracts import TelemetryResolution

DEVICE = UUID("00000000-0000-4000-8000-00000000000a")
T0 = datetime(2025, 12, 3, 2, 45, tzinfo=timezone.utc)


class _StubSession:
    """Async-session stub: ``get`` returns the device; ``execute`` serves two
    queries — the telemetry ``text()`` (called with a params dict, iterated
    directly) and the events ``select(Event)`` (called with no params, consumed
    via ``.scalars().all()``). Branch on whether params were passed."""

    def __init__(
        self,
        *,
        device: object | None,
        rows: list | None = None,
        events: list | None = None,
    ) -> None:
        self._device = device
        self._rows = rows or []
        self._events = events or []

    async def get(self, _model, _id):
        return self._device

    async def execute(self, _stmt, _params=None):
        if _params is None:
            # events: select(Event) → result.scalars().all()
            return SimpleNamespace(
                scalars=lambda: SimpleNamespace(all=lambda: list(self._events))
            )
        # telemetry: text() SQL + params, iterated directly
        return list(self._rows)


def _row(ts: datetime, laeq: float, lafmax: float, lcpeak: float) -> SimpleNamespace:
    return SimpleNamespace(ts=ts, laeq=laeq, lafmax=lafmax, lcpeak=lcpeak)


def _event(ts: datetime, peak_db: float, duration_s: float, classification: str | None) -> SimpleNamespace:
    return SimpleNamespace(ts=ts, peak_db=peak_db, duration_s=duration_s, classification=classification)


async def _call(session, *, from_=T0, to=T0 + timedelta(hours=1), res=TelemetryResolution.ONE_MINUTE):
    return await partner.get_device_noise(
        DEVICE, from_=from_, to=to, res=res, session=session,  # type: ignore[arg-type]
    )


@pytest.mark.asyncio
async def test_points_shape_and_iso_ts() -> None:
    rows = [
        _row(T0, 41.2, 47.8, 60.3),
        _row(T0 + timedelta(minutes=1), 39.9, 45.1, 58.0),
    ]
    resp = await _call(_StubSession(device=SimpleNamespace(device_id=DEVICE), rows=rows))

    assert resp.device_id == DEVICE
    assert resp.resolution == TelemetryResolution.ONE_MINUTE
    assert resp.unit == "dB_SPL"
    assert len(resp.points) == 2
    assert (resp.points[0].laeq, resp.points[0].lafmax, resp.points[0].lcpeak) == (41.2, 47.8, 60.3)

    # ts must serialize to a UTC-aware ISO-8601 string sleep-atlas's iso_parse
    # can round-trip (it handles both the `Z` and `+00:00` forms).
    dumped = resp.model_dump(mode="json")
    ts = dumped["points"][0]["ts"]
    assert ts.startswith("2025-12-03T02:45:00")
    assert ts.endswith("Z") or ts.endswith("+00:00")
    assert datetime.fromisoformat(ts.replace("Z", "+00:00")) == T0


@pytest.mark.asyncio
async def test_events_embedded_with_iso_ts_and_classification() -> None:
    events = [
        _event(T0 + timedelta(minutes=2), 92.4, 1.5, "motorcycle"),
        _event(T0 + timedelta(minutes=40), 78.1, 0.8, None),
    ]
    resp = await _call(
        _StubSession(device=SimpleNamespace(device_id=DEVICE), rows=[], events=events)
    )
    assert len(resp.events) == 2
    e0 = resp.events[0]
    assert (e0.peak_db, e0.duration_s, e0.classification) == (92.4, 1.5, "motorcycle")
    assert resp.events[1].classification is None

    dumped = resp.model_dump(mode="json")
    ts = dumped["events"][0]["ts"]
    assert ts.startswith("2025-12-03T02:47:00")
    assert ts.endswith("Z") or ts.endswith("+00:00")


@pytest.mark.asyncio
async def test_empty_window_returns_no_points_or_events() -> None:
    resp = await _call(_StubSession(device=SimpleNamespace(), rows=[], events=[]))
    assert resp.points == []
    assert resp.events == []


@pytest.mark.asyncio
async def test_to_not_after_from_400() -> None:
    with pytest.raises(HTTPException) as ei:
        await _call(_StubSession(device=SimpleNamespace()), from_=T0, to=T0)
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_naive_datetime_400() -> None:
    naive = datetime(2025, 12, 3, 2, 45)  # no tzinfo
    with pytest.raises(HTTPException) as ei:
        await _call(_StubSession(device=SimpleNamespace()), from_=naive, to=T0 + timedelta(hours=1))
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_window_too_large_400() -> None:
    # raw cap is 24 h; ask for 48 h.
    with pytest.raises(HTTPException) as ei:
        await _call(
            _StubSession(device=SimpleNamespace()),
            from_=T0,
            to=T0 + timedelta(hours=48),
            res=TelemetryResolution.RAW,
        )
    assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_device_missing_404() -> None:
    with pytest.raises(HTTPException) as ei:
        await _call(_StubSession(device=None))
    assert ei.value.status_code == 404

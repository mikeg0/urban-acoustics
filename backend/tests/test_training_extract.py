from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest

from app.training.extract import list_correlated_candidates


class _Rows:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self._rows = rows

    def all(self) -> list[tuple[object, ...]]:
        return self._rows


class _Session:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self._rows = rows
        self.statement = None

    async def execute(self, statement):
        self.statement = statement
        return _Rows(self._rows)


@pytest.mark.asyncio
async def test_candidate_extraction_keeps_specific_source_labels() -> None:
    start = datetime(2026, 7, 26, tzinfo=timezone.utc)
    device_id = UUID("00000000-0000-4000-8000-00000000000a")
    rows = [
        (
            UUID("00000000-0000-4000-8000-000000000001"),
            device_id,
            start,
            start + timedelta(seconds=30),
            "truck",
        ),
        (
            UUID("00000000-0000-4000-8000-000000000002"),
            device_id,
            start,
            start + timedelta(seconds=30),
            "rain",
        ),
    ]
    session = _Session(rows)

    manifest = await list_correlated_candidates(session)  # type: ignore[arg-type]

    assert [row.label for row in manifest] == ["truck", "rain"]
    assert all(row.source == "candidate" for row in manifest)
    statement = str(session.statement)
    assert "correlated_event_candidates.label IS NOT NULL" in statement
    assert "correlated_event_candidates.dismissed IS false" in statement

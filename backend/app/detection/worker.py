"""Polling worker for adaptive two-microphone event detection.

This is intentionally a separate process from FastAPI and MQTT ingest. It
reads the durable 1 Hz ``telemetry_db`` stream, correlates outside and inside
adaptive peaks, and copies both microphones' spectrogram frames into a normal
Postgres table before Timescale's seven-day source retention can remove them.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from ..models import (
    CorrelatedEventCandidate,
    CorrelatedEventSettings,
    Device,
    Telemetry,
)
from .audio import link_candidate_audio
from .peaks import Sample, adaptive_peaks, correlate_peak


log = logging.getLogger("urban-acoustics.detection")
SETTINGS_ID = 1
MAX_SCAN_SPAN = timedelta(hours=6)
# Allows the spectrogram ingest batch that trails telemetry to commit.
INGEST_SETTLE_SECONDS = 2


def _settings_kwargs(row: CorrelatedEventSettings, *, inside: bool) -> dict[str, Any]:
    return {
        "baseline_window_s": row.baseline_window_s,
        "min_baseline_samples": row.min_baseline_samples,
        "rise_db": row.inside_rise_db if inside else row.outside_rise_db,
        "min_db": row.inside_min_db if inside else row.outside_min_db,
        "merge_window_s": row.peak_merge_window_s,
        "cooldown_s": row.peak_cooldown_s,
    }


async def _samples(
    session: AsyncSession,
    *,
    device_id,
    metric: str,
    start: datetime,
    end: datetime,
) -> list[Sample]:
    value_col = getattr(Telemetry, metric)
    rows = await session.execute(
        select(Telemetry.ts, value_col)
        .where(Telemetry.device_id == device_id)
        .where(Telemetry.ts >= start)
        .where(Telemetry.ts <= end)
        .order_by(Telemetry.ts)
    )
    return [Sample(ts=ts, value=float(value)) for ts, value in rows.all()]


async def run_detection_cycle(
    session: AsyncSession, *, now: datetime | None = None
) -> int:
    """Detect and persist one bounded batch; return candidate count."""

    now = now or datetime.now(timezone.utc)
    settings = await session.get(CorrelatedEventSettings, SETTINGS_ID)
    if settings is None:
        log.warning("detector: settings singleton is missing")
        return 0

    # Runs before — and independently of — detection so that pausing the
    # detector still lets already-queued candidates become labelable, and so
    # this survives the early returns further down. Candidates created later in
    # this cycle are picked up by the next pass a few seconds from now.
    await link_candidate_audio(
        session,
        match_window_s=settings.audio_match_window_s,
        grace_s=settings.audio_grace_s,
        now=now,
    )
    await session.commit()

    holdback_s = max(
        settings.snapshot_after_s,
        settings.peak_merge_window_s,
        settings.correlation_window_s + settings.peak_merge_window_s,
    )
    processing_ceiling = now - timedelta(seconds=holdback_s + INGEST_SETTLE_SECONDS)
    if not settings.enabled:
        # Disabled means do not build a future backlog from this interval.
        settings.last_processed_at = processing_ceiling
        await session.commit()
        return 0

    outside_exists = await session.get(Device, settings.outside_device_id)
    inside_exists = await session.get(Device, settings.inside_device_id)
    if outside_exists is None or inside_exists is None:
        log.warning(
            "detector: waiting for configured devices outside=%s inside=%s",
            settings.outside_device_id,
            settings.inside_device_id,
        )
        return 0

    if settings.last_processed_at is None:
        latest = await session.scalar(
            select(func.max(Telemetry.ts))
            .where(Telemetry.device_id == settings.outside_device_id)
            .where(Telemetry.ts <= processing_ceiling)
        )
        if latest is None:
            return 0
        processing_start = latest - timedelta(
            seconds=max(60, settings.scan_interval_s * 3)
        )
    else:
        processing_start = settings.last_processed_at

    processing_end = min(processing_ceiling, processing_start + MAX_SCAN_SPAN)
    if processing_end <= processing_start:
        return 0

    # Include enough history to both build the oldest peak's own baseline and
    # apply cooldown consistently when a polling boundary bisects an event.
    analysis_start = processing_start - timedelta(
        seconds=(
            settings.baseline_window_s
            + settings.peak_cooldown_s
            + settings.peak_merge_window_s
        )
    )
    outside_samples = await _samples(
        session,
        device_id=settings.outside_device_id,
        metric=settings.metric,
        start=analysis_start,
        # Look ahead far enough to finish a threshold-crossing cluster whose
        # first sample lands exactly at the processing boundary.
        end=processing_end + timedelta(seconds=settings.peak_merge_window_s),
    )
    inside_samples = await _samples(
        session,
        device_id=settings.inside_device_id,
        metric=settings.metric,
        start=analysis_start,
        end=processing_end
        + timedelta(
            seconds=settings.correlation_window_s + settings.peak_merge_window_s
        ),
    )
    outside_peaks = adaptive_peaks(outside_samples, **_settings_kwargs(settings, inside=False))
    inside_peaks = adaptive_peaks(inside_samples, **_settings_kwargs(settings, inside=True))

    created = 0
    for outside in outside_peaks:
        if not (processing_start < outside.ts <= processing_end):
            continue
        inside = correlate_peak(
            outside, inside_peaks, window_s=settings.correlation_window_s
        )
        candidate_id = uuid4()
        snapshot_start = outside.ts - timedelta(seconds=settings.snapshot_before_s)
        snapshot_end = outside.ts + timedelta(seconds=settings.snapshot_after_s)
        values = {
            "candidate_id": candidate_id,
            "candidate_group": "correlated" if inside else "outside_only",
            "outside_device_id": settings.outside_device_id,
            "inside_device_id": settings.inside_device_id,
            "metric": settings.metric,
            "outside_peak_ts": outside.ts,
            "outside_peak_db": outside.value,
            "outside_baseline_db": outside.baseline,
            "outside_rise_db": outside.rise,
            "inside_peak_ts": inside.ts if inside else None,
            "inside_peak_db": inside.value if inside else None,
            "inside_baseline_db": inside.baseline if inside else None,
            "inside_rise_db": inside.rise if inside else None,
            "snapshot_start": snapshot_start,
            "snapshot_end": snapshot_end,
            # Audio is attached by a later pass once the device finishes
            # uploading; until then the candidate is not labelable.
            "outside_event_id": None,
            "audio_state": "pending",
            "label": None,
            "dismissed": False,
            "reviewed_by": None,
            "reviewed_at": None,
            "created_at": now,
        }
        inserted = await session.scalar(
            pg_insert(CorrelatedEventCandidate.__table__)
            .values(**values)
            .on_conflict_do_nothing(
                constraint="uq_correlated_event_candidates_outside_peak"
            )
            .returning(CorrelatedEventCandidate.candidate_id)
        )
        if inserted is None:
            continue

        # INSERT..SELECT makes the snapshot atomic with candidate creation and
        # avoids pulling up to hundreds of 30-float frames through Python.
        await session.execute(
            text(
                """
                INSERT INTO correlated_event_frames (candidate_id, device_id, ts, bands)
                SELECT :candidate_id, device_id, ts, bands
                FROM spectrogram_frames
                WHERE device_id IN (:outside_device_id, :inside_device_id)
                  AND ts >= :snapshot_start
                  AND ts < :snapshot_end
                ON CONFLICT DO NOTHING
                """
            ),
            {
                "candidate_id": candidate_id,
                "outside_device_id": settings.outside_device_id,
                "inside_device_id": settings.inside_device_id,
                "snapshot_start": snapshot_start,
                "snapshot_end": snapshot_end,
            },
        )
        created += 1

    settings.last_processed_at = processing_end
    await session.commit()
    if created:
        log.info(
            "detector: created %d candidate(s) through %s", created, processing_end
        )
    return created


class DetectionWorker:
    def __init__(self, database_url: str | None = None) -> None:
        url = database_url or os.environ.get("DATABASE_URL")
        if not url:
            raise RuntimeError("DATABASE_URL is required for the detection worker")
        self._engine = create_async_engine(url, pool_pre_ping=True, future=True)
        self._factory = async_sessionmaker(
            self._engine, expire_on_commit=False, class_=AsyncSession
        )
        self._stop = asyncio.Event()

    def stop(self) -> None:
        self._stop.set()

    async def run(self, *, once: bool = False) -> int:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, self.stop)
            except NotImplementedError:
                pass
        try:
            while not self._stop.is_set():
                interval = 10
                try:
                    async with self._factory() as session:
                        await run_detection_cycle(session)
                        cfg = await session.get(CorrelatedEventSettings, SETTINGS_ID)
                        if cfg is not None:
                            interval = cfg.scan_interval_s
                except SQLAlchemyError:
                    log.exception("detector: cycle failed")
                if once:
                    break
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=interval)
                except asyncio.TimeoutError:
                    pass
        finally:
            await self._engine.dispose()
        return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run two-mic cloud event detection")
    parser.add_argument("--once", action="store_true", help="Run one detection cycle")
    return parser


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    args = _parser().parse_args()
    raise SystemExit(asyncio.run(DetectionWorker().run(once=args.once)))


if __name__ == "__main__":
    main()

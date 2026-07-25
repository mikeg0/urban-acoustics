"""Pull labeled data from Postgres into a Pi training cache.

Two label sources feed the same Pi-side classifier:

* Audio-backed events: latest-wins label per event from ``labels``,
  joined to its (frames × 30) slice of ``spectrogram_frames`` over
  ``[event.ts, event.ts + duration_s)``.
* Spectrogram annotations: user-drawn time ranges from
  ``spectrogram_annotations`` covering sub-threshold patterns
  (most wind, rain, distant helicopters). Sliced from the same
  hypertable over ``[ts_start, ts_end)``.
* Two-mic candidates: admin-reviewed ``real``/``wind`` examples read from
  ``correlated_event_frames``. These snapshots survive the source hypertable's
  seven-day retention; ``unsure`` and dismissed candidates are excluded.

Both sources collapse to one Pi feature row each. Annotations are capped
per class at ``cap_ratio × audio_count`` so labeling a large number of
sub-threshold ranges doesn't drown out the loud-event distribution at
training time.

Output: ``pi_cache.npz`` with arrays ``features``, ``labels``,
``sources`` (``'event'`` | ``'annotation'`` | ``'candidate'``), and ``ids``
for traceability.
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import logging
import pathlib
from collections import Counter
from datetime import datetime, timedelta
from typing import Literal
from uuid import UUID

import numpy as np
from sqlalchemy import desc, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_sessionmaker
from ..models import CorrelatedEventCandidate, Event, Label, SpectrogramAnnotation
from .features import N_BANDS, compute_pi_features


log = logging.getLogger(__name__)


Source = Literal["event", "annotation", "candidate"]


@dataclasses.dataclass(frozen=True)
class ManifestRow:
    """A labeled time-range to be turned into a single training example."""

    source: Source
    label: str
    device_id: UUID
    ts_start: datetime
    ts_end: datetime
    # Stable identifier for traceability. UUID hex for events, decimal
    # string for annotation rows. Stored in the cache so we can debug
    # "which event produced this misclassified feature row".
    id: str


@dataclasses.dataclass
class ExtractStats:
    audio_per_class: Counter[str]
    annotation_per_class: Counter[str]
    candidate_per_class: Counter[str]
    audio_skipped_no_frames: int = 0
    annotation_skipped_no_frames: int = 0
    candidate_skipped_no_frames: int = 0
    annotation_capped_per_class: dict[str, int] = dataclasses.field(default_factory=dict)


async def latest_event_labels(session: AsyncSession) -> list[ManifestRow]:
    """One row per audio-backed event that has at least one user label.

    Mirrors the ``_latest_labels`` pattern in
    :mod:`backend.app.api.v1.events` — latest ``Label.created_at`` wins
    per event. The lateral join is the cheapest way to keep this O(N).
    """
    stmt = (
        select(
            Event.event_id,
            Event.device_id,
            Event.ts,
            Event.duration_s,
            Label.label,
        )
        .join(Label, Label.event_id == Event.event_id)
        .order_by(Event.event_id, desc(Label.created_at))
    )
    rows = (await session.execute(stmt)).all()

    out: list[ManifestRow] = []
    seen: set[UUID] = set()
    for event_id, device_id, ts, duration_s, label in rows:
        if event_id in seen:
            continue
        seen.add(event_id)
        if duration_s <= 0.0:
            continue
        out.append(
            ManifestRow(
                source="event",
                label=label,
                device_id=device_id,
                ts_start=ts,
                ts_end=ts + timedelta(seconds=float(duration_s)),
                id=str(event_id),
            )
        )
    return out


async def list_annotations(session: AsyncSession) -> list[ManifestRow]:
    stmt = select(
        SpectrogramAnnotation.id,
        SpectrogramAnnotation.device_id,
        SpectrogramAnnotation.ts_start,
        SpectrogramAnnotation.ts_end,
        SpectrogramAnnotation.label,
    )
    rows = (await session.execute(stmt)).all()
    return [
        ManifestRow(
            source="annotation",
            label=label,
            device_id=device_id,
            ts_start=ts_start,
            ts_end=ts_end,
            id=str(ann_id),
        )
        for ann_id, device_id, ts_start, ts_end, label in rows
    ]


async def list_correlated_candidates(session: AsyncSession) -> list[ManifestRow]:
    """Return reviewed binary candidates backed by permanent snapshots."""

    rows = (
        await session.execute(
            select(
                CorrelatedEventCandidate.candidate_id,
                CorrelatedEventCandidate.outside_device_id,
                CorrelatedEventCandidate.snapshot_start,
                CorrelatedEventCandidate.snapshot_end,
                CorrelatedEventCandidate.label,
            ).where(
                CorrelatedEventCandidate.dismissed.is_(False),
                CorrelatedEventCandidate.label.in_(("real", "wind")),
            )
        )
    ).all()
    return [
        ManifestRow(
            source="candidate",
            label=label,
            device_id=device_id,
            ts_start=ts_start,
            ts_end=ts_end,
            id=str(candidate_id),
        )
        for candidate_id, device_id, ts_start, ts_end, label in rows
    ]


async def fetch_bands(
    session: AsyncSession, row: ManifestRow
) -> np.ndarray | None:
    """Return ``(n_frames, N_BANDS)`` of band data for the row's window.

    Returns ``None`` when the hypertable has no rows in the window —
    typical for events captured before frame storage was enabled, or
    annotations drawn over a gap in the frame stream.
    """
    if row.source == "candidate":
        sql = text(
            """
            SELECT bands FROM correlated_event_frames
            WHERE candidate_id = CAST(:candidate_id AS uuid)
              AND device_id = :device_id
            ORDER BY ts
            """
        )
        params = {"candidate_id": row.id, "device_id": row.device_id}
    else:
        sql = text(
            """
            SELECT bands FROM spectrogram_frames
            WHERE device_id = :device_id
              AND ts >= :ts_start
              AND ts <  :ts_end
            ORDER BY ts
            """
        )
        params = {
            "device_id": row.device_id,
            "ts_start": row.ts_start,
            "ts_end": row.ts_end,
        }
    result = await session.execute(sql, params)
    frames = [r[0] for r in result.all()]
    if not frames:
        return None
    arr = np.asarray(frames, dtype=np.float32)
    if arr.ndim != 2 or arr.shape[1] != N_BANDS:
        log.warning(
            "extract: dropping %s %s — unexpected band shape %s",
            row.source, row.id, arr.shape,
        )
        return None
    return arr


def apply_annotation_cap(
    manifest: list[ManifestRow], *, cap_ratio: float
) -> tuple[list[ManifestRow], dict[str, int]]:
    """Cap annotation rows per class at ``cap_ratio × audio_count``.

    A class with zero audio-backed examples still admits a small floor of
    annotations (``ceil(cap_ratio)``) so a class that *only* shows up in
    annotations isn't completely thrown away — but it can't dominate.
    Returns (capped manifest, per-class capped counts).
    """
    audio_count: Counter[str] = Counter(
        r.label for r in manifest if r.source == "event"
    )
    annotations_by_label: dict[str, list[ManifestRow]] = {}
    for r in manifest:
        if r.source == "annotation":
            annotations_by_label.setdefault(r.label, []).append(r)

    capped_counts: dict[str, int] = {}
    kept_annotations: list[ManifestRow] = []
    for label, rows in annotations_by_label.items():
        budget_f = cap_ratio * max(audio_count.get(label, 0), 0)
        budget = max(int(np.ceil(budget_f)), int(np.ceil(cap_ratio)))
        if len(rows) > budget:
            capped_counts[label] = len(rows) - budget
            rows = rows[:budget]
        kept_annotations.extend(rows)

    capped = [r for r in manifest if r.source != "annotation"] + kept_annotations
    return capped, capped_counts


async def build_dataset(
    session: AsyncSession,
    *,
    cap_ratio: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, ExtractStats]:
    """Materialise the Pi training cache as four parallel arrays.

    Returns (features, labels, sources, ids, stats).
    """
    events = await latest_event_labels(session)
    annotations = await list_annotations(session)
    candidates = await list_correlated_candidates(session)
    manifest = events + annotations + candidates

    capped, capped_counts = apply_annotation_cap(manifest, cap_ratio=cap_ratio)

    stats = ExtractStats(
        audio_per_class=Counter(r.label for r in capped if r.source == "event"),
        annotation_per_class=Counter(
            r.label for r in capped if r.source == "annotation"
        ),
        candidate_per_class=Counter(
            r.label for r in capped if r.source == "candidate"
        ),
        annotation_capped_per_class=capped_counts,
    )

    feat_rows: list[np.ndarray] = []
    label_rows: list[str] = []
    source_rows: list[str] = []
    id_rows: list[str] = []
    for row in capped:
        bands = await fetch_bands(session, row)
        if bands is None:
            if row.source == "event":
                stats.audio_skipped_no_frames += 1
            elif row.source == "annotation":
                stats.annotation_skipped_no_frames += 1
            else:
                stats.candidate_skipped_no_frames += 1
            continue
        feat_rows.append(compute_pi_features(bands))
        label_rows.append(row.label)
        source_rows.append(row.source)
        id_rows.append(row.id)

    if not feat_rows:
        # Empty arrays still need explicit shape so downstream np.load is well-formed.
        features = np.zeros((0, 0), dtype=np.float32)
    else:
        features = np.stack(feat_rows).astype(np.float32, copy=False)

    return (
        features,
        np.asarray(label_rows, dtype=object),
        np.asarray(source_rows, dtype=object),
        np.asarray(id_rows, dtype=object),
        stats,
    )


def write_cache(
    path: pathlib.Path,
    *,
    features: np.ndarray,
    labels: np.ndarray,
    sources: np.ndarray,
    ids: np.ndarray,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        path,
        features=features,
        labels=labels,
        sources=sources,
        ids=ids,
    )


def _print_stats(stats: ExtractStats, *, n_rows: int) -> None:
    log.info("extract: produced %d feature rows", n_rows)
    log.info("extract: audio-backed events per class:")
    for label, n in sorted(stats.audio_per_class.items()):
        log.info("  %-15s %d", label, n)
    if stats.annotation_per_class:
        log.info("extract: annotations per class (after cap):")
        for label, n in sorted(stats.annotation_per_class.items()):
            log.info("  %-15s %d", label, n)
    if stats.candidate_per_class:
        log.info("extract: reviewed two-mic candidates per class:")
        for label, n in sorted(stats.candidate_per_class.items()):
            log.info("  %-15s %d", label, n)
    if stats.annotation_capped_per_class:
        log.info("extract: dropped by cap:")
        for label, n in sorted(stats.annotation_capped_per_class.items()):
            log.info("  %-15s %d", label, n)
    if (
        stats.audio_skipped_no_frames
        or stats.annotation_skipped_no_frames
        or stats.candidate_skipped_no_frames
    ):
        log.info(
            "extract: skipped (no frames) — events=%d annotations=%d candidates=%d",
            stats.audio_skipped_no_frames,
            stats.annotation_skipped_no_frames,
            stats.candidate_skipped_no_frames,
        )


async def _amain(args: argparse.Namespace) -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s"
    )
    factory = get_sessionmaker()
    async with factory() as session:
        features, labels, sources, ids, stats = await build_dataset(
            session, cap_ratio=args.annotation_cap_ratio,
        )

    _print_stats(stats, n_rows=features.shape[0])

    # Warn about underrepresented classes — a head trained on fewer than
    # five examples will collapse onto whichever class it's seen most.
    low_classes = [
        label
        for label, count in (
            stats.audio_per_class
            + stats.annotation_per_class
            + stats.candidate_per_class
        ).items()
        if count < 5
    ]
    if low_classes:
        log.warning(
            "extract: classes with <5 examples (will be unreliable): %s",
            sorted(low_classes),
        )

    if args.dry_run:
        log.info("extract: --dry-run set, not writing cache")
        return 0

    out = pathlib.Path(args.out)
    write_cache(out, features=features, labels=labels, sources=sources, ids=ids)
    log.info("extract: wrote %s (%d rows)", out, features.shape[0])
    return 0


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Build the Pi-side classifier training cache from Postgres.",
    )
    p.add_argument(
        "--out",
        default="data/training/pi_cache.npz",
        help="Destination .npz path (default: data/training/pi_cache.npz)",
    )
    p.add_argument(
        "--annotation-cap-ratio",
        type=float,
        default=2.0,
        help=(
            "Annotation budget per class as a multiple of audio-backed "
            "event count. 0 disables annotations entirely. Default 2.0."
        ),
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print stats but don't write the cache.",
    )
    return p


def main() -> None:
    args = _build_parser().parse_args()
    raise SystemExit(asyncio.run(_amain(args)))


if __name__ == "__main__":
    main()

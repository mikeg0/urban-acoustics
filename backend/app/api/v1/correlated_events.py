"""Admin API for two-microphone event detection and labeling."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...auth.permissions import EVENT_CANDIDATE_MANAGE
from ...auth.user import AuthenticatedUser, require_permission
from ...contracts import (
    CandidateAudioFilter,
    CorrelatedEventCandidateListResponse,
    CorrelatedEventCandidatePatch,
    CorrelatedEventCandidateResponse,
    CorrelatedEventFrameResponse,
    CorrelatedEventFramesResponse,
    CorrelatedEventFrameStream,
    CorrelatedEventSettingsResponse,
    CorrelatedEventSettingsUpdate,
    EventLabel,
)
from ...db import get_session
from ...models import (
    CorrelatedEventCandidate,
    CorrelatedEventFrame,
    CorrelatedEventSettings,
    Device,
    User,
)


router = APIRouter()
ADMIN = Annotated[
    AuthenticatedUser, Depends(require_permission(EVENT_CANDIDATE_MANAGE))
]


def _settings_response(row: CorrelatedEventSettings) -> CorrelatedEventSettingsResponse:
    return CorrelatedEventSettingsResponse(
        enabled=row.enabled,
        outside_device_id=row.outside_device_id,
        inside_device_id=row.inside_device_id,
        metric=row.metric,  # type: ignore[arg-type]
        baseline_window_s=row.baseline_window_s,
        min_baseline_samples=row.min_baseline_samples,
        outside_rise_db=row.outside_rise_db,
        inside_rise_db=row.inside_rise_db,
        outside_min_db=row.outside_min_db,
        inside_min_db=row.inside_min_db,
        peak_merge_window_s=row.peak_merge_window_s,
        peak_cooldown_s=row.peak_cooldown_s,
        correlation_window_s=row.correlation_window_s,
        snapshot_before_s=row.snapshot_before_s,
        snapshot_after_s=row.snapshot_after_s,
        scan_interval_s=row.scan_interval_s,
        audio_match_window_s=row.audio_match_window_s,
        audio_grace_s=row.audio_grace_s,
        last_processed_at=(
            row.last_processed_at.timestamp() if row.last_processed_at else None
        ),
        updated_at=row.updated_at.timestamp(),
    )


@router.get(
    "/admin/correlated-events/settings",
    response_model=CorrelatedEventSettingsResponse,
)
async def get_settings(
    _admin: ADMIN, session: AsyncSession = Depends(get_session)
) -> CorrelatedEventSettingsResponse:
    row = await session.get(CorrelatedEventSettings, 1)
    if row is None:
        raise HTTPException(status_code=503, detail="detector settings are not initialized")
    return _settings_response(row)


@router.put(
    "/admin/correlated-events/settings",
    response_model=CorrelatedEventSettingsResponse,
)
async def update_settings(
    body: CorrelatedEventSettingsUpdate,
    admin: ADMIN,
    session: AsyncSession = Depends(get_session),
) -> CorrelatedEventSettingsResponse:
    row = await session.get(CorrelatedEventSettings, 1)
    if row is None:
        raise HTTPException(status_code=503, detail="detector settings are not initialized")
    for field, value in body.model_dump().items():
        setattr(row, field, value)
    row.updated_at = datetime.now(timezone.utc)
    row.updated_by = UUID(admin.user_id)
    await session.commit()
    await session.refresh(row)
    return _settings_response(row)


def _review_filter(kind: str):
    if kind == "pending":
        return and_(
            CorrelatedEventCandidate.label.is_(None),
            CorrelatedEventCandidate.dismissed.is_(False),
        )
    if kind == "labeled":
        return and_(
            CorrelatedEventCandidate.label.is_not(None),
            CorrelatedEventCandidate.dismissed.is_(False),
        )
    if kind == "dismissed":
        return CorrelatedEventCandidate.dismissed.is_(True)
    return None


def _candidate_response(
    row: CorrelatedEventCandidate,
    *,
    device_names: dict[UUID, str | None],
    reviewer_emails: dict[UUID, str],
    frame_counts: dict[UUID, int],
) -> CorrelatedEventCandidateResponse:
    return CorrelatedEventCandidateResponse(
        candidate_id=row.candidate_id,
        candidate_group=row.candidate_group,  # type: ignore[arg-type]
        outside_device_id=row.outside_device_id,
        outside_device_name=device_names.get(row.outside_device_id),
        inside_device_id=row.inside_device_id,
        inside_device_name=device_names.get(row.inside_device_id),
        metric=row.metric,  # type: ignore[arg-type]
        outside_peak_ts=row.outside_peak_ts.timestamp(),
        outside_peak_db=row.outside_peak_db,
        outside_baseline_db=row.outside_baseline_db,
        outside_rise_db=row.outside_rise_db,
        inside_peak_ts=row.inside_peak_ts.timestamp() if row.inside_peak_ts else None,
        inside_peak_db=row.inside_peak_db,
        inside_baseline_db=row.inside_baseline_db,
        inside_rise_db=row.inside_rise_db,
        snapshot_start=row.snapshot_start.timestamp(),
        snapshot_end=row.snapshot_end.timestamp(),
        outside_event_id=row.outside_event_id,
        audio_state=row.audio_state,  # type: ignore[arg-type]
        labelable=row.audio_state == "linked",
        label=row.label,  # type: ignore[arg-type]
        dismissed=row.dismissed,
        reviewed_by_email=reviewer_emails.get(row.reviewed_by) if row.reviewed_by else None,
        reviewed_at=row.reviewed_at.timestamp() if row.reviewed_at else None,
        created_at=row.created_at.timestamp(),
        frame_count=frame_counts.get(row.candidate_id, 0),
    )


async def _response_context(
    session: AsyncSession, rows: list[CorrelatedEventCandidate]
) -> tuple[dict[UUID, str | None], dict[UUID, str], dict[UUID, int]]:
    """Bulk-load display metadata for a candidate page (three queries total)."""

    if not rows:
        return {}, {}, {}
    device_ids = {
        device_id
        for row in rows
        for device_id in (row.outside_device_id, row.inside_device_id)
    }
    reviewer_ids = {row.reviewed_by for row in rows if row.reviewed_by is not None}
    candidate_ids = [row.candidate_id for row in rows]
    device_names = dict(
        (
            await session.execute(
                select(Device.device_id, Device.name).where(Device.device_id.in_(device_ids))
            )
        ).all()
    )
    reviewer_emails = (
        dict(
            (
                await session.execute(
                    select(User.user_id, User.email).where(User.user_id.in_(reviewer_ids))
                )
            ).all()
        )
        if reviewer_ids
        else {}
    )
    frame_counts = dict(
        (
            await session.execute(
                select(
                    CorrelatedEventFrame.candidate_id,
                    func.count(CorrelatedEventFrame.ts),
                )
                .where(CorrelatedEventFrame.candidate_id.in_(candidate_ids))
                .group_by(CorrelatedEventFrame.candidate_id)
            )
        ).all()
    )
    return device_names, reviewer_emails, frame_counts


async def _responses(
    session: AsyncSession, rows: list[CorrelatedEventCandidate]
) -> list[CorrelatedEventCandidateResponse]:
    device_names, reviewer_emails, frame_counts = await _response_context(session, rows)
    return [
        _candidate_response(
            row,
            device_names=device_names,
            reviewer_emails=reviewer_emails,
            frame_counts=frame_counts,
        )
        for row in rows
    ]


@router.get(
    "/admin/correlated-events/candidates",
    response_model=CorrelatedEventCandidateListResponse,
)
async def list_candidates(
    _admin: ADMIN,
    review: Literal["pending", "labeled", "dismissed", "all"] = Query("pending"),
    candidate_group: Literal["correlated", "outside_only"] | None = Query(None),
    label: EventLabel | None = Query(None),
    # Defaults to audio-backed candidates so the review queue only ever offers
    # work that can actually be labeled. 'pending'/'missing' are for diagnosing
    # device recording thresholds.
    audio: CandidateAudioFilter = Query("linked"),
    from_ts: float | None = Query(None, alias="from", gt=0),
    to_ts: float | None = Query(None, alias="to", gt=0),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(get_session),
) -> CorrelatedEventCandidateListResponse:
    conditions = []
    review_condition = _review_filter(review)
    if review_condition is not None:
        conditions.append(review_condition)
    if candidate_group is not None:
        conditions.append(CorrelatedEventCandidate.candidate_group == candidate_group)
    if label is not None:
        conditions.append(CorrelatedEventCandidate.label == label)
    if audio != "all":
        conditions.append(CorrelatedEventCandidate.audio_state == audio)
    if from_ts is not None:
        conditions.append(
            CorrelatedEventCandidate.outside_peak_ts
            >= datetime.fromtimestamp(from_ts, timezone.utc)
        )
    if to_ts is not None:
        conditions.append(
            CorrelatedEventCandidate.outside_peak_ts
            < datetime.fromtimestamp(to_ts, timezone.utc)
        )

    base = select(CorrelatedEventCandidate)
    count_stmt = select(func.count()).select_from(CorrelatedEventCandidate)
    if conditions:
        base = base.where(*conditions)
        count_stmt = count_stmt.where(*conditions)
    rows = await session.execute(
        base.order_by(CorrelatedEventCandidate.outside_peak_ts.desc())
        .offset(offset)
        .limit(limit)
    )
    total = int(await session.scalar(count_stmt) or 0)
    # Queue-wide (unfiltered) tallies: reviewable work versus candidates held up
    # or lost for lack of an outside clip.
    unreviewed = and_(
        CorrelatedEventCandidate.label.is_(None),
        CorrelatedEventCandidate.dismissed.is_(False),
    )
    tallies = (
        await session.execute(
            select(
                func.count()
                .filter(
                    unreviewed, CorrelatedEventCandidate.audio_state == "linked"
                )
                .label("pending"),
                func.count()
                .filter(
                    unreviewed, CorrelatedEventCandidate.audio_state == "pending"
                )
                .label("awaiting_audio"),
                func.count()
                .filter(CorrelatedEventCandidate.audio_state == "missing")
                .label("missing_audio"),
            ).select_from(CorrelatedEventCandidate)
        )
    ).one()
    items = await _responses(session, list(rows.scalars()))
    return CorrelatedEventCandidateListResponse(
        items=items,
        total=total,
        pending=int(tallies.pending or 0),
        awaiting_audio=int(tallies.awaiting_audio or 0),
        missing_audio=int(tallies.missing_audio or 0),
    )


@router.get(
    "/admin/correlated-events/candidates/{candidate_id}",
    response_model=CorrelatedEventCandidateResponse,
)
async def get_candidate(
    candidate_id: UUID,
    _admin: ADMIN,
    session: AsyncSession = Depends(get_session),
) -> CorrelatedEventCandidateResponse:
    row = await session.get(CorrelatedEventCandidate, candidate_id)
    if row is None:
        raise HTTPException(status_code=404, detail="candidate not found")
    return (await _responses(session, [row]))[0]


@router.patch(
    "/admin/correlated-events/candidates/{candidate_id}",
    response_model=CorrelatedEventCandidateResponse,
)
async def review_candidate(
    candidate_id: UUID,
    body: CorrelatedEventCandidatePatch,
    admin: ADMIN,
    session: AsyncSession = Depends(get_session),
) -> CorrelatedEventCandidateResponse:
    row = await session.get(CorrelatedEventCandidate, candidate_id)
    if row is None:
        raise HTTPException(status_code=404, detail="candidate not found")
    if "label" in body.model_fields_set:
        # Weather buffeting and genuine sources are not reliably separable by
        # eye, so a label is only trustworthy if the reviewer could play the
        # outside clip. The matching DB CHECK is the backstop; this is the
        # readable error.
        if body.label is not None and row.audio_state != "linked":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "labeling requires outdoor audio: this candidate's clip is "
                    f"{row.audio_state} (dismiss it instead)"
                ),
            )
        row.label = body.label
        if body.label is not None:
            row.dismissed = False
    if body.dismissed is not None:
        row.dismissed = body.dismissed
        if body.dismissed:
            row.label = None
    row.reviewed_by = UUID(admin.user_id)
    row.reviewed_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(row)
    return (await _responses(session, [row]))[0]


@router.get(
    "/admin/correlated-events/candidates/{candidate_id}/frames",
    response_model=CorrelatedEventFramesResponse,
)
async def get_candidate_frames(
    candidate_id: UUID,
    _admin: ADMIN,
    session: AsyncSession = Depends(get_session),
) -> CorrelatedEventFramesResponse:
    candidate = await session.get(CorrelatedEventCandidate, candidate_id)
    if candidate is None:
        raise HTTPException(status_code=404, detail="candidate not found")
    devices = (candidate.outside_device_id, candidate.inside_device_id)
    names = dict(
        (
            await session.execute(
                select(Device.device_id, Device.name).where(Device.device_id.in_(devices))
            )
        ).all()
    )
    rows = (
        await session.execute(
            select(CorrelatedEventFrame)
            .where(CorrelatedEventFrame.candidate_id == candidate_id)
            .order_by(CorrelatedEventFrame.device_id, CorrelatedEventFrame.ts)
        )
    ).scalars()
    grouped: dict[UUID, list[CorrelatedEventFrameResponse]] = {
        device_id: [] for device_id in devices
    }
    for frame in rows:
        grouped[frame.device_id].append(
            CorrelatedEventFrameResponse(
                ts=frame.ts.timestamp(), bands=[float(v) for v in frame.bands]
            )
        )
    return CorrelatedEventFramesResponse(
        candidate_id=candidate_id,
        snapshot_start=candidate.snapshot_start.timestamp(),
        snapshot_end=candidate.snapshot_end.timestamp(),
        streams=[
            CorrelatedEventFrameStream(
                device_id=device_id,
                device_name=names.get(device_id),
                frames=grouped[device_id],
            )
            for device_id in devices
        ],
    )

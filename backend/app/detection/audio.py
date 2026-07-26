"""Attach the outside microphone's audio clip to detected candidates.

A reviewer cannot separate wind buffeting from a passing truck by looking at a
spectrogram, so a candidate is only labelable once its outside clip can be
played back. Detection and linking are separate passes because the device
announces and uploads a clip several seconds *after* the event ends, which is
after the detector has already written the candidate row.

Candidates therefore move ``pending -> linked`` when a clip shows up, or
``pending -> missing`` once the grace window closes. A large ``missing`` count
means the device's own ``event_threshold_db`` is above the cloud detector's
floor and quiet peaks are never being recorded.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


log = logging.getLogger("urban-acoustics.detection")

# How far back a candidate is still re-checked for audio. Uploads can stall for
# hours ('announced' with no bytes) and land only once the device drains its
# spool, so 'missing' is provisional rather than final within this window and a
# recovered upload puts the candidate back in the queue. It must always exceed
# the grace window, otherwise candidates get retired before they are ever
# hunted for.
RELINK_WINDOW = timedelta(hours=24)


# Picks the overlapping outside clip whose start is closest to the peak. Only
# clips with bytes in object storage qualify: 'announced' and
# 'upload_intent_created' rows have no audio to play yet, and 'failed' never
# will. 'uploaded' is accepted because the flip to 'available' happens lazily
# on the first playback request.
_LINK_SQL = text(
    """
    UPDATE correlated_event_candidates AS c
    SET outside_event_id = picked.event_id,
        audio_state = 'linked'
    FROM (
        SELECT cand.candidate_id, chosen.event_id
        FROM correlated_event_candidates AS cand
        CROSS JOIN LATERAL (
            SELECT ev.event_id
            FROM events AS ev
            WHERE ev.device_id = cand.outside_device_id
              AND ev.storage_key IS NOT NULL
              AND ev.status IN ('uploaded', 'available')
              AND ev.ts < cand.outside_peak_ts + make_interval(secs => :match_window_s)
              AND ev.ts + make_interval(secs => ev.duration_s)
                  > cand.outside_peak_ts - make_interval(secs => :match_window_s)
            ORDER BY abs(extract(epoch FROM (ev.ts - cand.outside_peak_ts)))
            LIMIT 1
        ) AS chosen
        -- Includes rows already marked 'missing': a stalled upload that finally
        -- lands should return the candidate to the queue. Bounded by
        -- RELINK_WINDOW so this stays a small recent sweep, and deliberately
        -- reaching further back than the grace deadline so nothing is retired
        -- before it has been hunted for.
        WHERE cand.audio_state <> 'linked'
          AND cand.outside_peak_ts >= :relink_since
    ) AS picked
    WHERE c.candidate_id = picked.candidate_id
    """
)

_EXPIRE_SQL = text(
    """
    UPDATE correlated_event_candidates
    SET audio_state = 'missing'
    WHERE audio_state = 'pending'
      AND outside_peak_ts < :deadline
    """
)


def grace_deadline(now: datetime, *, grace_s: int) -> datetime:
    """Peaks older than this stop counting as merely awaiting an upload."""

    return now - timedelta(seconds=grace_s)


def relink_since(now: datetime, *, grace_s: int) -> datetime:
    """Oldest peak still re-checked for late-arriving audio.

    Scales with the configured grace so the sweep always reaches further back
    than :func:`grace_deadline`, even when an operator sets a very long grace.
    """

    return now - max(RELINK_WINDOW, timedelta(seconds=grace_s * 2))


async def link_candidate_audio(
    session: AsyncSession,
    *,
    match_window_s: int,
    grace_s: int,
    now: datetime,
) -> tuple[int, int]:
    """Link newly available clips, then expire the ones that never arrived.

    Linking runs first so a clip that lands right on the deadline is still
    attached rather than lost. Returns ``(linked, expired)`` row counts. Does
    not commit; the caller commits alongside the rest of its cycle.
    """

    linked = await session.execute(
        _LINK_SQL,
        {
            "match_window_s": match_window_s,
            "relink_since": relink_since(now, grace_s=grace_s),
        },
    )
    expired = await session.execute(
        _EXPIRE_SQL, {"deadline": grace_deadline(now, grace_s=grace_s)}
    )
    linked_count = linked.rowcount or 0
    expired_count = expired.rowcount or 0
    if linked_count or expired_count:
        log.info(
            "detector: audio linked=%d expired=%d", linked_count, expired_count
        )
    return linked_count, expired_count

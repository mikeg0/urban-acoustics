"""Timing rules for attaching outside audio to a detected candidate.

A candidate is only labelable once its outside clip is playable, so these two
windows decide whether a slow upload still gets linked or is written off as
missing.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.detection.audio import grace_deadline, relink_since


NOW = datetime(2026, 7, 25, 12, 0, tzinfo=timezone.utc)
DEFAULT_GRACE = 3600


def test_slow_upload_stays_pending() -> None:
    # Uploads from the field node trail the event by ~6 s (p50) and up to ~20 s
    # in normal operation, all of which must stay inside the grace window.
    deadline = grace_deadline(NOW, grace_s=DEFAULT_GRACE)
    assert NOW - timedelta(seconds=20) > deadline


def test_spooled_upload_after_network_outage_stays_pending() -> None:
    # A node that loses its network spools clips and drains them when it
    # recovers; half an hour late must still be linkable, not written off.
    deadline = grace_deadline(NOW, grace_s=DEFAULT_GRACE)
    assert NOW - timedelta(minutes=30) > deadline


def test_peak_older_than_grace_is_retired() -> None:
    deadline = grace_deadline(NOW, grace_s=DEFAULT_GRACE)
    assert NOW - timedelta(seconds=DEFAULT_GRACE + 1) < deadline


def test_grace_window_is_measured_from_now() -> None:
    assert (NOW - grace_deadline(NOW, grace_s=600)).total_seconds() == 600


@pytest.mark.parametrize("grace_s", [10, 600, 3600, 43_200, 86_400])
def test_relink_always_reaches_further_back_than_retirement(grace_s: int) -> None:
    # The invariant that matters, across the full configurable grace range:
    # anything the expiry pass can retire must still be inside the re-link
    # sweep. Violating it retires candidates before their audio is ever looked
    # for, permanently losing labelable work.
    assert relink_since(NOW, grace_s=grace_s) < grace_deadline(NOW, grace_s=grace_s)


def test_stalled_upload_that_lands_late_is_still_recoverable() -> None:
    # Uploads seen stuck in 'announced' for minutes then completing must not be
    # written off: a peak from an hour ago stays inside the re-link sweep.
    assert NOW - timedelta(hours=1) > relink_since(NOW, grace_s=DEFAULT_GRACE)

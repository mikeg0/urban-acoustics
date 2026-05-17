"""Event detector with hysteresis and pre/post-roll windowing.

Phase 1 trigger is dumb on purpose: ``LAFmax`` (already calibrated) crosses
a threshold. We add hysteresis on the close side so a noise that brushes
the threshold once doesn't generate dozens of overlapping events, plus a
minimum duration to filter spurious blips and a maximum duration to truncate
runaway events (e.g. the mic catching road noise for an hour).

The detector consumes one telemetry sample per second and emits at most one
:class:`EventCandidate` per closed event. The supervisor is responsible for
turning that into a FLAC encode + upload.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass


log = logging.getLogger(__name__)


@dataclass(frozen=True)
class EventCandidate:
    start_ts: float          # earliest sample time including pre-roll
    end_ts: float            # latest sample time including post-roll
    triggered_ts: float      # ts of the sample that opened the event
    closed_ts: float         # ts of the sample that closed it
    duration_s: float        # end_ts - start_ts
    peak_db: float           # max LAFmax across the open window


class EventDetector:
    def __init__(
        self,
        *,
        threshold_db: float,
        hysteresis_db: float,
        min_duration_s: float,
        max_duration_s: float,
        pre_roll_s: float,
        post_roll_s: float,
        cooldown_s: float,
    ) -> None:
        self.threshold_db = threshold_db
        self.close_db = threshold_db - hysteresis_db
        self.min_duration_s = min_duration_s
        self.max_duration_s = max_duration_s
        self.pre_roll_s = pre_roll_s
        self.post_roll_s = post_roll_s
        self.cooldown_s = cooldown_s

        self._open_at: float | None = None
        self._open_peak_db: float = -float("inf")
        self._last_above_ts: float | None = None
        self._last_event_closed_at: float | None = None

    def feed(self, *, ts: float, lafmax_db: float) -> EventCandidate | None:
        """Update detector state with a new 1 s sample. Returns a candidate
        when an event closes, otherwise None.
        """
        in_cooldown = (
            self._last_event_closed_at is not None
            and (ts - self._last_event_closed_at) < self.cooldown_s
        )

        if lafmax_db >= self.threshold_db:
            if self._open_at is None and not in_cooldown:
                self._open_at = ts
                self._open_peak_db = lafmax_db
                log.info("detector: event opened at %.3f (lafmax=%.1f dB)", ts, lafmax_db)
            elif self._open_at is not None:
                self._open_peak_db = max(self._open_peak_db, lafmax_db)
            self._last_above_ts = ts

        # Force-close runaway events even if the signal stays loud.
        if self._open_at is not None and (ts - self._open_at) >= self.max_duration_s:
            log.info("detector: max-duration close at %.3f", ts)
            return self._close(ts)

        if self._open_at is not None and lafmax_db < self.close_db:
            duration = ts - self._open_at
            if duration >= self.min_duration_s:
                return self._close(ts)
            # Drop short blips silently — they would just churn the queue.
            log.debug("detector: dropped short event (%.2fs) at %.3f", duration, ts)
            self._reset_open()
        return None

    def _close(self, ts: float) -> EventCandidate:
        assert self._open_at is not None
        cand = EventCandidate(
            start_ts=self._open_at - self.pre_roll_s,
            end_ts=ts + self.post_roll_s,
            triggered_ts=self._open_at,
            closed_ts=ts,
            duration_s=(ts + self.post_roll_s) - (self._open_at - self.pre_roll_s),
            peak_db=self._open_peak_db,
        )
        self._last_event_closed_at = ts
        self._reset_open()
        log.info(
            "detector: event closed ts=%.3f duration=%.2fs peak=%.1f dB",
            ts, cand.duration_s, cand.peak_db,
        )
        return cand

    def _reset_open(self) -> None:
        self._open_at = None
        self._open_peak_db = -float("inf")

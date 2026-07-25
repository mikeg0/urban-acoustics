"""Pure adaptive-baseline peak detection and two-stream correlation."""

from __future__ import annotations

import bisect
import dataclasses
from collections import deque
from datetime import datetime
from statistics import median


@dataclasses.dataclass(frozen=True, slots=True)
class Sample:
    ts: datetime
    value: float


@dataclasses.dataclass(frozen=True, slots=True)
class Peak:
    ts: datetime
    value: float
    baseline: float
    rise: float


def adaptive_peaks(
    samples: list[Sample],
    *,
    baseline_window_s: int,
    min_baseline_samples: int,
    rise_db: float,
    min_db: float,
    merge_window_s: int,
    cooldown_s: int,
) -> list[Peak]:
    """Return peaks that rise above the trailing rolling median.

    The current sample is excluded from its own baseline. Consecutive
    threshold crossings within ``merge_window_s`` collapse to the strongest
    crossing. Peaks inside the cooldown window also collapse, keeping the
    larger rise, so a single long event cannot flood the review queue.
    """

    ordered = sorted(samples, key=lambda p: p.ts)
    window: deque[tuple[datetime, float]] = deque()
    sorted_values: list[float] = []
    crossings: list[Peak] = []

    for sample in ordered:
        cutoff = sample.ts.timestamp() - baseline_window_s
        while window and window[0][0].timestamp() < cutoff:
            _, old = window.popleft()
            idx = bisect.bisect_left(sorted_values, old)
            if idx < len(sorted_values):
                sorted_values.pop(idx)

        if len(sorted_values) >= min_baseline_samples:
            base = float(median(sorted_values))
            rise = sample.value - base
            if sample.value >= min_db and rise >= rise_db:
                crossings.append(
                    Peak(ts=sample.ts, value=sample.value, baseline=base, rise=rise)
                )

        window.append((sample.ts, sample.value))
        bisect.insort(sorted_values, sample.value)

    if not crossings:
        return []

    clusters: list[list[Peak]] = [[crossings[0]]]
    for crossing in crossings[1:]:
        gap = (crossing.ts - clusters[-1][-1].ts).total_seconds()
        if gap <= merge_window_s:
            clusters[-1].append(crossing)
        else:
            clusters.append([crossing])

    merged = [max(group, key=lambda p: (p.rise, p.value)) for group in clusters]
    cooled: list[Peak] = []
    for peak in merged:
        if cooled and (peak.ts - cooled[-1].ts).total_seconds() <= cooldown_s:
            # Cooldown is deliberately first-peak-wins. Replacing an already
            # emitted peak with a stronger later one would create a second DB
            # candidate when the same event straddles two polling cycles.
            continue
        else:
            cooled.append(peak)
    return cooled


def correlate_peak(
    outside: Peak, inside_peaks: list[Peak], *, window_s: int
) -> Peak | None:
    """Choose the closest inside peak in ``outside.ts ± window_s``."""

    matches = [
        peak
        for peak in inside_peaks
        if abs((peak.ts - outside.ts).total_seconds()) <= window_s
    ]
    if not matches:
        return None
    return min(
        matches,
        key=lambda peak: (abs((peak.ts - outside.ts).total_seconds()), -peak.rise),
    )

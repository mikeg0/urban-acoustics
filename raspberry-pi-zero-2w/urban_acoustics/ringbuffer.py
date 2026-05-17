"""Pre-roll ring buffer for event audio extraction.

The detector wants the few seconds of audio leading up to a triggered event
in addition to the seconds after it. A small circular buffer over int32
samples is enough — at 48 kHz mono we keep ~5 s in roughly 1 MiB of RAM,
well inside the Pi Zero 2 W budget.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class _Block:
    samples: np.ndarray
    ts: float


class AudioRingBuffer:
    """Append-only window of recent PCM blocks indexed by block start time.

    Blocks are stored as-is (int32 mono). ``extract(start_ts, end_ts)``
    returns a contiguous int32 array covering ``[start_ts, end_ts)`` if the
    range is wholly within the buffer, or the largest available subrange
    otherwise. The caller is expected to log when the window is incomplete.
    """

    def __init__(self, *, sample_rate: int, seconds: float) -> None:
        self.sample_rate = sample_rate
        self.capacity_samples = int(round(sample_rate * seconds))
        self._blocks: list[_Block] = []
        self._total_samples = 0

    def append(self, samples: np.ndarray, ts: float) -> None:
        self._blocks.append(_Block(samples=samples, ts=ts))
        self._total_samples += len(samples)
        # Evict oldest blocks once we exceed capacity.
        while self._blocks and (self._total_samples - len(self._blocks[0].samples)) >= self.capacity_samples:
            evicted = self._blocks.pop(0)
            self._total_samples -= len(evicted.samples)

    def earliest_ts(self) -> float | None:
        if not self._blocks:
            return None
        return self._blocks[0].ts

    def latest_ts(self) -> float | None:
        if not self._blocks:
            return None
        last = self._blocks[-1]
        return last.ts + len(last.samples) / self.sample_rate

    def extract(self, start_ts: float, end_ts: float) -> tuple[np.ndarray, float]:
        """Return ``(samples, actual_start_ts)`` for the requested window.

        Clipped to the available window if the buffer does not yet cover the
        full range. The returned array is a fresh copy — safe to encode and
        free without disturbing the live buffer.
        """
        if end_ts <= start_ts or not self._blocks:
            return np.empty(0, dtype=np.int32), start_ts

        out: list[np.ndarray] = []
        actual_start_ts: float | None = None
        for block in self._blocks:
            block_start = block.ts
            block_end = block.ts + len(block.samples) / self.sample_rate
            if block_end <= start_ts:
                continue
            if block_start >= end_ts:
                break
            lo_t = max(block_start, start_ts)
            hi_t = min(block_end, end_ts)
            lo_idx = int(round((lo_t - block_start) * self.sample_rate))
            hi_idx = int(round((hi_t - block_start) * self.sample_rate))
            if hi_idx <= lo_idx:
                continue
            out.append(block.samples[lo_idx:hi_idx])
            if actual_start_ts is None:
                actual_start_ts = block_start + lo_idx / self.sample_rate

        if not out:
            return np.empty(0, dtype=np.int32), start_ts
        return np.concatenate(out), actual_start_ts if actual_start_ts is not None else start_ts

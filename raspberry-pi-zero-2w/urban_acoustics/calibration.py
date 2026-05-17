"""Calibration helpers.

The DSP path computes RMS / peak values from samples normalised to ``[-1, 1]``.
We turn those into dB SPL by adding a per-mic sensitivity offset and a per-
device trim. Both numbers live in :class:`urban_acoustics.config.Config`; this
module just exposes them as a single dataclass so the DSP layer does not have
to know about the rest of the config.
"""

from __future__ import annotations

from dataclasses import dataclass

from .config import Config


@dataclass(frozen=True)
class Calibration:
    sensitivity_offset_db: float
    mic_gain_db: float

    @property
    def total_offset_db(self) -> float:
        return self.sensitivity_offset_db + self.mic_gain_db


def from_config(cfg: Config) -> Calibration:
    return Calibration(
        sensitivity_offset_db=cfg.sensitivity_offset_db,
        mic_gain_db=cfg.mic_gain_db,
    )

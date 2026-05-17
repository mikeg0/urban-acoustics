"""arecord-based PCM capture.

We deliberately keep ``arecord`` as the capture mechanism for Phase 1:

* It is the path the recorder has already been validated against, so the I2S
  config (``asoundrc``, googlevoicehat overlay, ALSA softvol) does not need
  to change for the firmware switch-over.
* It survives ALSA hiccups better than a long-lived PyAlsaAudio handle, which
  in our testing leaks file descriptors after a card reset.

The capture loop spawns one ``arecord`` subprocess, reads raw PCM from its
stdout in fixed-size blocks, and emits :class:`PcmBlock` objects with a
timestamp marking the *start* of the block. On EOF or process death the
loop restarts the subprocess with exponential backoff (capped) so a stuck
soundcard cannot wedge the supervisor.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass

import numpy as np


log = logging.getLogger(__name__)


# Use S32_LE → 4 bytes/sample. INMP441 packs 24 valid bits in the high bits
# of each word; the low 8 are zero. We keep the full word and scale at the
# DSP layer so any future microphone change is a calibration tweak only.
_BYTES_PER_SAMPLE = 4


@dataclass(frozen=True)
class PcmBlock:
    """One block of mono PCM samples.

    ``samples`` is an ``int32`` array of length ``samples_per_block``.
    ``ts`` is the wall-clock time at the *start* of the block. We do not
    try to recover sub-block sample timing — at 48 kHz a block is 1 s
    of audio and a few ms of jitter is invisible at 1 Hz telemetry.
    """

    samples: np.ndarray
    ts: float
    sample_rate: int


class AudioCapture:
    def __init__(
        self,
        *,
        alsa_device: str,
        sample_rate: int,
        channels: int,
        pcm_format: str,
        block_seconds: float,
    ) -> None:
        if channels != 1:
            # Phase 1 firmware is mono. The simulator follows the same shape.
            raise ValueError(f"only mono capture is supported (got channels={channels})")
        if pcm_format != "S32_LE":
            raise ValueError(f"only S32_LE is supported (got {pcm_format})")
        self.alsa_device = alsa_device
        self.sample_rate = sample_rate
        self.channels = channels
        self.pcm_format = pcm_format
        self.samples_per_block = int(round(sample_rate * block_seconds))
        self.bytes_per_block = self.samples_per_block * _BYTES_PER_SAMPLE * channels

        self._proc: asyncio.subprocess.Process | None = None
        self._restarts = 0
        self._last_block_at: float | None = None

    @property
    def restart_count(self) -> int:
        return self._restarts

    async def _spawn(self) -> asyncio.subprocess.Process:
        cmd = [
            "arecord",
            "-q",                             # quiet
            "-D", self.alsa_device,
            "-c", str(self.channels),
            "-r", str(self.sample_rate),
            "-f", self.pcm_format,
            "-t", "raw",
            "-",
        ]
        log.info("capture: spawning %s", " ".join(cmd))
        return await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

    async def _read_exact(self, n: int) -> bytes | None:
        """Read exactly ``n`` bytes from stdout, returning None on EOF.

        ``asyncio.StreamReader.readexactly`` raises :class:`IncompleteReadError`
        on EOF; we want a clean None so the outer loop can restart arecord.
        """
        assert self._proc is not None and self._proc.stdout is not None
        try:
            return await self._proc.stdout.readexactly(n)
        except asyncio.IncompleteReadError as exc:
            if exc.partial:
                log.warning("capture: short read %d/%d bytes before EOF", len(exc.partial), n)
            return None

    async def blocks(self, stop_event: asyncio.Event):
        """Async generator of :class:`PcmBlock`. Restarts arecord on failure."""
        backoff = 1.0
        while not stop_event.is_set():
            try:
                self._proc = await self._spawn()
            except FileNotFoundError:
                log.error("capture: arecord not installed (apt install alsa-utils)")
                # No point retrying — fail fast so systemd surfaces it.
                raise

            while not stop_event.is_set():
                raw = await self._read_exact(self.bytes_per_block)
                if raw is None:
                    break
                ts = time.time()
                samples = np.frombuffer(raw, dtype="<i4")
                self._last_block_at = ts
                yield PcmBlock(samples=samples, ts=ts, sample_rate=self.sample_rate)
                # Reset backoff once we are reliably delivering blocks.
                backoff = 1.0

            # arecord exited or stop requested. Drain stderr for the log.
            await self._terminate()
            if stop_event.is_set():
                return
            self._restarts += 1
            log.warning("capture: arecord exited, restart #%d in %.1fs", self._restarts, backoff)
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=backoff)
                return
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2.0, 30.0)

    async def _terminate(self) -> None:
        proc = self._proc
        if proc is None:
            return
        stderr_tail = b""
        if proc.stderr is not None:
            try:
                stderr_tail = await asyncio.wait_for(proc.stderr.read(2048), timeout=0.5)
            except asyncio.TimeoutError:
                pass
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
        if stderr_tail:
            log.warning("capture: arecord stderr tail: %s", stderr_tail.decode(errors="replace").strip())
        log.info("capture: arecord exited rc=%s", proc.returncode)
        self._proc = None

    @property
    def last_block_at(self) -> float | None:
        return self._last_block_at

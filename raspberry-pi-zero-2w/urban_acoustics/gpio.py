"""Sysfs-based GPIO output driver for the identify-LED.

Sysfs is deprecated by upstream in favour of libgpiod, but it's still
present on Raspberry Pi OS Bookworm/Trixie and avoids adding a native
dependency to the firmware install. The systemd unit grants ``gpio``
group access and a sysfs read-write override so this module can run
unprivileged.

The constructor takes a BCM line number (the pin label users know);
``_resolve_sysfs_offset`` translates it to the absolute sysfs gpioN
id at runtime by reading the chip's ``base`` — modern Pi kernels offset
gpio_base above 0 (512 on bcm2835 under kernel 6.x, different again on
the Pi 5 RP1), so writing the bare BCM number to ``export`` returns
EINVAL.
"""

from __future__ import annotations

import logging
import os
import pathlib
import threading
import time


log = logging.getLogger(__name__)

_GPIO_SYSFS = pathlib.Path("/sys/class/gpio")


def _resolve_sysfs_offset(bcm_line: int) -> int:
    candidates: list[tuple[str, int, int]] = []
    for chip in _GPIO_SYSFS.glob("gpiochip*"):
        if not chip.is_dir():
            continue
        try:
            label = (chip / "label").read_text().strip()
            base = int((chip / "base").read_text().strip())
            ngpio = int((chip / "ngpio").read_text().strip())
        except OSError:
            continue
        candidates.append((label, base, ngpio))

    def _pick(pred) -> int | None:
        for label, base, ngpio in candidates:
            if pred(label, ngpio) and 0 <= bcm_line < ngpio:
                return base + bcm_line
        return None

    # Prefer the bcm/rp1 header controller; fall back to any chip wide enough
    # to cover the 40-pin header (>=28 lines).
    for pred in (
        lambda lbl, _: "bcm" in lbl.lower() or "rp1" in lbl.lower(),
        lambda _, n: n >= 28,
    ):
        result = _pick(pred)
        if result is not None:
            return result
    raise OSError(f"no suitable gpiochip found for BCM line {bcm_line}")


class LedController:
    """Single-line GPIO driver. Exports the line lazily on first use."""

    def __init__(self, bcm_line: int) -> None:
        self._bcm = bcm_line
        self._lock = threading.Lock()
        self._ready = False
        self._sysfs_id: int | None = None
        self._pin_dir: pathlib.Path | None = None

    def _ensure_ready(self) -> None:
        if self._ready:
            return
        sysfs_id = _resolve_sysfs_offset(self._bcm)
        pin_dir = _GPIO_SYSFS / f"gpio{sysfs_id}"
        if not pin_dir.exists():
            try:
                (_GPIO_SYSFS / "export").write_text(str(sysfs_id))
            except OSError as exc:
                # EBUSY is the kernel's way of saying "already exported";
                # everything else is a real error.
                if not pin_dir.exists():
                    raise
                log.debug("bcm%d (sysfs %d): export reported %s — already up",
                          self._bcm, sysfs_id, exc)
        # Race: the kernel creates `direction` root-owned, then udev fires a
        # rule that chgrps it to the `gpio` group. The first write can land
        # before udev does, returning EACCES. Poll briefly for write access.
        direction = pin_dir / "direction"
        deadline = time.monotonic() + 1.0
        while not os.access(direction, os.W_OK):
            if time.monotonic() >= deadline:
                break
            time.sleep(0.02)
        direction.write_text("out")
        self._sysfs_id = sysfs_id
        self._pin_dir = pin_dir
        self._ready = True
        log.info("gpio: BCM%d resolved to sysfs gpio%d", self._bcm, sysfs_id)

    def set_state(self, on: bool) -> None:
        with self._lock:
            self._ensure_ready()
            assert self._pin_dir is not None
            (self._pin_dir / "value").write_text("1" if on else "0")

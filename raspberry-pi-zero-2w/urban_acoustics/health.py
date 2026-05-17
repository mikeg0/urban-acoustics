"""Per-minute health publisher.

Reads system stats from ``/proc`` and ``/sys`` and combines them with the
queue depth from :class:`QueueStore`. The contract requires every field in
the Health schema; if a value is unavailable (no chrony, no wifi) we emit
a sentinel rather than skipping the message so the cloud can still
distinguish "device alive but degraded" from "device offline".
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from uuid import UUID

from .config import Config
from .queue_store import PRIO_HEALTH, QueueStore
from .transport import MqttTransport, health_topic


log = logging.getLogger(__name__)


_PROC_STAT_PATH = "/proc/stat"
_PROC_MEMINFO_PATH = "/proc/meminfo"
_PROC_WIRELESS_PATH = "/proc/net/wireless"
_THERMAL_ZONE = "/sys/class/thermal/thermal_zone0/temp"


@dataclass
class _CpuSample:
    total: int
    idle: int


def _read_cpu_sample() -> _CpuSample | None:
    try:
        with open(_PROC_STAT_PATH, "r") as f:
            line = f.readline()
    except OSError:
        return None
    parts = line.split()
    if not parts or parts[0] != "cpu":
        return None
    nums = [int(p) for p in parts[1:]]
    if len(nums) < 5:
        return None
    idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
    return _CpuSample(total=sum(nums), idle=idle)


def _read_cpu_temp_c() -> float:
    try:
        with open(_THERMAL_ZONE, "r") as f:
            millideg = int(f.read().strip())
        return millideg / 1000.0
    except (OSError, ValueError):
        return 0.0


def _read_mem_used_mb() -> float:
    try:
        info: dict[str, int] = {}
        with open(_PROC_MEMINFO_PATH, "r") as f:
            for line in f:
                key, _, rest = line.partition(":")
                value = rest.strip().split()
                if value and value[0].isdigit():
                    info[key] = int(value[0])  # KiB
        total = info.get("MemTotal", 0)
        avail = info.get("MemAvailable", info.get("MemFree", 0))
        return max(0.0, (total - avail) / 1024.0)
    except OSError:
        return 0.0


def _read_disk_free_mb(path: str) -> float:
    try:
        usage = shutil.disk_usage(path)
        return usage.free / (1024.0 * 1024.0)
    except OSError:
        return 0.0


def _read_wifi_rssi_dbm() -> float:
    """Parse /proc/net/wireless. Format:

        Inter-| sta-|   Quality        |   Discarded packets ...
         face | tus | link level noise | nwid  crypt   frag ...
         wlan0: 0000   70.  -55.  -256   0   0   0   0   0   0

    Column 4 (after ``: 0000   N.``) is the signal level in dBm.
    Returns 0.0 if unavailable (sentinel: no real WiFi reads 0 dBm).
    """
    try:
        with open(_PROC_WIRELESS_PATH, "r") as f:
            lines = f.read().splitlines()
    except OSError:
        return 0.0
    for line in lines[2:]:
        if ":" not in line:
            continue
        # Skip the status column then read the signed integer (link/level).
        parts = re.split(r"\s+", line.strip())
        if len(parts) < 4:
            continue
        try:
            # parts[0] = "wlan0:", parts[1] = status, parts[2] = link, parts[3] = level
            return float(parts[3].rstrip("."))
        except ValueError:
            continue
    return 0.0


def _read_ntp_offset_ms() -> float:
    """Best-effort parse of ``chronyc tracking``. Returns 0.0 if chrony is
    not present or the offset cannot be read."""
    if shutil.which("chronyc") is None:
        return 0.0
    try:
        proc = subprocess.run(
            ["chronyc", "-c", "tracking"],
            capture_output=True, text=True, timeout=2.0, check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return 0.0
    if proc.returncode != 0 or not proc.stdout:
        return 0.0
    # CSV: refid,stratum,ref_time,system_time_offset,last_offset,...
    fields = proc.stdout.strip().split(",")
    if len(fields) < 5:
        return 0.0
    try:
        # system_time_offset is seconds (float) — convert to ms.
        return float(fields[4]) * 1000.0
    except ValueError:
        return 0.0


class HealthPublisher:
    def __init__(
        self,
        *,
        device_id: UUID,
        cfg: Config,
        mqtt: MqttTransport,
        queue: QueueStore,
        started_at: float,
    ) -> None:
        self._device_id = device_id
        self._cfg = cfg
        self._mqtt = mqtt
        self._queue = queue
        self._topic = health_topic(device_id)
        self._started_at = started_at
        self._prev_cpu: _CpuSample | None = _read_cpu_sample()

    def _cpu_pct(self) -> float:
        now = _read_cpu_sample()
        if now is None or self._prev_cpu is None:
            self._prev_cpu = now
            return 0.0
        total_delta = now.total - self._prev_cpu.total
        idle_delta = now.idle - self._prev_cpu.idle
        self._prev_cpu = now
        if total_delta <= 0:
            return 0.0
        pct = 100.0 * (1.0 - idle_delta / total_delta)
        return max(0.0, min(100.0, pct))

    async def emit(self) -> None:
        now = time.time()
        queue_depth, queue_bytes = await self._queue.stats()
        payload_dict = {
            "ts": now,
            "uptime_s": max(0.0, now - self._started_at),
            "cpu_pct": self._cpu_pct(),
            "cpu_temp_c": _read_cpu_temp_c(),
            "mem_used_mb": _read_mem_used_mb(),
            "disk_free_mb": _read_disk_free_mb(str(self._cfg.data_dir)),
            "wifi_rssi_dbm": _read_wifi_rssi_dbm(),
            "queue_depth": int(queue_depth),
            "queue_bytes": int(queue_bytes),
            "mic_gain_db": float(self._cfg.mic_gain_db),
            "ntp_offset_ms": _read_ntp_offset_ms(),
            "fw_version": self._cfg.fw_version,
            "config_version": self._cfg.config_version,
        }
        payload = json.dumps(payload_dict, separators=(",", ":"))
        if self._mqtt.connected:
            result = self._mqtt.publish(self._topic, payload, qos=1)
            if result.ok:
                return
            log.debug("health: publish failed (%s) — queueing", result.reason)
        await self._queue.enqueue_mqtt(
            topic=self._topic, payload=payload, qos=1, priority=PRIO_HEALTH,
        )

    @staticmethod
    def memory_rss_mb() -> float:
        """Self-reported resident set size from /proc/self/status. Used by
        the supervisor to log a warning when we drift above the soft cap."""
        try:
            with open("/proc/self/status", "r") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        kb = int(line.split()[1])
                        return kb / 1024.0
        except (OSError, ValueError):
            pass
        return 0.0

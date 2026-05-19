"""Device configuration.

Phase 1 keeps this dumb on purpose: a JSON file at a known path, with env-var
overrides for the handful of knobs we actually flip during bring-up. Task 08
will replace this with a signed config blob delivered over MQTT.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import pathlib
from dataclasses import dataclass, field, asdict
from uuid import UUID


log = logging.getLogger(__name__)


DEFAULT_CONFIG_PATH = pathlib.Path("/etc/urban-acoustics/config.json")
DEFAULT_DATA_DIR = pathlib.Path("/var/lib/urban-acoustics")
DEFAULT_AUDIO_DIR = DEFAULT_DATA_DIR / "audio"
# Cloud-pushed tunables land here. The systemd unit grants write access to
# /var/lib/urban-acoustics (see systemd/urban-acoustics.service), so the
# supervisor can persist commands without relaxing the /etc read-only
# sandbox. ``load_config()`` overlays this onto the bootstrap JSON if it
# exists, so the file is purely optional.
DEFAULT_OVERLAY_PATH = DEFAULT_DATA_DIR / "config-overrides.json"

# Whitelist of fields the cloud is allowed to override at runtime. Everything
# else in the bootstrap config is identity/calibration/transport — flipping
# those over MQTT is out of scope for v1. Adding to this set is the only
# change required to let the dashboard tune additional knobs later.
MUTABLE_FIELDS: frozenset[str] = frozenset({"event_threshold_db"})


@dataclass(frozen=True)
class Config:
    # --- identity ---
    device_id: UUID
    fw_version: str = "0.1.0"

    # --- audio capture ---
    alsa_device: str = "dmic_mono"
    sample_rate: int = 48000
    channels: int = 1
    # arecord format string. INMP441 outputs 24-bit in a 32-bit word.
    pcm_format: str = "S32_LE"

    # --- calibration ---
    # 94 dB SPL at 1 kHz produces -26 dBFS on the INMP441 datasheet, so a unit-
    # amplitude full-scale sample corresponds to 120 dB SPL before per-device
    # trim. mic_gain_db is the per-device residual.
    sensitivity_offset_db: float = 120.0
    mic_gain_db: float = 0.0

    # --- detector ---
    event_threshold_db: float = 80.0      # LAFmax over the 1 s block
    event_hysteresis_db: float = 6.0      # below threshold-this to "close"
    event_min_duration_s: float = 2.0     # must stay above threshold this long
    event_max_duration_s: float = 30.0    # truncate runaway events
    event_pre_roll_s: float = 3.0
    event_post_roll_s: float = 5.0
    event_cooldown_s: float = 10.0        # min gap between events

    # --- MQTT ---
    mqtt_broker_host: str = "mqtt.urban-acoustics.conexed.com"
    mqtt_broker_port: int = 8883
    mqtt_keepalive_s: int = 30
    mqtt_ca_file: pathlib.Path = pathlib.Path("/etc/urban-acoustics/certs/root-ca.crt")
    mqtt_cert_file: pathlib.Path = pathlib.Path("/etc/urban-acoustics/certs/device.crt")
    mqtt_key_file: pathlib.Path = pathlib.Path("/etc/urban-acoustics/certs/device.key")

    # --- REST API ---
    api_base: str = "https://api.urban-acoustics.conexed.com"
    api_timeout_s: float = 15.0

    # --- storage ---
    data_dir: pathlib.Path = DEFAULT_DATA_DIR
    audio_dir: pathlib.Path = DEFAULT_AUDIO_DIR
    queue_db_path: pathlib.Path = DEFAULT_DATA_DIR / "queue.db"
    # Cap on disk used by the local SQLite queue + event spool. Old non-event
    # rows are pruned before this is hit. ~256 MiB is plenty for a few days
    # of outage on a 32 GB card.
    queue_max_bytes: int = 256 * 1024 * 1024

    # --- runtime ---
    memory_soft_cap_mb: int = 192         # supervisor logs warning above this
    health_period_s: float = 60.0
    telemetry_period_s: float = 1.0

    # --- spectrogram ---
    # Live 1/3-octave band stream on dev/{id}/spect. Bandwidth ~1.4 KB/s
    # at the default decimation; flip to False if CPU or broker pressure
    # ever becomes an issue.
    spectrogram_enabled: bool = True
    # Publish every Nth STFT frame. window=4096, hop=2048 on 48 kHz gives
    # 23.4 frames/sec; decimating by 2 → ~11.7 Hz on the wire.
    spectrogram_decimate: int = 2

    # Derived: hash of the active config payload (without the version itself)
    # exposed in Health messages so the cloud can detect drift.
    config_version: str = field(default="", init=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "config_version", _hash_config(self))


def _hash_config(cfg: Config) -> str:
    d = {k: str(v) if isinstance(v, (UUID, pathlib.Path)) else v for k, v in asdict(cfg).items()}
    d.pop("config_version", None)
    blob = json.dumps(d, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()[:12]


# Knobs that may be overridden from env vars — kept narrow so a misconfigured
# unit file can't silently change calibration or thresholds.
_ENV_OVERRIDES: dict[str, str] = {
    "URBAN_ACOUSTICS_CONFIG": "config_path",  # handled separately
    "URBAN_ACOUSTICS_DEVICE_ID": "device_id",
    "URBAN_ACOUSTICS_MQTT_HOST": "mqtt_broker_host",
    "URBAN_ACOUSTICS_MQTT_PORT": "mqtt_broker_port",
    "URBAN_ACOUSTICS_API_BASE": "api_base",
    "URBAN_ACOUSTICS_LOG_LEVEL": "log_level",  # handled separately
}


def load_config(
    path: pathlib.Path | None = None,
    *,
    overlay_path: pathlib.Path | None = None,
) -> Config:
    """Load config from JSON file, with a small set of env-var overrides.

    If ``overlay_path`` exists, its whitelisted keys are merged on top of the
    bootstrap JSON. Missing required fields raise SystemExit early so systemd
    reports the failure cleanly instead of crashing inside the supervisor
    loop.
    """
    path = path or pathlib.Path(os.environ.get("URBAN_ACOUSTICS_CONFIG", str(DEFAULT_CONFIG_PATH)))
    if not path.exists():
        raise SystemExit(f"config file not found: {path}")

    try:
        raw = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise SystemExit(f"config file {path} is not valid JSON: {exc}") from exc

    overlay_path = overlay_path or DEFAULT_OVERLAY_PATH
    _merge_overlay(raw, overlay_path)

    if "device_id" not in raw:
        raise SystemExit(f"config file {path} missing required field 'device_id'")

    # Apply env-var overrides for the limited set above.
    if (v := os.environ.get("URBAN_ACOUSTICS_DEVICE_ID")):
        raw["device_id"] = v
    if (v := os.environ.get("URBAN_ACOUSTICS_MQTT_HOST")):
        raw["mqtt_broker_host"] = v
    if (v := os.environ.get("URBAN_ACOUSTICS_MQTT_PORT")):
        raw["mqtt_broker_port"] = int(v)
    if (v := os.environ.get("URBAN_ACOUSTICS_API_BASE")):
        raw["api_base"] = v

    try:
        raw["device_id"] = UUID(str(raw["device_id"]))
    except (ValueError, TypeError) as exc:
        raise SystemExit(f"config device_id is not a valid UUID: {exc}") from exc

    for path_key in (
        "mqtt_ca_file", "mqtt_cert_file", "mqtt_key_file",
        "data_dir", "audio_dir", "queue_db_path",
    ):
        if path_key in raw:
            raw[path_key] = pathlib.Path(raw[path_key])

    # Drop anything we don't know about so an experiment doesn't accidentally
    # set a typoed field that silently does nothing.
    known = {f.name for f in Config.__dataclass_fields__.values() if f.init}
    unknown = set(raw) - known
    if unknown:
        log.warning("config: ignoring unknown fields: %s", sorted(unknown))
        for k in unknown:
            raw.pop(k)

    cfg = Config(**raw)
    log.info(
        "config loaded device_id=%s fw=%s config_version=%s api=%s broker=%s:%s",
        cfg.device_id, cfg.fw_version, cfg.config_version,
        cfg.api_base, cfg.mqtt_broker_host, cfg.mqtt_broker_port,
    )
    return cfg


def _merge_overlay(raw: dict, overlay_path: pathlib.Path) -> None:
    """In-place merge whitelisted keys from the cloud-pushed overlay onto raw.

    Unknown keys are dropped with a warning rather than failing the load —
    we'd rather a stale field on disk be ignored than have a healthy device
    refuse to boot when MUTABLE_FIELDS shrinks.
    """
    if not overlay_path.exists():
        return
    try:
        overlay = json.loads(overlay_path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        log.warning("config: overlay %s unreadable (%s) — using defaults", overlay_path, exc)
        return
    if not isinstance(overlay, dict):
        log.warning("config: overlay %s is not a JSON object — ignoring", overlay_path)
        return
    applied: dict = {}
    for key, value in overlay.items():
        if key not in MUTABLE_FIELDS:
            log.warning("config: overlay key %r not in MUTABLE_FIELDS — dropping", key)
            continue
        raw[key] = value
        applied[key] = value
    if applied:
        log.info("config: applied overlay from %s: %s", overlay_path, applied)


def write_overlay(
    updates: dict, *, path: pathlib.Path | None = None,
) -> dict:
    """Atomically merge ``updates`` into the overlay file. Returns the
    new contents.

    Keys outside ``MUTABLE_FIELDS`` raise ``ValueError`` — the caller (the
    command handler) is the only path that should be writing here, and it's
    already validated the envelope. The atomic write (tmp + rename in the
    same directory) means a power-cut mid-write leaves either the old
    contents intact or the new contents fully committed, never a torn file.
    """
    path = path or DEFAULT_OVERLAY_PATH
    bad = [k for k in updates if k not in MUTABLE_FIELDS]
    if bad:
        raise ValueError(f"overlay write rejected: keys not in MUTABLE_FIELDS: {bad}")

    path.parent.mkdir(parents=True, exist_ok=True)

    current: dict = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text())
            if isinstance(loaded, dict):
                current = loaded
        except (json.JSONDecodeError, OSError):
            log.warning("config: existing overlay %s unreadable; replacing", path)

    current.update(updates)
    # Drop unknown keys that may have crept in from an older firmware.
    current = {k: v for k, v in current.items() if k in MUTABLE_FIELDS}

    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(current, sort_keys=True, separators=(",", ":")))
    os.replace(tmp, path)
    log.info("config: overlay written %s = %s", path, current)
    return current

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


def load_config(path: pathlib.Path | None = None) -> Config:
    """Load config from JSON file, with a small set of env-var overrides.

    Missing required fields raise SystemExit early so systemd reports the
    failure cleanly instead of crashing inside the supervisor loop.
    """
    path = path or pathlib.Path(os.environ.get("URBAN_ACOUSTICS_CONFIG", str(DEFAULT_CONFIG_PATH)))
    if not path.exists():
        raise SystemExit(f"config file not found: {path}")

    try:
        raw = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise SystemExit(f"config file {path} is not valid JSON: {exc}") from exc

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

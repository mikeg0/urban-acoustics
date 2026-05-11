"""Phase 1 device ↔ cloud contracts.

Single source of truth for every wire-level Phase 1 schema. Mirrors
plans/phase-1-contracts.md; the doc explains *why*, this module enforces *what*.

Imported by the simulator, the MQTT ingest worker, and the FastAPI handlers.
Forward compatibility: inbound device→cloud payloads use ``extra="ignore"`` so
older firmware can ship new fields without breaking the cloud, and the cloud
can ship new optional fields without breaking older firmware.
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


EVENT_MAX_SIZE_BYTES = 8 * 1024 * 1024
EVENT_INTENT_TTL_SECONDS = 60
EVENT_PLAYBACK_URL_TTL_SECONDS = 300

_DB_MIN = -20.0
_DB_MAX = 200.0

UnixTs = Annotated[float, Field(gt=0.0, description="Unix epoch seconds; ms precision allowed.")]
SHA256Hex = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$", description="Lowercase hex SHA-256.")]
DbLevel = Annotated[float, Field(ge=_DB_MIN, le=_DB_MAX)]


class _Forward(BaseModel):
    """Inbound device→cloud payloads. Tolerate unknown fields."""

    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


class _Strict(BaseModel):
    """Outbound cloud→device payloads. Reject unknown fields."""

    model_config = ConfigDict(extra="forbid")


# --- MQTT payloads (device → broker) -----------------------------------------


class Telemetry(_Forward):
    ts: UnixTs
    laeq: DbLevel
    lafmax: DbLevel
    lcpeak: DbLevel


class Health(_Forward):
    ts: UnixTs
    uptime_s: float = Field(ge=0.0)
    cpu_pct: float = Field(ge=0.0, le=100.0)
    cpu_temp_c: float
    mem_used_mb: float = Field(ge=0.0)
    disk_free_mb: float = Field(ge=0.0)
    wifi_rssi_dbm: float
    queue_depth: int = Field(ge=0)
    queue_bytes: int = Field(ge=0)
    mic_gain_db: float
    ntp_offset_ms: float
    fw_version: str = Field(min_length=1)
    config_version: str = Field(min_length=1)


class EventAnnounce(_Forward):
    event_id: UUID
    ts: UnixTs
    duration_s: float = Field(gt=0.0)
    peak_db: DbLevel
    sha256: SHA256Hex
    size: int = Field(gt=0, le=EVENT_MAX_SIZE_BYTES)
    content_type: Literal["audio/flac"]


class EventDone(_Forward):
    event_id: UUID
    storage_key: str = Field(min_length=1)
    sha256: SHA256Hex
    size: int = Field(gt=0, le=EVENT_MAX_SIZE_BYTES)
    uploaded_at: UnixTs


# --- MQTT payloads (broker / cloud → device) ---------------------------------


class LastWill(_Strict):
    device_id: UUID
    status: Literal["offline"]
    ts: UnixTs


CommandName = Literal["rotate-cert", "config", "reboot"]


class CommandEnvelope(_Strict):
    cmd_id: UUID
    cmd: CommandName
    issued_at: UnixTs
    expires_at: UnixTs | None = None
    args: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def _expiry_after_issue(self) -> "CommandEnvelope":
        if self.expires_at is not None and self.expires_at <= self.issued_at:
            raise ValueError("expires_at must be after issued_at")
        return self


# --- Event lifecycle ---------------------------------------------------------


class EventStatus(str, Enum):
    ANNOUNCED = "announced"
    UPLOAD_INTENT_CREATED = "upload_intent_created"
    UPLOADED = "uploaded"
    AVAILABLE = "available"
    FAILED = "failed"


# Forward transitions only — the cloud writes these, never the device.
EVENT_STATE_TRANSITIONS: dict[EventStatus, frozenset[EventStatus]] = {
    EventStatus.ANNOUNCED: frozenset({EventStatus.UPLOAD_INTENT_CREATED, EventStatus.FAILED}),
    EventStatus.UPLOAD_INTENT_CREATED: frozenset(
        {EventStatus.UPLOADED, EventStatus.FAILED, EventStatus.UPLOAD_INTENT_CREATED}
    ),
    EventStatus.UPLOADED: frozenset({EventStatus.AVAILABLE, EventStatus.FAILED}),
    EventStatus.AVAILABLE: frozenset(),
    EventStatus.FAILED: frozenset({EventStatus.UPLOAD_INTENT_CREATED}),
}


def is_valid_event_transition(src: EventStatus, dst: EventStatus) -> bool:
    if src == dst:
        return True
    return dst in EVENT_STATE_TRANSITIONS[src]


# --- REST: event upload intent ----------------------------------------------


class EventIntentRequest(_Forward):
    event_id: UUID
    ts: UnixTs
    duration_s: float = Field(gt=0.0)
    peak_db: DbLevel
    sha256: SHA256Hex
    size: int = Field(gt=0, le=EVENT_MAX_SIZE_BYTES)
    content_type: Literal["audio/flac"]
    nonce: str = Field(min_length=8, max_length=64)


class EventIntentResponse(BaseModel):
    event_id: UUID
    status: EventStatus
    upload_url: str
    storage_key: str
    expires_at: UnixTs
    required_headers: dict[str, str]


# --- REST: event read --------------------------------------------------------


class EventResponse(BaseModel):
    event_id: UUID
    device_id: UUID
    ts: UnixTs
    duration_s: float
    peak_db: float
    sha256: SHA256Hex
    size: int
    status: EventStatus
    classification: str | None = None
    confidence: float | None = None
    model_version: str | None = None
    playback_url: str | None = None
    playback_url_expires_at: UnixTs | None = None


# --- REST: telemetry read ----------------------------------------------------


class TelemetryResolution(str, Enum):
    RAW = "raw"
    ONE_MINUTE = "1m"
    ONE_HOUR = "1h"


class TelemetryPoint(BaseModel):
    ts: UnixTs
    laeq: float
    lafmax: float
    lcpeak: float


class TelemetryReadResponse(BaseModel):
    device_id: UUID
    resolution: TelemetryResolution
    from_ts: UnixTs
    to_ts: UnixTs
    points: list[TelemetryPoint]


# --- REST: labels ------------------------------------------------------------


EventLabel = Literal[
    "motorcycle",
    "car",
    "construction",
    "helicopter",
    "airplane",
    "siren",
    "dog",
    "voice",
    "other",
]


class LabelRequest(_Forward):
    label: EventLabel


class LabelResponse(BaseModel):
    event_id: UUID
    label: EventLabel
    created_at: UnixTs


# --- Device identity ---------------------------------------------------------


class DeviceIdentity(BaseModel):
    """Resolved from the device's TLS cert. Used by broker, ingest, and API."""

    device_id: UUID
    cert_fingerprint: SHA256Hex
    cert_subject_cn: str
    cert_not_before: UnixTs
    cert_not_after: UnixTs

    @model_validator(mode="after")
    def _cn_matches_id(self) -> "DeviceIdentity":
        if self.cert_subject_cn != str(self.device_id):
            raise ValueError("cert_subject_cn must equal str(device_id)")
        if self.cert_not_after <= self.cert_not_before:
            raise ValueError("cert_not_after must be after cert_not_before")
        return self


# --- Topic helpers (kept here so simulator/ingest/ACL stay in lockstep) ------


TOPIC_TELEMETRY = "dev/{device_id}/tlm"
TOPIC_HEALTH = "dev/{device_id}/health"
TOPIC_EVENT_ANNOUNCE = "dev/{device_id}/event/announce"
TOPIC_EVENT_DONE = "dev/{device_id}/event/done"
TOPIC_LWT = "dev/{device_id}/lwt"
TOPIC_CMD_WILDCARD = "dev/{device_id}/cmd/+"
TOPIC_CMD = "dev/{device_id}/cmd/{cmd_name}"


def telemetry_topic(device_id: UUID | str) -> str:
    return TOPIC_TELEMETRY.format(device_id=device_id)


def health_topic(device_id: UUID | str) -> str:
    return TOPIC_HEALTH.format(device_id=device_id)


def event_announce_topic(device_id: UUID | str) -> str:
    return TOPIC_EVENT_ANNOUNCE.format(device_id=device_id)


def event_done_topic(device_id: UUID | str) -> str:
    return TOPIC_EVENT_DONE.format(device_id=device_id)


def lwt_topic(device_id: UUID | str) -> str:
    return TOPIC_LWT.format(device_id=device_id)


def command_topic(device_id: UUID | str, cmd_name: CommandName) -> str:
    return TOPIC_CMD.format(device_id=device_id, cmd_name=cmd_name)


# --- Environment variables (authoritative list) ------------------------------


ENV_VARS: tuple[str, ...] = (
    "DATABASE_URL",
    "MQTT_BROKER_URL",
    "MQTT_CA_FILE",
    "MQTT_CLIENT_CERT",
    "MQTT_CLIENT_KEY",
    "S3_ENDPOINT",
    "S3_PUBLIC_ENDPOINT",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "S3_BUCKET",
    "S3_REGION",
    "JWT_SECRET",
    "JWT_TTL_SECONDS",
    "DEVICE_CERT_TTL_DAYS",
    "EVENT_MAX_SIZE_BYTES",
    "EVENT_INTENT_TTL_SECONDS",
    "EVENT_PLAYBACK_URL_TTL_SECONDS",
    "DEMO_MODE",
    "ALLOWED_ORIGINS",
    "LOG_LEVEL",
)

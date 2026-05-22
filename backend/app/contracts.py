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


# Number of 1/3-octave bands the firmware emits on dev/{id}/spect. Mirrors
# ``raspberry-pi-zero-2w/urban_acoustics/dsp.py::ISO_THIRD_OCTAVE_HZ``.
SPECTROGRAM_N_BANDS = 30


class Spectrogram(_Forward):
    """Live 1/3-octave band frame, published at ~10 Hz on ``dev/{id}/spect``.

    Ephemeral by design — the ingest worker does not persist these. They
    flow MQTT → pg_notify → live WebSocket and are dropped after fan-out.
    """

    ts: UnixTs
    bands: Annotated[
        list[DbLevel],
        Field(min_length=SPECTROGRAM_N_BANDS, max_length=SPECTROGRAM_N_BANDS),
    ]


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


CommandName = Literal["rotate-cert", "config", "reboot", "led"]


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
    label: str | None = None
    playback_url: str | None = None
    playback_url_expires_at: UnixTs | None = None


class EventIndexEntry(BaseModel):
    ts: UnixTs
    duration_s: float
    labeled: bool = False


class EventIndexResponse(BaseModel):
    device_id: UUID | None = None
    from_ts: UnixTs | None = None
    to_ts: UnixTs | None = None
    events: list[EventIndexEntry]


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


# --- REST: device-health read ------------------------------------------------


class HealthResolution(str, Enum):
    RAW = "raw"
    ONE_MINUTE = "1m"
    ONE_HOUR = "1h"


class HealthPoint(BaseModel):
    ts: UnixTs
    uptime_s: float
    cpu_pct: float
    cpu_temp_c: float
    mem_used_mb: float
    disk_free_mb: float
    wifi_rssi_dbm: float
    queue_depth: int
    queue_bytes: int
    mic_gain_db: float
    ntp_offset_ms: float
    fw_version: str
    config_version: str


class HealthReadResponse(BaseModel):
    device_id: UUID
    resolution: HealthResolution
    from_ts: UnixTs
    to_ts: UnixTs
    points: list[HealthPoint]


# --- REST: spectrogram read --------------------------------------------------


class SpectrogramFrameOut(BaseModel):
    ts: UnixTs
    bands: Annotated[
        list[DbLevel],
        Field(min_length=SPECTROGRAM_N_BANDS, max_length=SPECTROGRAM_N_BANDS),
    ]


class SpectrogramReadResponse(BaseModel):
    device_id: UUID
    from_ts: UnixTs
    to_ts: UnixTs
    frames: list[SpectrogramFrameOut]


# --- REST: spectrogram historical tiles --------------------------------------


class SpectrogramTileRef(BaseModel):
    hour: UnixTs  # UTC hour boundary, unix seconds
    tile_url: str  # same-origin path; frontend fetches as PNG


class SpectrogramHistoryResponse(BaseModel):
    """Manifest for the rolling-24h ribbon. The client fetches the 24 tile
    URLs in parallel and colour-maps them using ``tile_db_min``/``tile_db_max``.

    These quantisation constants are part of the wire contract — see
    ``app/spectrogram_tiles.py``. Surfacing them here prevents silent drift.
    """

    device_id: UUID
    generated_at: UnixTs
    tile_db_min: float
    tile_db_max: float
    tile_rows: int
    tile_cols: int
    hours: list[SpectrogramTileRef]  # ascending; final entry is current hour


# --- REST: dashboard summary -------------------------------------------------


class DailySummaryPoint(BaseModel):
    """One day in the dashboard's year view.

    ``hours`` is a length-24 vector of mean LAeq per UTC hour-of-day; entries
    are ``None`` where no telemetry exists. ``peak_hour`` is the argmax over
    that vector (defaults to 0 if all hours are ``None``).
    """

    date: str  # YYYY-MM-DD UTC
    dow: int = Field(ge=0, le=6, description="0=Mon..6=Sun")
    mean: float
    peak: float
    breaches: int = Field(ge=0)
    peak_hour: int = Field(ge=0, le=23)
    hours: list[float | None] = Field(min_length=24, max_length=24)
    event: str | None = None  # top events.classification of the day


class DailySummaryResponse(BaseModel):
    device_id: UUID
    from_ts: UnixTs
    to_ts: UnixTs
    threshold: float
    days: list[DailySummaryPoint]


class AnomalyPoint(BaseModel):
    """A flagged event with a computed-against-hourly-baseline z-score."""

    event_id: UUID
    ts: UnixTs
    day_key: str  # YYYY-MM-DD
    hour: int = Field(ge=0, le=23)
    peak_db: float
    hour_mean_db: float
    z: float
    classification: str | None = None


class AnomaliesResponse(BaseModel):
    device_id: UUID
    from_ts: UnixTs
    to_ts: UnixTs
    points: list[AnomalyPoint]


class ForecastPoint(BaseModel):
    """One day of seasonal-naive forecast.

    Computed as the average of the last 4 occurrences of the same weekday
    over the prior 28 days, with a 95% CI built from the std of those
    occurrences. ``peak_hour`` is the mode across them.
    """

    date: str  # YYYY-MM-DD UTC
    dow: int = Field(ge=0, le=6)
    mean: float
    peak: float
    low: float
    high: float
    peak_hour: int = Field(ge=0, le=23)


class ForecastResponse(BaseModel):
    device_id: UUID
    generated_at: UnixTs
    threshold: float
    points: list[ForecastPoint]


class SourceCount(BaseModel):
    name: str
    pct: float = Field(ge=0.0, le=100.0)
    count: int = Field(ge=0)


class SourcesResponse(BaseModel):
    device_id: UUID
    from_ts: UnixTs
    to_ts: UnixTs
    total: int = Field(ge=0)
    sources: list[SourceCount]


# --- REST: labels ------------------------------------------------------------


EventLabel = Literal[
    "motorcycle",
    "car",
    "truck",
    "construction",
    "helicopter",
    "airplane",
    "siren",
    "horn",
    "dog",
    "voice",
    "trash pickup",
    "wind",
    "rain",
    "thunder",
    "other",
]


class LabelRequest(_Forward):
    label: EventLabel


class LabelResponse(BaseModel):
    event_id: UUID
    label: EventLabel
    created_at: UnixTs


# --- REST: spectrogram annotations -------------------------------------------

# Reject obvious noise (single-pixel click) and pathological ranges. The
# floor matches the popup-suppression threshold on the client; the cap is
# generous enough to label a long-running construction band.
ANNOTATION_MIN_DURATION_S = 0.5
ANNOTATION_MAX_DURATION_S = 600.0


class AnnotationRequest(_Forward):
    ts_start: UnixTs
    ts_end: UnixTs
    label: EventLabel

    @model_validator(mode="after")
    def _range_ok(self) -> "AnnotationRequest":
        if self.ts_end <= self.ts_start:
            raise ValueError("ts_end must be after ts_start")
        duration = self.ts_end - self.ts_start
        if duration < ANNOTATION_MIN_DURATION_S:
            raise ValueError(
                f"annotation must span at least {ANNOTATION_MIN_DURATION_S}s"
            )
        if duration > ANNOTATION_MAX_DURATION_S:
            raise ValueError(
                f"annotation must span at most {ANNOTATION_MAX_DURATION_S}s"
            )
        return self


class AnnotationResponse(BaseModel):
    id: int
    device_id: UUID
    ts_start: UnixTs
    ts_end: UnixTs
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
TOPIC_SPECTROGRAM = "dev/{device_id}/spect"
TOPIC_HEALTH = "dev/{device_id}/health"
TOPIC_EVENT_ANNOUNCE = "dev/{device_id}/event/announce"
TOPIC_EVENT_DONE = "dev/{device_id}/event/done"
TOPIC_LWT = "dev/{device_id}/lwt"
TOPIC_CMD_WILDCARD = "dev/{device_id}/cmd/+"
TOPIC_CMD = "dev/{device_id}/cmd/{cmd_name}"

# Postgres NOTIFY channel for ephemeral spectrogram fan-out. The ingest
# worker writes here; the live WebSocket subscribes. Payload is the JSON
# dict ``{device_id, ts, bands}`` (~360 B, well under the 8 KB limit).
NOTIFY_SPECTROGRAM_CHANNEL = "ua_spect"


def telemetry_topic(device_id: UUID | str) -> str:
    return TOPIC_TELEMETRY.format(device_id=device_id)


def spectrogram_topic(device_id: UUID | str) -> str:
    return TOPIC_SPECTROGRAM.format(device_id=device_id)


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

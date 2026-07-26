"""SQLAlchemy ORM models for the Phase 1 schema.

Schema rationale lives in plans/phase-1-contracts.md. Internal storage uses
TIMESTAMPTZ; the API converts to Unix seconds at the boundary so wire payloads
match the contract.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    PrimaryKeyConstraint,
    String,
    Text,
    SmallInteger,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, REAL, UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Device(Base):
    __tablename__ = "devices"

    device_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    name: Mapped[str | None] = mapped_column(Text, nullable=True)
    location: Mapped[str | None] = mapped_column(Text, nullable=True)
    # WGS84 placement on the station map. Nullable for devices that haven't
    # been physically sited yet; the map view filters these out.
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lon: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Per-device runtime tunables pushed from the dashboard. JSONB so adding
    # fields later is a no-op on the schema. Empty dict means "use device
    # defaults from /etc/urban-acoustics/config.json".
    runtime_config: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )


class Camera(Base):
    __tablename__ = "cameras"

    # camera_id mirrors UDOT's `Id` (their stable identifier across the
    # roster). We persist only the subset of UDOT cameras that sit within
    # ~100 m of an active mic device — the import script handles the
    # filter; the API just reads the table.
    camera_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    source: Mapped[str | None] = mapped_column(Text, nullable=True)
    roadway: Mapped[str | None] = mapped_column(Text, nullable=True)
    direction: Mapped[str | None] = mapped_column(Text, nullable=True)
    location: Mapped[str | None] = mapped_column(Text, nullable=True)
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lon: Mapped[float] = mapped_column(Float, nullable=False)
    # First non-disabled view from UDOT's Views[]; the snapshot URL is
    # https://www.udottraffic.utah.gov/map/Cctv/{view_id}.
    view_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    view_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class DeviceCert(Base):
    __tablename__ = "device_certs"

    # Fingerprint is the PK per contract — a device can have multiple non-revoked
    # certs during 24 h rotation overlap.
    cert_fingerprint: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("devices.device_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    cert_subject_cn: Mapped[str] = mapped_column(Text, nullable=False)
    cert_not_before: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    cert_not_after: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Telemetry(Base):
    __tablename__ = "telemetry_db"
    __table_args__ = (PrimaryKeyConstraint("device_id", "ts", name="pk_telemetry_db"),)

    # The hypertable is created in migration 0001 via SELECT create_hypertable.
    # Composite PK (device_id, ts) is required so Timescale can chunk on ts
    # while keeping per-device ordering cheap.
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    device_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("devices.device_id"),
        nullable=False,
    )
    laeq: Mapped[float] = mapped_column(Float, nullable=False)
    lafmax: Mapped[float] = mapped_column(Float, nullable=False)
    lcpeak: Mapped[float] = mapped_column(Float, nullable=False)


class SpectrogramFrame(Base):
    __tablename__ = "spectrogram_frames"
    __table_args__ = (
        PrimaryKeyConstraint("device_id", "ts", name="pk_spectrogram_frames"),
    )

    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    device_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("devices.device_id"),
        nullable=False,
    )
    bands: Mapped[list[float]] = mapped_column(
        ARRAY(REAL, dimensions=1), nullable=False
    )


class DeviceHealth(Base):
    __tablename__ = "device_health"
    __table_args__ = (PrimaryKeyConstraint("device_id", "ts", name="pk_device_health"),)

    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    device_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("devices.device_id"),
        nullable=False,
    )
    uptime_s: Mapped[float] = mapped_column(Float, nullable=False)
    cpu_pct: Mapped[float] = mapped_column(Float, nullable=False)
    cpu_temp_c: Mapped[float] = mapped_column(Float, nullable=False)
    mem_used_mb: Mapped[float] = mapped_column(Float, nullable=False)
    disk_free_mb: Mapped[float] = mapped_column(Float, nullable=False)
    wifi_rssi_dbm: Mapped[float] = mapped_column(Float, nullable=False)
    queue_depth: Mapped[int] = mapped_column(Integer, nullable=False)
    queue_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    mic_gain_db: Mapped[float] = mapped_column(Float, nullable=False)
    ntp_offset_ms: Mapped[float] = mapped_column(Float, nullable=False)
    fw_version: Mapped[str] = mapped_column(Text, nullable=False)
    config_version: Mapped[str] = mapped_column(Text, nullable=False)


class Event(Base):
    __tablename__ = "events"

    event_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    device_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("devices.device_id"),
        nullable=False,
        index=True,
    )
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    duration_s: Mapped[float] = mapped_column(Float, nullable=False)
    peak_db: Mapped[float] = mapped_column(Float, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    storage_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    classification: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    model_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Label(Base):
    __tablename__ = "labels"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    event_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("events.event_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    label: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class User(Base):
    __tablename__ = "users"

    user_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    email: Mapped[str] = mapped_column(Text, nullable=False, unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False, default="guest", server_default="guest")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SpectrogramAnnotation(Base):
    __tablename__ = "spectrogram_annotations"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    device_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("devices.device_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    ts_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ts_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ApiClient(Base):
    """Machine-to-machine partner credential (see 0010_api_clients migration).

    The plaintext secret is never stored — only its bcrypt hash. Revoke by
    setting ``is_active`` false rather than deleting.
    """

    __tablename__ = "api_clients"

    api_key: Mapped[str] = mapped_column(Text, primary_key=True)
    secret_hash: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class CorrelatedEventSettings(Base):
    """Singleton configuration and watermark for the two-mic detector."""

    __tablename__ = "correlated_event_settings"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    outside_device_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    inside_device_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), nullable=False)
    metric: Mapped[str] = mapped_column(Text, nullable=False, default="lafmax")
    baseline_window_s: Mapped[int] = mapped_column(Integer, nullable=False, default=300)
    min_baseline_samples: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
    outside_rise_db: Mapped[float] = mapped_column(Float, nullable=False, default=8.0)
    inside_rise_db: Mapped[float] = mapped_column(Float, nullable=False, default=6.0)
    outside_min_db: Mapped[float] = mapped_column(Float, nullable=False, default=60.0)
    inside_min_db: Mapped[float] = mapped_column(Float, nullable=False, default=45.0)
    peak_merge_window_s: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    peak_cooldown_s: Mapped[int] = mapped_column(Integer, nullable=False, default=20)
    correlation_window_s: Mapped[int] = mapped_column(Integer, nullable=False, default=10)
    snapshot_before_s: Mapped[int] = mapped_column(Integer, nullable=False, default=15)
    snapshot_after_s: Mapped[int] = mapped_column(Integer, nullable=False, default=15)
    scan_interval_s: Mapped[int] = mapped_column(Integer, nullable=False, default=10)
    audio_match_window_s: Mapped[int] = mapped_column(Integer, nullable=False, default=15)
    audio_grace_s: Mapped[int] = mapped_column(Integer, nullable=False, default=3600)
    last_processed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True
    )


class CorrelatedEventCandidate(Base):
    """A permanent, reviewable outside-mic peak and its correlation result."""

    __tablename__ = "correlated_event_candidates"

    candidate_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    candidate_group: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    outside_device_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("devices.device_id"), nullable=False
    )
    inside_device_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("devices.device_id"), nullable=False
    )
    metric: Mapped[str] = mapped_column(Text, nullable=False)
    outside_peak_ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    outside_peak_db: Mapped[float] = mapped_column(Float, nullable=False)
    outside_baseline_db: Mapped[float] = mapped_column(Float, nullable=False)
    outside_rise_db: Mapped[float] = mapped_column(Float, nullable=False)
    inside_peak_ts: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    inside_peak_db: Mapped[float | None] = mapped_column(Float, nullable=True)
    inside_baseline_db: Mapped[float | None] = mapped_column(Float, nullable=True)
    inside_rise_db: Mapped[float | None] = mapped_column(Float, nullable=True)
    snapshot_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    snapshot_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # The outside-microphone clip a reviewer listens to. A label is only
    # accepted once audio_state is 'linked' (DB CHECK), because weather noise
    # and genuine sources are not reliably distinguishable from the
    # spectrogram alone.
    outside_event_id: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("events.event_id", ondelete="SET NULL"), nullable=True
    )
    audio_state: Mapped[str] = mapped_column(Text, nullable=False, default="pending")
    label: Mapped[str | None] = mapped_column(Text, nullable=True, index=True)
    dismissed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    reviewed_by: Mapped[UUID | None] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class CorrelatedEventFrame(Base):
    """Retention-exempt spectrogram frame copied when a candidate is detected."""

    __tablename__ = "correlated_event_frames"
    __table_args__ = (
        PrimaryKeyConstraint(
            "candidate_id", "device_id", "ts", name="pk_correlated_event_frames"
        ),
    )

    candidate_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("correlated_event_candidates.candidate_id", ondelete="CASCADE"),
        nullable=False,
    )
    device_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("devices.device_id"), nullable=False
    )
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    bands: Mapped[list[float]] = mapped_column(ARRAY(REAL, dimensions=1), nullable=False)

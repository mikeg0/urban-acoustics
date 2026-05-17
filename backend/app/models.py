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
)
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Device(Base):
    __tablename__ = "devices"

    device_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    name: Mapped[str | None] = mapped_column(Text, nullable=True)
    location: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


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

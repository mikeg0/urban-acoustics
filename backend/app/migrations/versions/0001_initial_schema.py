"""initial Phase 1 schema

Revision ID: 0001
Revises:
Create Date: 2026-05-15
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID as PG_UUID


revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Timescale extension — the timescaledb-ha image ships it; CREATE EXTENSION
    # is idempotent and safe on a fresh DB.
    op.execute("CREATE EXTENSION IF NOT EXISTS timescaledb")

    op.create_table(
        "devices",
        sa.Column("device_id", PG_UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.Text(), nullable=True),
        sa.Column("location", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        "device_certs",
        sa.Column("cert_fingerprint", sa.String(length=64), primary_key=True),
        sa.Column(
            "device_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("devices.device_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("cert_subject_cn", sa.Text(), nullable=False),
        sa.Column("cert_not_before", sa.DateTime(timezone=True), nullable=False),
        sa.Column("cert_not_after", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_device_certs_device_id", "device_certs", ["device_id"])

    op.create_table(
        "telemetry_db",
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "device_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("devices.device_id"),
            nullable=False,
        ),
        sa.Column("laeq", sa.Float(), nullable=False),
        sa.Column("lafmax", sa.Float(), nullable=False),
        sa.Column("lcpeak", sa.Float(), nullable=False),
        sa.PrimaryKeyConstraint("device_id", "ts", name="pk_telemetry_db"),
    )
    # Convert to hypertable. Phase 1 retention is "we'll drop chunks older than
    # 30 d via a follow-up policy" — not enforced here so the migration stays
    # a pure schema change.
    op.execute(
        "SELECT create_hypertable('telemetry_db', 'ts', if_not_exists => TRUE)"
    )
    op.create_index(
        "ix_telemetry_db_device_id_ts",
        "telemetry_db",
        ["device_id", sa.text("ts DESC")],
    )

    op.create_table(
        "device_health",
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "device_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("devices.device_id"),
            nullable=False,
        ),
        sa.Column("uptime_s", sa.Float(), nullable=False),
        sa.Column("cpu_pct", sa.Float(), nullable=False),
        sa.Column("cpu_temp_c", sa.Float(), nullable=False),
        sa.Column("mem_used_mb", sa.Float(), nullable=False),
        sa.Column("disk_free_mb", sa.Float(), nullable=False),
        sa.Column("wifi_rssi_dbm", sa.Float(), nullable=False),
        sa.Column("queue_depth", sa.Integer(), nullable=False),
        sa.Column("queue_bytes", sa.BigInteger(), nullable=False),
        sa.Column("mic_gain_db", sa.Float(), nullable=False),
        sa.Column("ntp_offset_ms", sa.Float(), nullable=False),
        sa.Column("fw_version", sa.Text(), nullable=False),
        sa.Column("config_version", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("device_id", "ts", name="pk_device_health"),
    )

    op.create_table(
        "events",
        sa.Column("event_id", PG_UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "device_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("devices.device_id"),
            nullable=False,
        ),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("duration_s", sa.Float(), nullable=False),
        sa.Column("peak_db", sa.Float(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("storage_key", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("classification", sa.Text(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("model_version", sa.Text(), nullable=True),
        sa.Column("uploaded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_events_device_id", "events", ["device_id"])
    op.create_index("ix_events_status", "events", ["status"])
    op.create_index("ix_events_device_id_ts", "events", ["device_id", sa.text("ts DESC")])

    op.create_table(
        "labels",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "event_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("events.event_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_labels_event_id", "labels", ["event_id"])


def downgrade() -> None:
    op.drop_index("ix_labels_event_id", table_name="labels")
    op.drop_table("labels")
    op.drop_index("ix_events_device_id_ts", table_name="events")
    op.drop_index("ix_events_status", table_name="events")
    op.drop_index("ix_events_device_id", table_name="events")
    op.drop_table("events")
    op.drop_table("device_health")
    op.drop_index("ix_telemetry_db_device_id_ts", table_name="telemetry_db")
    op.drop_table("telemetry_db")
    op.drop_index("ix_device_certs_device_id", table_name="device_certs")
    op.drop_table("device_certs")
    op.drop_table("devices")

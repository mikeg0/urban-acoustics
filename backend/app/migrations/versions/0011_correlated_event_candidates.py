"""two-mic correlated event candidates and permanent frame snapshots

Revision ID: 0011
Revises: 0010
Create Date: 2026-07-25
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY, REAL, UUID as PG_UUID


revision: str = "0011"
down_revision: Union[str, None] = "0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


OUTSIDE_DEVICE = "00000000-0000-4000-8000-00000000000a"
INSIDE_DEVICE = "9fa8fde4-1e12-5133-8d1c-323a661e78f9"


def upgrade() -> None:
    op.create_table(
        "correlated_event_settings",
        sa.Column("id", sa.SmallInteger(), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        # Deliberately not foreign keys: admins can configure the pair before
        # both devices have been provisioned. The worker waits for both rows.
        sa.Column("outside_device_id", PG_UUID(as_uuid=True), nullable=False),
        sa.Column("inside_device_id", PG_UUID(as_uuid=True), nullable=False),
        sa.Column("metric", sa.Text(), nullable=False, server_default="lafmax"),
        sa.Column("baseline_window_s", sa.Integer(), nullable=False, server_default="300"),
        sa.Column("min_baseline_samples", sa.Integer(), nullable=False, server_default="60"),
        sa.Column("outside_rise_db", sa.Float(), nullable=False, server_default="8"),
        sa.Column("inside_rise_db", sa.Float(), nullable=False, server_default="6"),
        sa.Column("outside_min_db", sa.Float(), nullable=False, server_default="60"),
        sa.Column("inside_min_db", sa.Float(), nullable=False, server_default="45"),
        sa.Column("peak_merge_window_s", sa.Integer(), nullable=False, server_default="5"),
        sa.Column("peak_cooldown_s", sa.Integer(), nullable=False, server_default="20"),
        sa.Column("correlation_window_s", sa.Integer(), nullable=False, server_default="10"),
        sa.Column("snapshot_before_s", sa.Integer(), nullable=False, server_default="15"),
        sa.Column("snapshot_after_s", sa.Integer(), nullable=False, server_default="15"),
        sa.Column("scan_interval_s", sa.Integer(), nullable=False, server_default="10"),
        sa.Column("last_processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column(
            "updated_by",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("users.user_id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.CheckConstraint("id = 1", name="ck_correlated_event_settings_singleton"),
        sa.CheckConstraint("outside_device_id <> inside_device_id", name="ck_correlated_event_settings_distinct_devices"),
        sa.CheckConstraint("metric IN ('laeq', 'lafmax', 'lcpeak')", name="ck_correlated_event_settings_metric"),
        sa.CheckConstraint("baseline_window_s BETWEEN 30 AND 86400", name="ck_correlated_event_settings_baseline"),
        sa.CheckConstraint("min_baseline_samples BETWEEN 3 AND baseline_window_s", name="ck_correlated_event_settings_min_samples"),
        sa.CheckConstraint("peak_merge_window_s BETWEEN 1 AND 300", name="ck_correlated_event_settings_merge"),
        sa.CheckConstraint("peak_cooldown_s BETWEEN 0 AND 3600", name="ck_correlated_event_settings_cooldown"),
        sa.CheckConstraint("correlation_window_s BETWEEN 0 AND 300", name="ck_correlated_event_settings_correlation"),
        sa.CheckConstraint("snapshot_before_s BETWEEN 1 AND 300", name="ck_correlated_event_settings_snapshot_before"),
        sa.CheckConstraint("snapshot_after_s BETWEEN 1 AND 300", name="ck_correlated_event_settings_snapshot_after"),
        sa.CheckConstraint("scan_interval_s BETWEEN 1 AND 300", name="ck_correlated_event_settings_scan_interval"),
    )
    op.execute(
        "INSERT INTO correlated_event_settings "
        "(id, outside_device_id, inside_device_id) VALUES "
        f"(1, '{OUTSIDE_DEVICE}', '{INSIDE_DEVICE}')"
    )

    op.create_table(
        "correlated_event_candidates",
        sa.Column("candidate_id", PG_UUID(as_uuid=True), primary_key=True),
        sa.Column("candidate_group", sa.Text(), nullable=False),
        sa.Column("outside_device_id", PG_UUID(as_uuid=True), sa.ForeignKey("devices.device_id"), nullable=False),
        sa.Column("inside_device_id", PG_UUID(as_uuid=True), sa.ForeignKey("devices.device_id"), nullable=False),
        sa.Column("metric", sa.Text(), nullable=False),
        sa.Column("outside_peak_ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("outside_peak_db", sa.Float(), nullable=False),
        sa.Column("outside_baseline_db", sa.Float(), nullable=False),
        sa.Column("outside_rise_db", sa.Float(), nullable=False),
        sa.Column("inside_peak_ts", sa.DateTime(timezone=True), nullable=True),
        sa.Column("inside_peak_db", sa.Float(), nullable=True),
        sa.Column("inside_baseline_db", sa.Float(), nullable=True),
        sa.Column("inside_rise_db", sa.Float(), nullable=True),
        sa.Column("snapshot_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("snapshot_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("label", sa.Text(), nullable=True),
        sa.Column("dismissed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("reviewed_by", PG_UUID(as_uuid=True), sa.ForeignKey("users.user_id", ondelete="SET NULL"), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("candidate_group IN ('correlated', 'outside_only')", name="ck_correlated_event_candidates_group"),
        sa.CheckConstraint("metric IN ('laeq', 'lafmax', 'lcpeak')", name="ck_correlated_event_candidates_metric"),
        sa.CheckConstraint("label IS NULL OR label IN ('real', 'wind', 'unsure')", name="ck_correlated_event_candidates_label"),
        sa.CheckConstraint("snapshot_end > snapshot_start", name="ck_correlated_event_candidates_snapshot"),
        sa.UniqueConstraint("outside_device_id", "outside_peak_ts", name="uq_correlated_event_candidates_outside_peak"),
    )
    op.create_index(
        "ix_correlated_event_candidates_queue",
        "correlated_event_candidates",
        ["dismissed", "label", sa.text("outside_peak_ts DESC")],
    )
    op.create_index("ix_correlated_event_candidates_group", "correlated_event_candidates", ["candidate_group"])
    op.create_index("ix_correlated_event_candidates_label", "correlated_event_candidates", ["label"])
    op.create_index("ix_correlated_event_candidates_dismissed", "correlated_event_candidates", ["dismissed"])

    # A regular Postgres table, not a hypertable: no Timescale retention policy
    # applies, which is the core guarantee needed by the seven-day trial.
    op.create_table(
        "correlated_event_frames",
        sa.Column("candidate_id", PG_UUID(as_uuid=True), sa.ForeignKey("correlated_event_candidates.candidate_id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_id", PG_UUID(as_uuid=True), sa.ForeignKey("devices.device_id"), nullable=False),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("bands", ARRAY(REAL, dimensions=1), nullable=False),
        sa.PrimaryKeyConstraint("candidate_id", "device_id", "ts", name="pk_correlated_event_frames"),
    )
    op.create_index(
        "ix_correlated_event_frames_candidate_device_ts",
        "correlated_event_frames",
        ["candidate_id", "device_id", "ts"],
    )


def downgrade() -> None:
    op.drop_index("ix_correlated_event_frames_candidate_device_ts", table_name="correlated_event_frames")
    op.drop_table("correlated_event_frames")
    op.drop_index("ix_correlated_event_candidates_dismissed", table_name="correlated_event_candidates")
    op.drop_index("ix_correlated_event_candidates_label", table_name="correlated_event_candidates")
    op.drop_index("ix_correlated_event_candidates_group", table_name="correlated_event_candidates")
    op.drop_index("ix_correlated_event_candidates_queue", table_name="correlated_event_candidates")
    op.drop_table("correlated_event_candidates")
    op.drop_table("correlated_event_settings")

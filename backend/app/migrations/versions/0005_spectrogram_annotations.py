"""spectrogram_annotations table

Stores user-drawn time-range annotations on the live spectrogram so the
ML training pipeline can learn from sub-threshold patterns (wind, light
rain, distant helicopters) that never trigger the audio-event capture
path.

Deliberately kept separate from ``events`` — events have a required
audio backing (sha256/size/content_type are NOT NULL on that table),
annotations have only a time range and a label. Two distinct concepts
cleanly live in two tables.

Revision ID: 0005
Revises: 0004
Create Date: 2026-05-22
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID as PG_UUID


revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "spectrogram_annotations",
        sa.Column(
            "id", sa.BigInteger(), primary_key=True, autoincrement=True, nullable=False
        ),
        sa.Column(
            "device_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("devices.device_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("ts_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ts_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "ts_end > ts_start", name="ck_spectrogram_annotations_range"
        ),
    )
    op.create_index(
        "ix_spectrogram_annotations_device_id_ts_start",
        "spectrogram_annotations",
        ["device_id", "ts_start"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_spectrogram_annotations_device_id_ts_start",
        table_name="spectrogram_annotations",
    )
    op.drop_table("spectrogram_annotations")

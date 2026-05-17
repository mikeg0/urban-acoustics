"""spectrogram_frames hypertable

Persists 1/3-octave band frames so the live spectrogram can backfill
across page refreshes. Earlier design (see 0001) treated these as
ephemeral; the dashboard's "1-hour ribbon" needs a queryable history,
which is what this migration adds.

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-17
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY, REAL, UUID as PG_UUID


revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "spectrogram_frames",
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "device_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("devices.device_id"),
            nullable=False,
        ),
        # REAL[] keeps each frame at ~120 B on disk (30 × 4 B + array header)
        # vs ~240 B for DOUBLE PRECISION[]. The band dB values are quantised
        # to ~0.1 dB on the Pi anyway, so float4 is more than enough.
        sa.Column("bands", ARRAY(REAL, dimensions=1), nullable=False),
        sa.PrimaryKeyConstraint("device_id", "ts", name="pk_spectrogram_frames"),
    )
    op.execute(
        "SELECT create_hypertable('spectrogram_frames', 'ts', "
        "chunk_time_interval => INTERVAL '1 hour', if_not_exists => TRUE)"
    )
    op.create_index(
        "ix_spectrogram_frames_device_id_ts",
        "spectrogram_frames",
        ["device_id", sa.text("ts DESC")],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_spectrogram_frames_device_id_ts", table_name="spectrogram_frames"
    )
    op.drop_table("spectrogram_frames")

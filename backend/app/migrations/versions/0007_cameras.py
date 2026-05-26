"""cameras table

Stores the subset of UDOT traffic cameras co-located with mic devices.
The roster is populated by ``scripts/refresh_cameras.py`` (operator-run);
the API only reads.

Revision ID: 0007
Revises: 0006
Create Date: 2026-05-26
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "cameras",
        sa.Column("camera_id", sa.BigInteger(), primary_key=True),
        sa.Column("source", sa.Text(), nullable=True),
        sa.Column("roadway", sa.Text(), nullable=True),
        sa.Column("direction", sa.Text(), nullable=True),
        sa.Column("location", sa.Text(), nullable=True),
        sa.Column("lat", sa.Float(), nullable=False),
        sa.Column("lon", sa.Float(), nullable=False),
        sa.Column("view_id", sa.BigInteger(), nullable=True),
        sa.Column("view_description", sa.Text(), nullable=True),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("cameras")

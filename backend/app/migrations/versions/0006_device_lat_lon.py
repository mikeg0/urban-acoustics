"""device lat/lon columns

Adds nullable ``lat`` and ``lon`` columns to ``devices`` so each station
can be placed on the dashboard's map view. Nullable: devices may be
registered before they're physically sited.

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-26
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("lat", sa.Float(), nullable=True))
    op.add_column("devices", sa.Column("lon", sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "lon")
    op.drop_column("devices", "lat")

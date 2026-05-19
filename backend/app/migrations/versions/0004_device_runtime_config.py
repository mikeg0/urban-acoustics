"""device runtime_config JSONB column

Adds a JSONB ``runtime_config`` column on ``devices`` so the dashboard can
push per-device tunables (initially just ``event_threshold_db``) to the
sensor over MQTT. JSONB keeps the schema stable as the whitelist of mutable
fields grows; the empty default means "use device defaults from
/etc/urban-acoustics/config.json".

Revision ID: 0004
Revises: 0003
Create Date: 2026-05-19
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "devices",
        sa.Column(
            "runtime_config",
            JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("devices", "runtime_config")

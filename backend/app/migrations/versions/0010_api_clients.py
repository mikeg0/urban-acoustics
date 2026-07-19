"""api_clients table

Machine-to-machine API credentials for partner integrations (e.g. sleep-atlas,
which overlays a device's measured dB curve on its sleep timeline). Secrets are
bcrypt-hashed exactly like user passwords (``auth.password``), so a leaked DB
never exposes a usable secret. Rows are revoked by flipping ``is_active`` to
false rather than deleting — that keeps ``last_used_at`` history and lets a key
be rotated by inserting a new row and retiring the old one.

Mirrors 0008_users.py.

Revision ID: 0010
Revises: 0009
Create Date: 2026-07-18
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "api_clients",
        sa.Column("api_key", sa.Text(), primary_key=True),
        sa.Column("secret_hash", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("api_clients")

"""spectrogram_frames retention policy

``spectrogram_frames`` is the largest store in the system (~1M rows/day,
1-hour chunks) and had no retention, so it grew unbounded. It only backs the
dashboard's live spectrogram ribbon, which never reads more than recent
history, so anything past a week is safe to discard.

The 0003 migration deferred retention explicitly ("Retention policies are
also out of scope; they belong in a separate, reversible migration"). This is
that migration.

A native Timescale retention policy is used rather than a cron/`drop_chunks`
script: the policy is run by Timescale's own background scheduler, so it needs
no external scheduler, repo checkout, or Docker exec, and it drops whole
expired chunks (near-instant, reclaims disk immediately, no VACUUM/bloat). No
continuous aggregate depends on this hypertable, so dropping its chunks affects
nothing downstream.

Note: only fully-expired chunks are dropped, so up to one chunk-interval (1 h)
of pre-cutoff rows may linger until their chunk also ages out — expected.

Revision ID: 0009
Revises: 0008
Create Date: 2026-06-22
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_HYPERTABLE = "spectrogram_frames"
_RETENTION = "7 days"


def upgrade() -> None:
    op.execute(
        f"SELECT add_retention_policy('{_HYPERTABLE}', "
        f"drop_after => INTERVAL '{_RETENTION}', if_not_exists => TRUE)"
    )


def downgrade() -> None:
    op.execute(
        f"SELECT remove_retention_policy('{_HYPERTABLE}', if_exists => TRUE)"
    )

"""telemetry continuous aggregates

Adds three Timescale continuous aggregates over ``telemetry_db``:

* ``telemetry_1m`` — minute buckets, drives ``/telemetry?res=1m`` and
  the live-zoom queries.
* ``telemetry_1h`` — hour buckets, drives ``/telemetry?res=1h`` and the
  dashboard's per-day ``hours[24]`` pivot, anomaly z-scores, and forecast.
* ``telemetry_1d`` — day buckets, drives the dashboard year heatmap,
  breach ribbon, and headline stats.

Real-time aggregation stays on (the default), so the gap between the last
materialisation and ``now()`` is filled from raw ``telemetry_db`` and the
API doesn't need fallback logic.

Backfill is intentionally deferred — the policies created here will
materialise history over time. For instant backfill on an existing-data
deploy, run ``scripts/backfill_caggs.py`` after the migration applies.

Retention policies are also out of scope; they belong in a separate,
reversible migration.

Revision ID: 0003
Revises: 0002
Create Date: 2026-05-17
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_CAGGS: tuple[tuple[str, str, str, str, str], ...] = (
    # (view name, bucket interval, start_offset, end_offset, schedule_interval)
    (
        "telemetry_1m",
        "1 minute",
        # Refresh window: rebuild the last 7 days every minute. End offset of
        # 1 minute keeps the in-progress bucket out of the materialisation —
        # real-time aggregation fills it.
        "INTERVAL '7 days'",
        "INTERVAL '1 minute'",
        "INTERVAL '1 minute'",
    ),
    (
        "telemetry_1h",
        "1 hour",
        "INTERVAL '30 days'",
        "INTERVAL '1 hour'",
        "INTERVAL '15 minutes'",
    ),
    (
        "telemetry_1d",
        "1 day",
        "INTERVAL '90 days'",
        "INTERVAL '1 hour'",
        "INTERVAL '1 hour'",
    ),
)


def upgrade() -> None:
    for name, bucket, start_offset, end_offset, schedule in _CAGGS:
        # CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous) is
        # transactional in modern Timescale, so op.execute() is enough — no
        # autocommit dance required.
        op.execute(
            f"""
            CREATE MATERIALIZED VIEW IF NOT EXISTS {name}
            WITH (timescaledb.continuous) AS
            SELECT device_id,
                   time_bucket(INTERVAL '{bucket}', ts) AS bucket,
                   AVG(laeq)::float8     AS laeq,
                   MAX(lafmax)::float8   AS lafmax,
                   MAX(lcpeak)::float8   AS lcpeak,
                   COUNT(*)              AS n_samples
              FROM telemetry_db
             GROUP BY device_id, bucket
            WITH NO DATA;
            """
        )
        op.execute(
            f"""
            SELECT add_continuous_aggregate_policy(
                '{name}',
                start_offset      => {start_offset},
                end_offset        => {end_offset},
                schedule_interval => {schedule},
                if_not_exists     => TRUE
            );
            """
        )


def downgrade() -> None:
    # Policies are dropped automatically when the view is dropped.
    for name in ("telemetry_1d", "telemetry_1h", "telemetry_1m"):
        op.execute(f"DROP MATERIALIZED VIEW IF EXISTS {name} CASCADE;")

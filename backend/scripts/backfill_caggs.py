"""Dev helper: backfill the dashboard's continuous aggregates.

The 0003 migration creates ``telemetry_1m`` / ``telemetry_1h`` /
``telemetry_1d`` ``WITH NO DATA`` because ``refresh_continuous_aggregate``
historically can't run inside Alembic's transaction. Run this once after
``alembic upgrade head`` to populate them with everything in
``telemetry_db``. Idempotent — safe to re-run.

Usage (inside the backend container):

    python -m scripts.backfill_caggs
"""

from __future__ import annotations

import asyncio
import pathlib
import sys

# Allow `python -m scripts.backfill_caggs` from /app.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.db import get_engine  # noqa: E402


_CAGGS = ("telemetry_1d", "telemetry_1h", "telemetry_1m")


async def main() -> None:
    engine = get_engine()
    # AUTOCOMMIT — refresh_continuous_aggregate can't run inside a
    # transaction on older Timescale versions, and is harmless to run
    # outside one on newer versions.
    async with engine.connect() as conn:
        conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
        for name in _CAGGS:
            print(f"refreshing {name} …", flush=True)
            await conn.exec_driver_sql(
                f"CALL refresh_continuous_aggregate('{name}', NULL, NULL);"
            )
    print("done.")


if __name__ == "__main__":
    asyncio.run(main())

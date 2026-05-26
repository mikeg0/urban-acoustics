"""Pull the UDOT camera roster and persist the subset near mic devices.

Run from inside the backend container::

    python -m scripts.refresh_cameras

The script reads ``UDOT_API_KEY`` from settings (env), pulls UDOT's full
statewide roster, prunes to the downtown bbox, then keeps only cameras
within ~100 m of an existing device (i.e. at the same intersection as
one of our mics). Idempotent: re-running with no device changes leaves
the row count untouched; moving or deleting a mic prunes its camera on
the next run.
"""

from __future__ import annotations

import asyncio
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.db import get_sessionmaker  # noqa: E402
from app.integrations.udot_cameras import refresh_cameras  # noqa: E402
from app.settings import get_settings  # noqa: E402


async def _run() -> int:
    settings = get_settings()
    if not settings.UDOT_API_KEY:
        print("UDOT_API_KEY is not set — nothing to fetch", file=sys.stderr)
        return 1

    factory = get_sessionmaker()
    async with factory() as session:
        written = await refresh_cameras(session, settings.UDOT_API_KEY)
    print(f"wrote {written} cameras")
    return 0


def main() -> int:
    return asyncio.run(_run())


if __name__ == "__main__":
    sys.exit(main())

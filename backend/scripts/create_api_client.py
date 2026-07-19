"""Dev helper: create a partner API client (key + secret) in Postgres.

Partner integrations (e.g. sleep-atlas pulling a device's noise curve) call the
``/api/v1/partner/*`` endpoints with an ``X-API-Key`` / ``X-API-Secret`` header
pair. This inserts an ``api_clients`` row and prints the credentials **once** —
the secret is bcrypt-hashed on write and cannot be recovered afterward. To
rotate, create a new client and set the old one's ``is_active`` to false.

Usage (inside the backend container):

    python -m scripts.create_api_client --label sleep-atlas
"""

from __future__ import annotations

import argparse
import asyncio
import pathlib
import secrets
import sys
from datetime import datetime, timezone

# Run as ``python -m scripts.create_api_client`` from /app; put the package on
# sys.path so imports work regardless of cwd (mirrors scripts/register_device).
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.auth.password import hash_password  # noqa: E402
from app.db import get_sessionmaker  # noqa: E402
from app.models import ApiClient  # noqa: E402


async def _create(label: str) -> None:
    # token_urlsafe(32) ≈ 43 chars — comfortably under bcrypt's 72-byte cap.
    api_key = "ak_" + secrets.token_urlsafe(12)
    secret = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)

    factory = get_sessionmaker()
    async with factory() as session:
        session.add(
            ApiClient(
                api_key=api_key,
                secret_hash=hash_password(secret),
                label=label,
                is_active=True,
                created_at=now,
            )
        )
        await session.commit()

    print("API client created — store the secret now, it cannot be recovered:")
    print(f"  label:        {label}")
    print(f"  X-API-Key:    {api_key}")
    print(f"  X-API-Secret: {secret}")


def main() -> int:
    parser = argparse.ArgumentParser(description="create a partner API client")
    parser.add_argument("--label", required=True, help="human label, e.g. sleep-atlas")
    args = parser.parse_args()
    asyncio.run(_create(args.label))
    return 0


if __name__ == "__main__":
    sys.exit(main())

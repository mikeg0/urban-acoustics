"""Dev helper: insert a device + cert row directly into Postgres.

Usage (inside the backend container):

    python -m scripts.register_device \
        --device-id 00000000-0000-4000-8000-00000000000a \
        --cert /app/certs/devices/00000000-0000-4000-8000-00000000000a.crt \
        --name "fixture-device-a" --location "Riverton / Canal & 7th"

Task 08 will replace this with a real claim-code factory flow; until then,
operators bootstrap dev devices by running this against a freshly migrated DB.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import pathlib
import sys
from datetime import datetime, timezone
from uuid import UUID

from cryptography import x509  # type: ignore[import-not-found]

# The script is run as ``python -m scripts.register_device`` from /app; bring
# the package onto sys.path so imports work regardless of cwd.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.db import get_sessionmaker  # noqa: E402
from app.models import Device, DeviceCert  # noqa: E402


def _parse_cert(path: pathlib.Path) -> tuple[str, str, datetime, datetime]:
    pem = path.read_bytes()
    cert = x509.load_pem_x509_certificate(pem)
    der = cert.public_bytes(encoding=x509.Encoding.DER)  # type: ignore[attr-defined]
    fingerprint = hashlib.sha256(der).hexdigest()
    cn = cert.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)[0].value
    return fingerprint, cn, cert.not_valid_before_utc, cert.not_valid_after_utc


async def _register(device_id: UUID, cert_path: pathlib.Path, name: str | None, location: str | None) -> None:
    fingerprint, cn, not_before, not_after = _parse_cert(cert_path)
    if cn != str(device_id):
        raise SystemExit(f"cert CN ({cn}) does not match --device-id ({device_id})")

    now = datetime.now(timezone.utc)
    factory = get_sessionmaker()
    async with factory() as session:
        existing_device = await session.get(Device, device_id)
        if existing_device is None:
            session.add(
                Device(device_id=device_id, name=name, location=location, created_at=now)
            )

        existing_cert = await session.get(DeviceCert, fingerprint)
        if existing_cert is None:
            session.add(
                DeviceCert(
                    cert_fingerprint=fingerprint,
                    device_id=device_id,
                    cert_subject_cn=cn,
                    cert_not_before=not_before,
                    cert_not_after=not_after,
                    revoked=False,
                    created_at=now,
                )
            )
        await session.commit()
    print(f"registered device_id={device_id} fingerprint={fingerprint}")


def main() -> int:
    parser = argparse.ArgumentParser(description="register a dev device + its cert")
    parser.add_argument("--device-id", required=True, type=UUID)
    parser.add_argument("--cert", required=True, type=pathlib.Path)
    parser.add_argument("--name", default=None)
    parser.add_argument("--location", default=None)
    args = parser.parse_args()
    asyncio.run(_register(args.device_id, args.cert, args.name, args.location))
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""/api/v1/health — liveness + DB + storage probe.

Doesn't take a session dependency: a totally unreachable DB shouldn't make
the health endpoint itself fail with 500 — it should respond with ok=false.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import text

from ...db import get_engine
from ...storage import Storage, get_storage

router = APIRouter()


@router.get("/health")
async def health(storage: Storage = Depends(get_storage)) -> dict:
    db_ok = False
    try:
        engine = get_engine()
        async with engine.connect() as conn:
            result = await conn.execute(text("SELECT 1"))
            db_ok = result.scalar() == 1
    except Exception:
        db_ok = False

    try:
        storage_ok = await storage.bucket_ready()
    except Exception:
        storage_ok = False

    return {"ok": db_ok and storage_ok, "db": db_ok, "storage": storage_ok}

"""Historical spectrogram tiles — render & lazy-cache.

Each tile is one device-hour as an 8-bit grayscale PNG, 30 rows × 3600 cols.
Row 0 is the highest 1/3-octave band (matches the live spectrogram's display
order so the historical and live ribbons line up visually under the same
palette). Pixel value 0 is reserved for "no data" so sensor outages render as
the palette floor; values 1..255 map linearly to ``[TILE_DB_MIN, TILE_DB_MAX]``.

Closed hours are immutable and cached in S3; the current (in-progress) hour
is regenerated on every request and never persisted.
"""

from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone
from uuid import UUID

from PIL import Image
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .contracts import SPECTROGRAM_N_BANDS
from .storage import Storage


# These constants form the wire contract between the backend (which quantises)
# and the frontend (which colour-maps). They are also surfaced in the history
# manifest so the client cannot drift from them.
TILE_DB_MIN: float = 20.0
TILE_DB_MAX: float = 110.0
TILE_ROWS: int = SPECTROGRAM_N_BANDS  # 30
TILE_COLS: int = 3600  # one column per second of the hour
_QUANT_SCALE: float = 254.0 / (TILE_DB_MAX - TILE_DB_MIN)


# Built once: ``MAX(bands[1]) AS b1, MAX(bands[2]) AS b2, ...`` — Postgres
# arrays are 1-indexed.
_BAND_MAX_COLS = ", ".join(f"MAX(bands[{i + 1}]) AS b{i}" for i in range(TILE_ROWS))

_BUCKET_SQL = text(
    f"""
    SELECT
        EXTRACT(EPOCH FROM time_bucket(INTERVAL '1 second', ts))::bigint AS bucket_epoch,
        {_BAND_MAX_COLS}
    FROM spectrogram_frames
    WHERE device_id = :device_id
      AND ts >= :hour_start
      AND ts <  :hour_end
    GROUP BY bucket_epoch
    """
)


def floor_hour_utc(dt: datetime) -> datetime:
    """Truncate to the UTC hour boundary."""
    d = dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return d.replace(minute=0, second=0, microsecond=0)


def _quantise(db: float) -> int:
    """Map a dB value to [1, 255]. 0 is reserved for "no data"."""
    v = int(round((db - TILE_DB_MIN) * _QUANT_SCALE)) + 1
    if v < 1:
        return 1
    if v > 255:
        return 255
    return v


async def render_tile(
    session: AsyncSession, device_id: UUID, hour_start: datetime
) -> bytes:
    """Render the PNG bytes for a single (device, hour). Pure compute + read."""
    hour_start = floor_hour_utc(hour_start)
    hour_end = hour_start + timedelta(hours=1)
    hour_epoch = int(hour_start.timestamp())

    result = await session.execute(
        _BUCKET_SQL,
        {"device_id": device_id, "hour_start": hour_start, "hour_end": hour_end},
    )

    # Row-major, 30 rows × 3600 cols, zero-initialised ("no data").
    buf = bytearray(TILE_ROWS * TILE_COLS)

    for row in result:
        col = int(row.bucket_epoch) - hour_epoch
        if col < 0 or col >= TILE_COLS:
            continue
        # row.b0..b29 are the band MAXs at this 1s bucket. Flip the band axis
        # so high frequencies sit at row 0 (matches the live spectrogram).
        for band_idx in range(TILE_ROWS):
            db = getattr(row, f"b{band_idx}")
            if db is None:
                continue
            display_row = TILE_ROWS - 1 - band_idx
            buf[display_row * TILE_COLS + col] = _quantise(db)

    img = Image.frombytes("L", (TILE_COLS, TILE_ROWS), bytes(buf))
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue()


async def get_or_generate_tile(
    session: AsyncSession,
    storage: Storage,
    device_id: UUID,
    hour_start: datetime,
    *,
    is_current_hour: bool,
) -> bytes:
    """Return tile bytes, populating S3 on first miss for closed hours.

    The current (in-progress) hour is always regenerated and never persisted —
    persisting would freeze a wrong snapshot in S3 the moment the hour rolls.
    """
    hour_start = floor_hour_utc(hour_start)

    if is_current_hour:
        return await render_tile(session, device_id, hour_start)

    key = storage.spectrogram_tile_key(device_id, hour_start)
    cached = await storage.get_bytes(key)
    if cached is not None:
        return cached

    png = await render_tile(session, device_id, hour_start)
    # Idempotent: a concurrent request may also be writing the same bytes —
    # last-writer-wins is fine because the content is deterministic.
    await storage.put_bytes(key, png, content_type="image/png")
    return png

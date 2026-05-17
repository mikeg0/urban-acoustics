"""/api/v1/devices/{id}/health — historical device-health metrics.

Mirrors the telemetry read endpoint ([telemetry.py]) — same window-cap policy
and the same time_bucket aggregation, but the per-field reducer is chosen for
what each metric actually means: MAX for "worst-in-bucket" stress signals
(cpu_temp_c, queue_depth, queue_bytes), MIN for headroom-style metrics
(wifi_rssi_dbm, disk_free_mb), AVG for the rest, and "latest in bucket" for
the string version fields. `device_health` is a regular table, not a
hypertable, so we use ``array_agg(... ORDER BY ts DESC)[1]`` for the latest
trick — no Timescale hyperfunctions needed.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ...contracts import HealthPoint, HealthReadResponse, HealthResolution
from ...db import get_session
from ...models import Device

router = APIRouter()

# Resolution → (Postgres interval literal, max window in seconds). Window caps
# match telemetry's: 24 h / 30 d / 365 d.
_RESOLUTIONS: dict[HealthResolution, tuple[str | None, int]] = {
    HealthResolution.RAW: (None, 24 * 3600),
    HealthResolution.ONE_MINUTE: ("1 minute", 30 * 24 * 3600),
    HealthResolution.ONE_HOUR: ("1 hour", 365 * 24 * 3600),
}


@router.get("/devices/{device_id}/health", response_model=HealthReadResponse)
async def get_device_health(
    device_id: UUID,
    from_: float = Query(..., alias="from", description="Unix seconds, inclusive"),
    to: float = Query(..., description="Unix seconds, exclusive"),
    res: HealthResolution = Query(HealthResolution.ONE_MINUTE),
    session: AsyncSession = Depends(get_session),
) -> HealthReadResponse:
    if to <= from_:
        raise HTTPException(status_code=400, detail="`to` must be greater than `from`")
    bucket, max_window = _RESOLUTIONS[res]
    if (to - from_) > max_window:
        raise HTTPException(
            status_code=400,
            detail=f"window too large for resolution {res.value}: max {max_window}s",
        )

    if await session.get(Device, device_id) is None:
        raise HTTPException(status_code=404, detail="device not found")

    from_dt = datetime.fromtimestamp(from_, tz=timezone.utc)
    to_dt = datetime.fromtimestamp(to, tz=timezone.utc)

    if bucket is None:
        sql = text(
            """
            SELECT ts, uptime_s, cpu_pct, cpu_temp_c, mem_used_mb, disk_free_mb,
                   wifi_rssi_dbm, queue_depth, queue_bytes, mic_gain_db,
                   ntp_offset_ms, fw_version, config_version
            FROM device_health
            WHERE device_id = :device_id AND ts >= :from_dt AND ts < :to_dt
            ORDER BY ts
            """
        )
    else:
        # Bucket literal interpolated rather than parametrised — time_bucket
        # takes an interval and the value comes from a closed enum, so no
        # injection surface. queue_depth/queue_bytes round to int after MAX
        # since the aggregate keeps the underlying int type.
        sql = text(
            f"""
            SELECT
              time_bucket(INTERVAL '{bucket}', ts)            AS ts,
              AVG(uptime_s)::float8                           AS uptime_s,
              AVG(cpu_pct)::float8                            AS cpu_pct,
              MAX(cpu_temp_c)::float8                         AS cpu_temp_c,
              AVG(mem_used_mb)::float8                        AS mem_used_mb,
              MIN(disk_free_mb)::float8                       AS disk_free_mb,
              MIN(wifi_rssi_dbm)::float8                      AS wifi_rssi_dbm,
              MAX(queue_depth)                                AS queue_depth,
              MAX(queue_bytes)                                AS queue_bytes,
              AVG(mic_gain_db)::float8                        AS mic_gain_db,
              AVG(ntp_offset_ms)::float8                      AS ntp_offset_ms,
              (array_agg(fw_version ORDER BY ts DESC))[1]     AS fw_version,
              (array_agg(config_version ORDER BY ts DESC))[1] AS config_version
            FROM device_health
            WHERE device_id = :device_id AND ts >= :from_dt AND ts < :to_dt
            GROUP BY 1
            ORDER BY 1
            """
        )

    params = {"device_id": device_id, "from_dt": from_dt, "to_dt": to_dt}
    result = await session.execute(sql, params)
    points = [
        HealthPoint(
            ts=row.ts.timestamp(),
            uptime_s=row.uptime_s,
            cpu_pct=row.cpu_pct,
            cpu_temp_c=row.cpu_temp_c,
            mem_used_mb=row.mem_used_mb,
            disk_free_mb=row.disk_free_mb,
            wifi_rssi_dbm=row.wifi_rssi_dbm,
            queue_depth=row.queue_depth,
            queue_bytes=row.queue_bytes,
            mic_gain_db=row.mic_gain_db,
            ntp_offset_ms=row.ntp_offset_ms,
            fw_version=row.fw_version,
            config_version=row.config_version,
        )
        for row in result
    ]
    return HealthReadResponse(
        device_id=device_id,
        resolution=res,
        from_ts=from_,
        to_ts=to,
        points=points,
    )

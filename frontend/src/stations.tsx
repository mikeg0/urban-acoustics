import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource } from 'maplibre-gl';
import { Map as MapLibreMap, NavigationControl, type MapRef } from 'react-map-gl/maplibre';
import { fetchCameras, fetchDevices, fetchTelemetry } from './api';
import { Card } from './atoms';
import { CameraSnapshot } from './cameras';
import { Clock, UserChip } from './chrome';
import { SettingsButton, SettingsDialog } from './settings';
import {
  CORRIDOR_BOUNDS,
  CORRIDOR_CENTER,
  CORRIDOR_INITIAL_ZOOM,
  CORRIDOR_MAX_ZOOM,
  CORRIDOR_MIN_ZOOM,
  MAP_STYLE,
} from './mapConfig';
import type { CameraInfo, DeviceInfo } from './types';
import { addBloomLayers, dbToHeatWeight, loadBloomIcons } from './uqiHeatmap';

// Mic ↔ camera proximity used for popovers. Matches the API's
// NEAR_RADIUS_M (cameras.py) so what we paint here matches what
// /devices/{id}/nearest-camera returns when other views call it.
const CAMERA_NEAR_RADIUS_M = 150;

function _haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6_371_000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

// Build a device → nearest-camera lookup. We do this in JS once after
// both lists arrive instead of hitting /nearest-camera once per pin —
// the cameras table has at most a few dozen rows and devices is the
// same order of magnitude, so O(n*m) is trivial.
function buildDeviceCameraMap(
  devices: DeviceInfo[],
  cameras: CameraInfo[],
): Map<string, CameraInfo> {
  const out = new Map<string, CameraInfo>();
  if (cameras.length === 0) return out;
  for (const d of devices) {
    if (d.lat == null || d.lon == null) continue;
    let best: { d: number; c: CameraInfo } | null = null;
    for (const c of cameras) {
      const dist = _haversineM(d.lat, d.lon, c.lat, c.lon);
      if (dist > CAMERA_NEAR_RADIUS_M) continue;
      if (best == null || dist < best.d) best = { d: dist, c };
    }
    if (best != null) out.set(d.device_id, best.c);
  }
  return out;
}

// Color ramp for current dB readings. Mirrors stations.jsx::colorFor from the
// design (oklch ramp from quiet teal up to hot red-orange) so legend swatches
// match what's painted on the pins. Offline pins use a muted gray; online
// stations without a current reading get a dim teal so the map distinguishes
// "live but idle" from "down for maintenance".
const OFFLINE_COLOR = 'oklch(42% 0.01 60)';
const ONLINE_IDLE_COLOR = 'oklch(58% 0.06 195)';

function colorForDb(db: number | null, online: boolean): string {
  if (!online) return OFFLINE_COLOR;
  if (db == null) return ONLINE_IDLE_COLOR;
  if (db >= 75) return 'oklch(72% 0.2 35)';
  if (db >= 65) return 'oklch(82% 0.16 70)';
  if (db >= 55) return 'oklch(78% 0.14 130)';
  return 'oklch(72% 0.13 195)';
}

// Same ramp, used for the right-hand list's `NOW` cell — the design ramps the
// text itself, not a pill, so we pass the raw oklch through.
function dbTextColor(db: number | null): string {
  if (db == null) return 'var(--ink-3)';
  return colorForDb(db, true);
}

// Each station has a placeholder for the live readout until we wire up a
// per-device summary endpoint. Status defaults to online; if a device row has
// no lat/lon it's hidden from the map (and rendered in the list as
// "unplaced") rather than guessed at.
type StationDb = number | null;
type StationStatus = 'online' | 'maintenance';

interface StationRow {
  device: DeviceInfo;
  db: StationDb;
  breaches7d: number | null;
  status: StationStatus;
}

// A station is "online" when ingest has seen traffic from it recently.
// last_seen is server time (Unix seconds); the 5-minute window absorbs
// missed beats, the refetch cadence, and modest client clock skew.
export const ONLINE_THRESHOLD_S = 300;

function toRow(d: DeviceInfo): StationRow {
  const online = isDeviceOnline(d);
  return {
    device: d,
    db: null,
    breaches7d: null,
    status: online ? 'online' : 'maintenance',
  };
}

// Short, mono-friendly station id pulled from the device name when it starts
// with "UQI-…". Devices not seeded by the pilot script fall back to the first
// 8 chars of the UUID.
export function stationCode(d: DeviceInfo): string {
  if (d.name) {
    const m = d.name.match(/^(UQI-[A-Z0-9-]+)/);
    if (m) return m[1];
  }
  return d.device_id.slice(0, 8);
}

export function isDeviceOnline(d: DeviceInfo | null): boolean {
  return (
    d != null &&
    d.last_seen != null &&
    Date.now() / 1000 - d.last_seen < ONLINE_THRESHOLD_S
  );
}

// Strip the "UQI-XX-NN · " prefix so the displayed station name reads
// naturally ("100 S & State", not "UQI-ST-02 · 100 S & State"). The full
// code lives in the chip next to the name.
function displayName(d: DeviceInfo): string {
  if (!d.name) return '(unnamed)';
  const idx = d.name.indexOf(' · ');
  return idx >= 0 ? d.name.slice(idx + 3) : d.name;
}

// Tooltip rendered outside the marker layer. maplibre re-sets each marker's
// z-index based on its on-screen latitude on every map render, which means
// a tooltip nested inside a <Marker> can never reliably overlay neighbors.
// We project the hovered station's lat/lon into pixel space and absolutely
// position the tooltip in a top-level overlay above the map's canvas.
function HoverTooltip({
  row,
  camera,
  mapRef,
}: {
  row: StationRow;
  camera: CameraInfo | null;
  mapRef: React.MutableRefObject<MapRef | null>;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const m = mapRef.current?.getMap();
    if (!m) return;
    const update = () => {
      const lng = row.device.lon;
      const lat = row.device.lat;
      if (lng == null || lat == null) return;
      const p = m.project([lng, lat]);
      setPos({ x: p.x, y: p.y });
    };
    update();
    m.on('move', update);
    m.on('zoom', update);
    return () => {
      m.off('move', update);
      m.off('zoom', update);
    };
  }, [row.device.device_id, row.device.lat, row.device.lon, mapRef]);

  if (!pos) return null;
  const offline = row.status !== 'online';
  const dbColor = colorForDb(row.db, !offline);
  // The station glyph is anchored on the lat/lon; sit the tooltip just below it.
  return (
    <div
      style={{
        position: 'absolute',
        left: pos.x,
        top: pos.y + 14,
        transform: 'translateX(-50%)',
        background: 'var(--bg-0)',
        border: '1px solid var(--line-strong)',
        borderRadius: 4,
        padding: camera ? 6 : '5px 9px',
        fontSize: 11,
        color: 'var(--ink-0)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
        // maplibre marker z-indexes are computed from screen-y * 1000, so
        // they can climb into the thousands — sit comfortably above that.
        zIndex: 10_000_000,
        pointerEvents: 'none',
      }}
    >
      {camera && (
        <div style={{ marginBottom: 5 }}>
          <CameraSnapshot camera={camera} size="thumb" showCaption={false} />
        </div>
      )}
      <div style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{displayName(row.device)}</div>
      <div
        className="mono"
        style={{ fontSize: 9, color: 'var(--ink-3)', marginTop: 1, whiteSpace: 'nowrap' }}
      >
        {stationCode(row.device)}
        {row.device.location ? ` · ${row.device.location}` : ''}
      </div>
      {row.db != null && (
        <div
          className="mono"
          style={{
            marginTop: 4,
            fontSize: 20,
            fontWeight: 600,
            color: dbColor,
            lineHeight: 1,
            whiteSpace: 'nowrap',
          }}
        >
          {row.db.toFixed(1)}
          <span style={{ fontSize: 10, color: 'var(--ink-3)', marginLeft: 3 }}>dB</span>
        </div>
      )}
    </div>
  );
}

function StationMap({
  rows,
  deviceCameraMap,
  hovered,
  onHover,
  onPick,
}: {
  rows: StationRow[];
  deviceCameraMap: Map<string, CameraInfo>;
  hovered: string | null;
  onHover: (id: string | null) => void;
  onPick: (d: DeviceInfo) => void;
}) {
  const mapRef = useRef<MapRef | null>(null);
  const loadedRef = useRef(false);

  const placed = useMemo(
    () => rows.filter((r) => r.device.lat != null && r.device.lon != null),
    [rows],
  );
  const hoveredRow = useMemo(
    () => placed.find((r) => r.device.device_id === hovered) ?? null,
    [placed, hovered],
  );

  // Live geojson feeding the bloom + glyph layers (same effect as the login
  // backdrop, but data-driven). `weight` tracks the current dB so louder
  // stations bloom larger/denser; `has_camera` selects the cam+mic glyph;
  // `online` dims offline stations. Offline/idle stations carry weight 0, so
  // they show a glyph but no glow.
  const featureCollection = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: placed.map((r) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [r.device.lon as number, r.device.lat as number],
        },
        properties: {
          device_id: r.device.device_id,
          code: stationCode(r.device),
          online: r.status === 'online',
          has_camera: deviceCameraMap.has(r.device.device_id),
          weight: r.status === 'online' && r.db != null ? dbToHeatWeight(r.db) : 0,
        },
      })),
    }),
    [placed, deviceCameraMap],
  );

  // The maplibre layer event handlers are registered once on load, so they read
  // current props/data through refs to avoid stale closures.
  const fcRef = useRef(featureCollection);
  const rowsRef = useRef(placed);
  const onPickRef = useRef(onPick);
  const onHoverRef = useRef(onHover);
  useEffect(() => {
    rowsRef.current = placed;
    onPickRef.current = onPick;
    onHoverRef.current = onHover;
  }, [placed, onPick, onHover]);

  // Push live data into the source whenever readings/cameras change.
  useEffect(() => {
    fcRef.current = featureCollection;
    const map = mapRef.current?.getMap();
    if (!map || !loadedRef.current) return;
    (map.getSource('uqi-stations') as GeoJSONSource | undefined)?.setData(featureCollection);
  }, [featureCollection]);

  const onLoad = () => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    loadBloomIcons(map);
    if (!map.getSource('uqi-stations')) {
      map.addSource('uqi-stations', { type: 'geojson', data: fcRef.current });
      addBloomLayers(map, 'uqi-stations');
    }
    const micLayer = 'uqi-stations-mics';
    map.on('click', micLayer, (e) => {
      const id = e.features?.[0]?.properties?.device_id as string | undefined;
      if (!id) return;
      const dev = rowsRef.current.find((r) => r.device.device_id === id)?.device;
      if (dev) onPickRef.current(dev);
    });
    map.on('mouseenter', micLayer, (e) => {
      map.getCanvas().style.cursor = 'pointer';
      const id = e.features?.[0]?.properties?.device_id as string | undefined;
      onHoverRef.current(id ?? null);
    });
    map.on('mousemove', micLayer, (e) => {
      const id = e.features?.[0]?.properties?.device_id as string | undefined;
      if (id) onHoverRef.current(id);
    });
    map.on('mouseleave', micLayer, () => {
      map.getCanvas().style.cursor = '';
      onHoverRef.current(null);
    });
    loadedRef.current = true;
  };

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        flex: 1,
        minHeight: 0,
        background: 'var(--bg-1)',
        border: '1px solid var(--line)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <MapLibreMap
        ref={mapRef}
        initialViewState={{
          longitude: CORRIDOR_CENTER[0],
          latitude: CORRIDOR_CENTER[1],
          zoom: CORRIDOR_INITIAL_ZOOM,
        }}
        maxBounds={CORRIDOR_BOUNDS}
        minZoom={CORRIDOR_MIN_ZOOM}
        maxZoom={CORRIDOR_MAX_ZOOM}
        mapStyle={MAP_STYLE}
        attributionControl={true}
        style={{ width: '100%', height: '100%' }}
        onLoad={onLoad}
      >
        <NavigationControl position="top-right" showCompass={false} />
      </MapLibreMap>
      {hoveredRow && (
        <HoverTooltip
          row={hoveredRow}
          camera={deviceCameraMap.get(hoveredRow.device.device_id) ?? null}
          mapRef={mapRef}
        />
      )}
    </div>
  );
}

function MapLegend() {
  return (
    <div
      className="mono"
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: 10,
        color: 'var(--ink-3)',
        letterSpacing: '0.1em',
        flexWrap: 'wrap',
        gap: 8,
      }}
    >
      <div style={{ display: 'inline-flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          QUIET
          <span
            style={{
              width: 96,
              height: 8,
              borderRadius: 4,
              // Mirrors the heatmap-color ramp in addBloomLayers().
              background:
                'linear-gradient(90deg, rgba(98,0,234,0.85), rgba(255,0,122,0.9), rgba(255,80,0,0.95), rgba(255,180,0,0.95), rgba(255,240,200,1))',
            }}
          />
          LOUD
        </span>
        <span>MIC = STATION</span>
        <span>CAM+MIC = + CAMERA</span>
        <span>DIM = OFFLINE</span>
      </div>
      <span>MAPLIBRE · CARTO · OPENSTREETMAP</span>
    </div>
  );
}

// Window used to pull the most recent LAeq for the map/list `NOW` cell.
// 5 minutes is short enough to feel live but long enough to ride out a few
// dropped 1-minute buckets without flipping the pin to "—".
const LATEST_WINDOW_S = 5 * 60;
const LATEST_POLL_MS = 30_000;
const DEVICES_REFRESH_MS = 60_000;

export function StationListView({
  onPick,
  onPickLive,
}: {
  onPick: (d: DeviceInfo) => void;
  // Map pin clicks route here when provided (live view); list rows use onPick.
  onPickLive?: (d: DeviceInfo) => void;
}) {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);
  // Session panel's Settings dialog. No device is selected on the overview,
  // so the dialog runs in its no-device "demo" mode: display preferences
  // (palette, time format, anomaly sensitivity) apply globally, while the
  // device-backed threshold/pause controls disable themselves.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsThreshold, setSettingsThreshold] = useState(80);
  const [settingsPaused, setSettingsPaused] = useState(false);
  // Keyed by device_id. Only populated for online stations; offline pins
  // stay at null so they keep their gray "offline" rendering.
  const [latestDb, setLatestDb] = useState<Record<string, number | null>>({});

  useEffect(() => {
    let cancelled = false;
    // Refetch on an interval so last_seen (and thus online-ness) stays
    // current on a long-open page. A transient refetch failure keeps the
    // last good list rather than blanking the view.
    const load = (initial: boolean) => {
      fetchDevices()
        .then((d) => {
          if (!cancelled) setDevices(d);
        })
        .catch((e: Error) => {
          if (!cancelled && initial) setError(e.message);
        });
    };
    load(true);
    const refetchId = setInterval(() => load(false), DEVICES_REFRESH_MS);
    // Cameras are independent and small — fetch in parallel. A failure here
    // shouldn't block the station list, so swallow errors and leave the
    // cameras array empty.
    fetchCameras()
      .then((c) => {
        if (!cancelled) setCameras(c);
      })
      .catch(() => {
        /* no cameras = camera UI hides itself */
      });
    return () => {
      cancelled = true;
      clearInterval(refetchId);
    };
  }, []);

  const deviceCameraMap = useMemo(
    () => (devices ? buildDeviceCameraMap(devices, cameras) : new Map<string, CameraInfo>()),
    [devices, cameras],
  );

  // Poll latest LAeq for online stations only — there's no point asking the
  // backend about devices we already know are placeholders. The window/poll
  // cadence is short so the dashboard's NOW column matches the live view.
  useEffect(() => {
    if (!devices) return;
    const onlineDevices = devices.filter((d) => isDeviceOnline(d));
    if (onlineDevices.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      const now = Date.now() / 1000;
      const results = await Promise.all(
        onlineDevices.map(async (d) => {
          try {
            const r = await fetchTelemetry(d.device_id, now - LATEST_WINDOW_S, now, '1m');
            const newest = r.points[r.points.length - 1];
            return [d.device_id, newest ? newest.laeq : null] as const;
          } catch {
            return [d.device_id, null] as const;
          }
        }),
      );
      if (cancelled) return;
      setLatestDb((prev) => {
        const next = { ...prev };
        for (const [id, db] of results) next[id] = db;
        return next;
      });
    };
    tick();
    const id = setInterval(tick, LATEST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [devices]);

  const rows: StationRow[] = useMemo(
    () => (devices
      ? devices.map((d) => {
        const row = toRow(d);
        if (row.status === 'online') {
          const db = latestDb[d.device_id];
          if (db != null) row.db = db;
        }
        return row;
      })
      : []),
    [devices, latestDb],
  );

  // Placed = has lat/lon. The map shows only these; the list shows everything
  // but the corridor seed makes "everything" and "placed" nearly identical.
  const placedRows = useMemo(
    () => rows.filter((r) => r.device.lat != null && r.device.lon != null),
    [rows],
  );

  const filtered = useMemo(() => {
    if (!query) return rows;
    const q = query.toLowerCase();
    return rows.filter((r) => {
      const d = r.device;
      return (
        (d.name ?? '').toLowerCase().includes(q) ||
        (d.location ?? '').toLowerCase().includes(q) ||
        d.device_id.toLowerCase().includes(q) ||
        stationCode(d).toLowerCase().includes(q)
      );
    });
  }, [rows, query]);

  const totalDevices = rows.length;
  const onlineCount = placedRows.filter((r) => r.status === 'online').length;

  return (
    <>
    <div
      style={{
        height: '100vh',
        display: 'grid',
        gridTemplateColumns: '1fr 460px',
        gridTemplateRows: 'auto minmax(0, 1fr)',
        gap: 14,
        padding: 14,
        minHeight: 0,
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          gridColumn: '1 / -1',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 14,
          flexWrap: 'wrap',
          padding: '10px 14px',
          background: 'var(--bg-1)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--rad-lg)',
        }}
      >
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-2)' }}>
            STATION NETWORK · SALT LAKE CITY
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-1)', marginTop: 2 }}>
            Urban Quiet Initiative pilot corridor · State St, N Temple → 900 S · click a pin or row to drill in
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div className="mono" style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--ink-3)' }}>
            <span>
              <span style={{ color: 'var(--ink-1)' }}>{onlineCount}</span>/{placedRows.length} ONLINE
            </span>
            <span>
              AVG <span style={{ color: 'var(--ink-1)' }}>— dB</span>
            </span>
            <span>— BREACH HRS · 7D</span>
          </div>
          <div style={{ width: 1, height: 28, background: 'var(--line)' }} />
          <Clock />
          <SettingsButton onClick={() => setSettingsOpen(true)} />
          <UserChip />
        </div>
      </div>

      <Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}>
          {error && (
            <div
              className="mono"
              style={{
                padding: 12,
                fontSize: 11,
                color: 'var(--neon-hot)',
                border: '1px solid var(--line)',
                borderRadius: 6,
                background: 'var(--bg-2)',
              }}
            >
              Failed to load stations: {error}
            </div>
          )}
          <StationMap
            rows={placedRows}
            deviceCameraMap={deviceCameraMap}
            hovered={hovered}
            onHover={setHovered}
            onPick={onPickLive ?? onPick}
          />
          <MapLegend />
        </div>
      </Card>

      <Card
        title="ALL STATIONS"
        subtitle={`${filtered.length} of ${totalDevices} shown`}
        right={
          <input
            type="text"
            placeholder="Filter by name, district, ID…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              background: 'var(--bg-1)',
              border: '1px solid var(--line)',
              borderRadius: 4,
              padding: '4px 8px',
              fontSize: 11,
              color: 'var(--ink-0)',
              fontFamily: 'var(--mono)',
              width: 180,
              outline: 'none',
            }}
          />
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 64px 64px',
              gap: 10,
              padding: '0 8px 8px',
              borderBottom: '1px solid var(--line)',
              fontFamily: 'var(--mono)',
              fontSize: 9,
              color: 'var(--ink-3)',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            <span>Station</span>
            <span style={{ textAlign: 'right' }}>Now</span>
            <span style={{ textAlign: 'right' }}>Breach·7d</span>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {devices == null && !error && (
              <div
                className="mono"
                style={{ padding: 24, textAlign: 'center', color: 'var(--ink-3)', fontSize: 11 }}
              >
                LOADING…
              </div>
            )}
            {filtered.map((row) => {
              const s = row.device;
              const isHover = hovered === s.device_id;
              const offline = row.status !== 'online';
              return (
                <div
                  key={s.device_id}
                  onMouseEnter={() => setHovered(s.device_id)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => onPick(s)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 64px 64px',
                    gap: 10,
                    padding: '10px 8px',
                    borderBottom: '1px solid var(--line)',
                    cursor: 'pointer',
                    background: isHover ? 'var(--bg-2)' : 'transparent',
                    transition: 'background 120ms',
                    alignItems: 'center',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: offline ? 'oklch(50% 0.02 60)' : 'oklch(72% 0.18 145)',
                        boxShadow: offline ? 'none' : '0 0 6px oklch(72% 0.18 145)',
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--ink-0)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {displayName(s)}
                        <span
                          className="mono"
                          style={{ fontSize: 10, color: 'var(--ink-3)', marginLeft: 6 }}
                        >
                          ({stationCode(s)})
                        </span>
                      </div>
                      <div
                        className="mono"
                        style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 1 }}
                      >
                        {s.location ?? '— unplaced —'}
                        {offline ? ' · MAINTENANCE' : ''}
                      </div>
                    </div>
                  </div>
                  <div
                    className="mono"
                    style={{
                      textAlign: 'right',
                      fontSize: 13,
                      color: dbTextColor(row.db),
                    }}
                  >
                    {row.db == null ? '—' : row.db.toFixed(1)}
                    {row.db != null && (
                      <span style={{ fontSize: 9, color: 'var(--ink-3)', marginLeft: 2 }}>dB</span>
                    )}
                  </div>
                  <div
                    className="mono"
                    style={{
                      textAlign: 'right',
                      fontSize: 12,
                      color:
                        row.breaches7d == null
                          ? 'var(--ink-3)'
                          : row.breaches7d > 10
                            ? 'var(--neon-hot)'
                            : row.breaches7d > 0
                              ? 'var(--ink-1)'
                              : 'var(--ink-3)',
                    }}
                  >
                    {row.breaches7d == null ? '—' : row.breaches7d}
                  </div>
                </div>
              );
            })}
            {devices != null && filtered.length === 0 && (
              <div
                className="mono"
                style={{ padding: 24, textAlign: 'center', color: 'var(--ink-3)', fontSize: 11 }}
              >
                No stations match "{query}"
              </div>
            )}
            <div
              className="mono"
              style={{
                padding: '10px 8px',
                textAlign: 'center',
                fontSize: 10,
                color: 'var(--ink-3)',
                letterSpacing: '0.12em',
              }}
            >
              SHOWING {filtered.length} STATION{filtered.length !== 1 ? 'S' : ''}
            </div>
          </div>
        </div>
      </Card>
    </div>
    <SettingsDialog
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      deviceId={null}
      deviceThreshold={settingsThreshold}
      onDeviceThresholdChange={setSettingsThreshold}
      devicePaused={settingsPaused}
      onDevicePausedChange={setSettingsPaused}
      appliedConfigVersion={null}
    />
    </>
  );
}

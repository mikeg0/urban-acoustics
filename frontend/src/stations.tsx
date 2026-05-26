import { useEffect, useMemo, useRef, useState } from 'react';
import { Map as MapLibreMap, Marker, NavigationControl, type MapRef } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { fetchCameras, fetchDevices, fetchTelemetry } from './api';
import { Card } from './atoms';
import { CameraSnapshot } from './cameras';
import type { CameraInfo, DeviceInfo } from './types';

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

// Urban Quiet Initiative pilot corridor lives inside downtown SLC; we clamp
// the map to a downtown bbox (roughly Capitol → Ballpark, Rio Grande → 700
// East) so the corridor sits in context but the user can't wander to the
// rest of the world. The bbox is wide enough that `minZoom` actually bites
// before maxBounds clamping does.
const CORRIDOR_BOUNDS: [[number, number], [number, number]] = [
  [-111.9300, 40.7400],
  [-111.8500, 40.7850],
];

const CORRIDOR_CENTER: [number, number] = [-111.8881, 40.7616];
const CORRIDOR_INITIAL_ZOOM = 12.8;
const CORRIDOR_MIN_ZOOM = 12;
const CORRIDOR_MAX_ZOOM = 18;

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

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

// Pilot rollout: only the first sensor (200 S & State, UQI-ST-03) is in the
// field reporting. Other corridor sites are placeholders shown offline.
const ONLINE_STATION_CODES = new Set(['UQI-ST-03']);

function toRow(d: DeviceInfo): StationRow {
  const online = ONLINE_STATION_CODES.has(stationCode(d));
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
  return d != null && ONLINE_STATION_CODES.has(stationCode(d));
}

// Strip the "UQI-XX-NN · " prefix so the displayed station name reads
// naturally ("100 S & State", not "UQI-ST-02 · 100 S & State"). The full
// code lives in the chip next to the name.
function displayName(d: DeviceInfo): string {
  if (!d.name) return '(unnamed)';
  const idx = d.name.indexOf(' · ');
  return idx >= 0 ? d.name.slice(idx + 3) : d.name;
}

// Camera glyph used both for standalone camera markers and inline inside
// station pins that have a nearby camera. Sized to fit on the pin without
// dominating the dB readout.
function CameraGlyph({ size = 10, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={color}
      style={{ display: 'block' }}
    >
      <path d="M2 4 L10 4 L10 12 L2 12 Z M10 6 L14 4 L14 12 L10 10 Z" />
    </svg>
  );
}

function StationPin({
  row,
  hasCamera,
  hovered,
  onHover,
  onPick,
}: {
  row: StationRow;
  hasCamera: boolean;
  hovered: boolean;
  onHover: (id: string | null) => void;
  onPick: (d: DeviceInfo) => void;
}) {
  const { device, db, status } = row;
  const offline = status !== 'online';
  const c = colorForDb(db, !offline);
  return (
    <div
      onMouseEnter={() => onHover(device.device_id)}
      onMouseLeave={() => onHover(null)}
      onClick={(e) => {
        e.stopPropagation();
        onPick(device);
      }}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        cursor: 'pointer',
        // Pin's tip sits on the lat/lon; whole element shifts so the tail
        // anchors at the marker origin (Marker centers by default).
        transform: 'translateY(-50%)',
      }}
    >
      <div
        style={{
          background: c,
          color: '#0a0a0a',
          fontFamily: 'var(--mono)',
          fontWeight: 600,
          fontSize: 11,
          padding: '4px 7px',
          borderRadius: 14,
          border: `2px solid ${hovered ? 'var(--ink-0)' : 'rgba(0,0,0,0.3)'}`,
          boxShadow: '0 4px 10px rgba(0,0,0,0.5)',
          minWidth: 30,
          textAlign: 'center',
          transition: 'all 120ms',
          transform: hovered ? 'scale(1.15)' : 'scale(1)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 1,
          lineHeight: 1,
        }}
      >
        {hasCamera ? (
          <CameraGlyph size={11} color="#0a0a0a" />
        ) : (
          <span>—</span>
        )}
      </div>
      <svg width="14" height="9" viewBox="0 0 14 9" style={{ marginTop: -2 }}>
        <path d="M 7 9 L 0 0 L 14 0 Z" fill={c} />
      </svg>
    </div>
  );
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
  // Pin uses anchor="bottom" + translateY(-50%), so its body floats ~15px
  // above lat/lon. Render the tooltip just below that — a small gap below
  // the tail tip — matching the in-marker tooltip's old position.
  return (
    <div
      style={{
        position: 'absolute',
        left: pos.x,
        top: pos.y - 10,
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

// Camera pin: smaller, dimmer than mic pins so it visually sits under
// the station network. The dot is anchored to the camera's lat/lon
// (anchor="center"), no tail.
function CameraPin({
  hovered,
  onHover,
}: {
  hovered: boolean;
  onHover: (id: number | null) => void;
}) {
  return (
    <div
      style={{
        width: hovered ? 14 : 12,
        height: hovered ? 14 : 12,
        borderRadius: 3,
        background: 'var(--bg-0)',
        border: `1.5px solid ${hovered ? 'var(--ink-0)' : 'var(--ink-3)'}`,
        boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
        cursor: 'pointer',
        transition: 'all 100ms',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: hovered ? 'var(--ink-0)' : 'var(--ink-3)',
      }}
      onMouseEnter={() => onHover(null)}
      onMouseLeave={() => onHover(null)}
    >
      <CameraGlyph size={8} />
    </div>
  );
}

function CameraHoverTooltip({
  camera,
  mapRef,
}: {
  camera: CameraInfo;
  mapRef: React.MutableRefObject<MapRef | null>;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const m = mapRef.current?.getMap();
    if (!m) return;
    const update = () => {
      const p = m.project([camera.lon, camera.lat]);
      setPos({ x: p.x, y: p.y });
    };
    update();
    m.on('move', update);
    m.on('zoom', update);
    return () => {
      m.off('move', update);
      m.off('zoom', update);
    };
  }, [camera.camera_id, camera.lat, camera.lon, mapRef]);
  if (!pos) return null;
  const caption = [camera.roadway, camera.direction].filter(Boolean).join(' · ');
  return (
    <div
      style={{
        position: 'absolute',
        left: pos.x,
        top: pos.y + 10,
        transform: 'translateX(-50%)',
        background: 'var(--bg-0)',
        border: '1px solid var(--line-strong)',
        borderRadius: 4,
        padding: 6,
        boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
        zIndex: 10_000_000,
        pointerEvents: 'none',
      }}
    >
      <CameraSnapshot camera={camera} size="thumb" showCaption={false} />
      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--ink-0)', whiteSpace: 'nowrap' }}>
        {caption || `UDOT camera ${camera.camera_id}`}
      </div>
      {camera.location && (
        <div
          className="mono"
          style={{ fontSize: 9, color: 'var(--ink-3)', marginTop: 1, whiteSpace: 'nowrap' }}
        >
          {camera.location}
        </div>
      )}
    </div>
  );
}

function StationMap({
  rows,
  cameras,
  deviceCameraMap,
  hovered,
  onHover,
  onPick,
}: {
  rows: StationRow[];
  cameras: CameraInfo[];
  deviceCameraMap: Map<string, CameraInfo>;
  hovered: string | null;
  onHover: (id: string | null) => void;
  onPick: (d: DeviceInfo) => void;
}) {
  const mapRef = useRef<MapRef | null>(null);
  const [hoveredCameraId, setHoveredCameraId] = useState<number | null>(null);
  const placed = useMemo(
    () => rows.filter((r) => r.device.lat != null && r.device.lon != null),
    [rows],
  );
  const hoveredRow = useMemo(
    () => placed.find((r) => r.device.device_id === hovered) ?? null,
    [placed, hovered],
  );
  const hoveredCamera = useMemo(
    () => cameras.find((c) => c.camera_id === hoveredCameraId) ?? null,
    [cameras, hoveredCameraId],
  );
  // Cameras already paired with a station pin render inside that pin — skip
  // them in the standalone camera layer to avoid drawing the same icon twice.
  const adoptedCameraIds = useMemo(() => {
    const s = new Set<number>();
    for (const cam of deviceCameraMap.values()) s.add(cam.camera_id);
    return s;
  }, [deviceCameraMap]);
  const standaloneCameras = useMemo(
    () => cameras.filter((c) => !adoptedCameraIds.has(c.camera_id)),
    [cameras, adoptedCameraIds],
  );

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
      >
        <NavigationControl position="top-right" showCompass={false} />
        {standaloneCameras.map((c) => (
          <Marker
            key={`cam-${c.camera_id}`}
            longitude={c.lon}
            latitude={c.lat}
            anchor="center"
          >
            <div
              onMouseEnter={() => setHoveredCameraId(c.camera_id)}
              onMouseLeave={() => setHoveredCameraId(null)}
            >
              <CameraPin
                hovered={hoveredCameraId === c.camera_id}
                onHover={setHoveredCameraId}
              />
            </div>
          </Marker>
        ))}
        {placed.map((row) => (
          <Marker
            key={row.device.device_id}
            longitude={row.device.lon as number}
            latitude={row.device.lat as number}
            anchor="bottom"
          >
            <StationPin
              row={row}
              hasCamera={deviceCameraMap.has(row.device.device_id)}
              hovered={hovered === row.device.device_id}
              onHover={onHover}
              onPick={onPick}
            />
          </Marker>
        ))}
      </MapLibreMap>
      {hoveredRow && (
        <HoverTooltip
          row={hoveredRow}
          camera={deviceCameraMap.get(hoveredRow.device.device_id) ?? null}
          mapRef={mapRef}
        />
      )}
      {hoveredCamera && <CameraHoverTooltip camera={hoveredCamera} mapRef={mapRef} />}
    </div>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
      {label}
    </span>
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
      <div style={{ display: 'inline-flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>CURRENT dB</span>
        <Swatch color="oklch(72% 0.13 195)" label="<55" />
        <Swatch color="oklch(78% 0.14 130)" label="55–64" />
        <Swatch color="oklch(82% 0.16 70)" label="65–74" />
        <Swatch color="oklch(72% 0.2 35)" label="≥75" />
        <Swatch color={ONLINE_IDLE_COLOR} label="idle" />
        <Swatch color={OFFLINE_COLOR} label="offline" />
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

export function StationListView({ onPick }: { onPick: (d: DeviceInfo) => void }) {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hovered, setHovered] = useState<string | null>(null);
  // Keyed by device_id. Only populated for online stations; offline pins
  // stay at null so they keep their gray "offline" rendering.
  const [latestDb, setLatestDb] = useState<Record<string, number | null>>({});

  useEffect(() => {
    let cancelled = false;
    fetchDevices()
      .then((d) => {
        if (!cancelled) setDevices(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
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
    <div
      style={{
        height: '100vh',
        display: 'grid',
        gridTemplateColumns: '1fr 460px',
        gap: 14,
        padding: 14,
        minHeight: 0,
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      <Card
        title="STATION NETWORK · SALT LAKE CITY"
        subtitle="Urban Quiet Initiative pilot corridor · State St, N Temple → 900 S · click a pin or row to drill in"
        right={
          <div className="mono" style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--ink-3)' }}>
            <span>
              <span style={{ color: 'var(--ink-1)' }}>{onlineCount}</span>/{placedRows.length} ONLINE
            </span>
            <span>
              AVG <span style={{ color: 'var(--ink-1)' }}>— dB</span>
            </span>
            <span>— BREACH HRS · 7D</span>
          </div>
        }
      >
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
            cameras={cameras}
            deviceCameraMap={deviceCameraMap}
            hovered={hovered}
            onHover={setHovered}
            onPick={onPick}
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
  );
}

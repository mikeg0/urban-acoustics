import { useEffect, useRef, useState } from 'react';
import { fetchNearestCamera } from './api';
import type { CameraInfo } from './types';

// UDOT publishes new snapshots ~every minute. One shared tick value drives
// the `?t=` cache-busting query string so every <CameraSnapshot> mounted
// anywhere on the page refreshes in lockstep — no per-image timer churn.
const SNAPSHOT_REFRESH_MS = 60_000;

let _tickValue = Math.floor(Date.now() / 1000);
const _tickSubscribers = new Set<(v: number) => void>();
let _tickInterval: ReturnType<typeof setInterval> | null = null;

function _ensureTickInterval(): void {
  if (_tickInterval != null) return;
  _tickInterval = setInterval(() => {
    _tickValue = Math.floor(Date.now() / 1000);
    for (const cb of _tickSubscribers) cb(_tickValue);
  }, SNAPSHOT_REFRESH_MS);
}

export function useSnapshotTick(): number {
  const [tick, setTick] = useState(_tickValue);
  useEffect(() => {
    _ensureTickInterval();
    _tickSubscribers.add(setTick);
    return () => {
      _tickSubscribers.delete(setTick);
    };
  }, []);
  return tick;
}

export function snapshotUrlWithTick(camera: CameraInfo, tick: number): string {
  if (!camera.snapshot_url) return '';
  return `${camera.snapshot_url}?t=${tick}`;
}

type SnapshotSize = 'thumb' | 'panel';

interface CameraSnapshotProps {
  camera: CameraInfo;
  size?: SnapshotSize;
  caption?: string;          // optional override; defaults to camera.location
  showCaption?: boolean;     // hide the caption row in tight popovers
  // When true, clicking the snapshot opens a fixed-overlay lightbox with
  // the full-resolution image. The lightbox image refreshes on the same
  // shared tick so it stays live while open. Ignored when `onClick` is set
  // so callers can use the snapshot as a navigation affordance instead.
  openOnClick?: boolean;
  // Override the click behavior (e.g. to navigate elsewhere). Takes
  // precedence over `openOnClick`.
  onClick?: () => void;
}

// Hotlinks the UDOT snapshot PNG and re-renders every minute. The
// underlying URL is stable, only the `?t=` query string changes — so the
// browser's cache disables itself but the network request is tiny (~15 KB).
export function CameraSnapshot({
  camera,
  size = 'panel',
  caption,
  showCaption = true,
  openOnClick = false,
  onClick,
}: CameraSnapshotProps) {
  const tick = useSnapshotTick();
  const [errored, setErrored] = useState(false);
  const [open, setOpen] = useState(false);
  const url = snapshotUrlWithTick(camera, tick);

  const navigates = onClick != null;
  const clickable = navigates || openOnClick;
  const cursor = navigates ? 'pointer' : openOnClick ? 'zoom-in' : undefined;
  const title = navigates
    ? 'Open Live view'
    : openOnClick
      ? 'Click for full-resolution view'
      : undefined;

  const wrapperStyle: React.CSSProperties = size === 'thumb'
    ? {
        width: 220,
        background: 'var(--bg-1)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        overflow: 'hidden',
        cursor,
      }
    : {
        width: '100%',
        background: 'var(--bg-1)',
        border: '1px solid var(--line)',
        borderRadius: 8,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        cursor,
      };

  const imgStyle: React.CSSProperties = {
    width: '100%',
    aspectRatio: '16 / 9',
    objectFit: 'cover',
    display: 'block',
    background: '#000',
  };

  const captionText = caption ?? camera.location ?? camera.roadway ?? '';

  const fire = navigates ? onClick : openOnClick ? () => setOpen(true) : null;
  const handleClick = fire ?? undefined;
  const handleKey = fire
    ? (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          fire();
        }
      }
    : undefined;

  return (
    <>
      <div
        style={wrapperStyle}
        onClick={handleClick}
        onKeyDown={handleKey}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        title={title}
      >
        {url && !errored ? (
          <img
            src={url}
            alt={captionText || `UDOT camera ${camera.camera_id}`}
            style={imgStyle}
            onError={() => setErrored(true)}
          />
        ) : (
          <div
            style={{
              ...imgStyle,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--ink-3)',
              fontFamily: 'var(--mono)',
              fontSize: 11,
            }}
          >
            camera offline
          </div>
        )}
        {showCaption && captionText && (
          <div
            className="mono"
            style={{
              fontSize: 10,
              color: 'var(--ink-3)',
              padding: '4px 8px',
              borderTop: '1px solid var(--line)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {captionText}
          </div>
        )}
      </div>
      {open && <CameraLightbox camera={camera} onClose={() => setOpen(false)} />}
    </>
  );
}

// Fixed-overlay full-resolution view. Click backdrop or hit Escape to
// close; body scroll is locked while open so the page underneath doesn't
// drift on touchpads. The image uses the same shared tick so it keeps
// refreshing while the lightbox is open.
function CameraLightbox({
  camera,
  onClose,
}: {
  camera: CameraInfo;
  onClose: () => void;
}) {
  const tick = useSnapshotTick();
  const url = snapshotUrlWithTick(camera, tick);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const caption = [camera.roadway, camera.direction, camera.location]
    .filter((s) => s && s.toLowerCase() !== 'unknown')
    .join(' · ');

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        // Higher than the maplibre tooltip stack (10_000_000) so it covers
        // the station map's hover popovers too.
        zIndex: 10_000_001,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
        cursor: 'zoom-out',
      }}
    >
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          maxWidth: '95vw',
          maxHeight: '95vh',
          cursor: 'zoom-out',
        }}
      >
        <img
          src={url}
          alt={caption || `UDOT camera ${camera.camera_id}`}
          style={{
            maxWidth: '95vw',
            maxHeight: 'calc(95vh - 60px)',
            objectFit: 'contain',
            borderRadius: 4,
            background: '#000',
          }}
        />
        <div
          className="mono"
          style={{
            marginTop: 10,
            color: 'var(--ink-1)',
            fontSize: 12,
            letterSpacing: '0.04em',
            textAlign: 'center',
            maxWidth: '95vw',
          }}
        >
          {caption || `UDOT camera ${camera.camera_id}`}
        </div>
        <div
          className="mono"
          style={{
            marginTop: 4,
            color: 'var(--ink-3)',
            fontSize: 10,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
          }}
        >
          click anywhere or press Esc to close
        </div>
      </div>
    </div>
  );
}

// Module-level cache so map-pin hovers and the live view don't both refetch
// the same device→camera mapping. Keyed by device_id; null means "no nearby
// camera". Cleared on full reload, which matches the lifetime of the
// underlying `cameras` table (it doesn't change between page loads — the
// operator-run script does).
const _nearestCache = new Map<string, CameraInfo | null>();
const _nearestInflight = new Map<string, Promise<CameraInfo | null>>();

export function useNearestCamera(deviceId: string | null | undefined): {
  camera: CameraInfo | null;
  loading: boolean;
} {
  const [camera, setCamera] = useState<CameraInfo | null>(
    deviceId ? _nearestCache.get(deviceId) ?? null : null,
  );
  const [loading, setLoading] = useState(
    deviceId != null && !_nearestCache.has(deviceId),
  );
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    if (!deviceId) {
      setCamera(null);
      setLoading(false);
      return;
    }
    if (_nearestCache.has(deviceId)) {
      setCamera(_nearestCache.get(deviceId) ?? null);
      setLoading(false);
      return;
    }
    setLoading(true);
    let pending = _nearestInflight.get(deviceId);
    if (pending == null) {
      pending = fetchNearestCamera(deviceId)
        .catch(() => null)
        .then((result) => {
          _nearestCache.set(deviceId, result);
          _nearestInflight.delete(deviceId);
          return result;
        });
      _nearestInflight.set(deviceId, pending);
    }
    pending.then((result) => {
      if (cancelledRef.current) return;
      setCamera(result);
      setLoading(false);
    });
    return () => {
      cancelledRef.current = true;
    };
  }, [deviceId]);

  return { camera, loading };
}

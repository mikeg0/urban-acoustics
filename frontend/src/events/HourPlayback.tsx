import type { DeviceEvent } from '../types';
import type { PaletteKey } from '../palettes';
import { HourTileBackdrop } from '../spectrogram';

interface HourPlaybackViewerProps {
  hourTs: number;            // unix seconds, top of hour
  threshold: number;
  events: DeviceEvent[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  onDeleteUnlabeled: () => void;
  deletingUnlabeled: boolean;
  deviceId: string;
  palette: PaletteKey;
}

const HOUR_S = 3600;

const pad2 = (n: number) => String(n).padStart(2, '0');

function fmtClock(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtClockSec(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function HourPlaybackViewer({
  hourTs, threshold, events, loading, error, selectedId, onSelect, onClose,
  onDeleteUnlabeled, deletingUnlabeled,
  deviceId, palette,
}: HourPlaybackViewerProps) {
  const totalBreaches = events.filter((e) => e.peak_db >= threshold).length;
  const unlabeledCount = events.filter((e) => e.label == null).length;
  const canDeleteUnlabeled = unlabeledCount > 0 && !deletingUnlabeled && !loading;

  return (
    <div style={{
      marginTop: 14, padding: 14,
      background: 'var(--bg-1)', border: '1px solid var(--neon-focus)',
      borderRadius: 8, animation: 'zoom-in 120ms ease-out',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        marginBottom: 10, gap: 16, flexWrap: 'wrap',
      }}>
        <div>
          <div style={{ fontSize: 13, color: 'var(--ink-0)', fontWeight: 500 }}>
            Hour playback · {fmtClock(hourTs)} → {fmtClock(hourTs + HOUR_S)}
          </div>
          <div className="mono" style={{
            fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em', marginTop: 2,
          }}>
            {loading
              ? 'LOADING EVENTS…'
              : error
                ? `ERROR · ${error}`
                : `${events.length} CLIP${events.length === 1 ? '' : 'S'} · ${totalBreaches} ≥ ${threshold} dB · PICK ONE IN THE RECENT EVENTS LIST TO PLAY`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              fontSize: 10, fontFamily: 'var(--mono)', letterSpacing: '0.12em',
              textTransform: 'uppercase', padding: '4px 10px',
              background: 'var(--bg-2)', border: '1px solid var(--line)',
              color: 'var(--ink-2)', borderRadius: 4, cursor: 'pointer',
            }}
          >✕ Close</button>
          <button
            type="button"
            onClick={onDeleteUnlabeled}
            disabled={!canDeleteUnlabeled}
            title={
              unlabeledCount === 0
                ? 'No unlabeled clips in this hour'
                : `Delete ${unlabeledCount} unlabeled clip${unlabeledCount === 1 ? '' : 's'} (audio + record)`
            }
            style={{
              fontSize: 10, fontFamily: 'var(--mono)', letterSpacing: '0.12em',
              textTransform: 'uppercase', padding: '4px 10px',
              background: 'var(--bg-2)',
              border: `1px solid ${canDeleteUnlabeled ? 'var(--neon-hot)' : 'var(--line)'}`,
              color: canDeleteUnlabeled ? 'var(--neon-hot)' : 'var(--ink-3)',
              borderRadius: 4,
              cursor: canDeleteUnlabeled ? 'pointer' : (deletingUnlabeled ? 'wait' : 'not-allowed'),
              opacity: canDeleteUnlabeled ? 1 : 0.6,
            }}
          >🗑 Delete unlabeled{unlabeledCount > 0 ? ` (${unlabeledCount})` : ''}</button>
        </div>
      </div>

      <BreachTimeline
        hourTs={hourTs}
        events={events}
        threshold={threshold}
        selectedId={selectedId}
        onSelect={onSelect}
        deviceId={deviceId}
        palette={palette}
      />

      {events.length === 0 && !loading && !error && (
        <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 12 }}>
          No breach clips recorded in this hour.
        </div>
      )}
    </div>
  );
}

function BreachTimeline({
  hourTs, events, threshold, selectedId, onSelect, deviceId, palette,
}: {
  hourTs: number;
  events: DeviceEvent[];
  threshold: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  deviceId: string;
  palette: PaletteKey;
}) {
  // Render each event as a positioned band over a 1-hour-wide track.
  // Bands narrower than 0.5% of the track widen visually so single-second
  // clips stay clickable; their hit-target stays exact via the timestamp.
  const MIN_VISIBLE_PCT = 0.5;
  return (
    <div>
      <div style={{
        position: 'relative', height: 56,
        background: 'var(--bg-2)', border: '1px solid var(--line)',
        borderRadius: 4, overflow: 'hidden',
      }}>
        <HourTileBackdrop deviceId={deviceId} hourTs={hourTs} palette={palette} />
        {/* 5-minute gridlines */}
        {Array.from({ length: 13 }).map((_, i) => (
          <div key={i} style={{
            position: 'absolute',
            left: `${(i / 12) * 100}%`, top: 0, bottom: 0,
            width: 1,
            background: i === 0 || i === 12
              ? 'transparent'
              : i % 3 === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.10)',
            pointerEvents: 'none',
          }} />
        ))}
        {events.map((e) => {
          const startFrac = Math.max(0, Math.min(1, (e.ts - hourTs) / HOUR_S));
          const widthFrac = Math.max(0, Math.min(1 - startFrac, e.duration_s / HOUR_S));
          const visibleWidth = Math.max(widthFrac * 100, MIN_VISIBLE_PCT);
          const breach = e.peak_db >= threshold;
          const labeled = e.label != null;
          const selected = e.event_id === selectedId;
          const color = labeled
            ? 'var(--neon-ok)'
            : breach ? 'var(--neon-hot)' : 'var(--neon-warn)';
          const fill = labeled
            ? 'oklch(82% 0.14 160 / 0.45)'
            : breach
              ? 'oklch(78% 0.18 35 / 0.55)'
              : 'oklch(82% 0.16 70 / 0.45)';
          return (
            <button
              key={e.event_id}
              type="button"
              onClick={() => onSelect(e.event_id)}
              title={`${fmtClockSec(e.ts)} · ${e.duration_s.toFixed(1)}s · ${e.peak_db.toFixed(1)} dB${labeled ? ` · ${e.label}` : ''}`}
              style={{
                position: 'absolute',
                left: `${startFrac * 100}%`,
                width: `${visibleWidth}%`,
                top: 0, bottom: 0,
                background: fill,
                border: `1.5px solid ${color}`,
                borderRadius: 2,
                padding: 0, cursor: 'pointer',
                boxShadow: selected ? `0 0 8px ${color}` : 'none',
                outline: selected ? `1.5px solid var(--neon-focus)` : 'none',
                outlineOffset: 1,
                transition: 'box-shadow 80ms ease',
              }} />
          );
        })}
      </div>
      <div className="mono" style={{
        position: 'relative', height: 12, marginTop: 4,
        fontSize: 9, color: 'var(--ink-3)',
      }}>
        {[0, 15, 30, 45, 60].map((min) => (
          <span
            key={min}
            style={{
              position: 'absolute', top: 0,
              left: `${(min / 60) * 100}%`,
              transform:
                min === 0 ? 'translateX(0)'
                : min === 60 ? 'translateX(-100%)'
                : 'translateX(-50%)',
              whiteSpace: 'nowrap',
            }}
          >{fmtClock(hourTs + min * 60)}</span>
        ))}
      </div>
    </div>
  );
}

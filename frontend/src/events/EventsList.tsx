import type { DeviceEvent } from '../types';

interface Props {
  events: DeviceEvent[];
  selectedId: string | null;
  onSelect: (e: DeviceEvent) => void;
  threshold: number;
}

const fmtTs = (ts: number) =>
  new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

export function EventsList({ events, selectedId, onSelect, threshold }: Props) {
  if (!events.length) {
    return (
      <div className="mono" style={{ padding: 16, fontSize: 11, color: 'var(--ink-3)' }}>
        No events yet. Uploaded clips will appear here.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
      {events.map((e) => {
        const selected = e.event_id === selectedId;
        const breach = e.peak_db >= threshold;
        return (
          <button
            key={e.event_id}
            onClick={() => onSelect(e)}
            style={{
              display: 'grid',
              gridTemplateColumns: '90px 1fr auto',
              alignItems: 'center',
              gap: 12,
              padding: '10px 14px',
              background: selected ? 'var(--bg-3)' : 'transparent',
              border: 'none',
              borderBottom: '1px solid var(--line)',
              borderLeft: selected ? '2px solid var(--neon-focus)' : '2px solid transparent',
              cursor: 'pointer',
              color: 'var(--ink-1)',
              textAlign: 'left',
              fontFamily: 'inherit',
            }}
          >
            <span
              className="mono"
              style={{ fontSize: 18, color: breach ? 'var(--neon-hot)' : 'var(--ink-0)' }}
            >
              {e.peak_db.toFixed(1)}
              <span style={{ fontSize: 9, color: 'var(--ink-3)', marginLeft: 3 }}>dB</span>
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--ink-0)' }}>
                {fmtTs(e.ts)}
              </span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
                {e.duration_s.toFixed(1)}s ·{' '}
                {e.label ? (
                  <span style={{ color: 'var(--neon-ok)' }}>{e.label}</span>
                ) : (
                  e.classification ?? 'unclassified'
                )}
                {e.confidence != null ? ` · ${(e.confidence * 100).toFixed(0)}%` : ''}
              </span>
            </div>
            <span
              className="mono"
              style={{
                fontSize: 9,
                padding: '2px 6px',
                borderRadius: 3,
                background: 'var(--bg-2)',
                border: '1px solid var(--line)',
                color: e.status === 'available' ? 'var(--neon-ok)' : 'var(--ink-2)',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
              }}
            >
              {e.status.replace(/_/g, ' ')}
            </span>
          </button>
        );
      })}
    </div>
  );
}

import { useTweaks } from '../tweaks';
import { formatClock } from '../utils';
import type { RecentEntry } from '../types';

interface Props {
  entries: RecentEntry[];
  selectedEventId: string | null;
  selectedAnnotationId: number | null;
  onSelectEvent: (eventId: string) => void;
  onSelectAnnotation: (annotationId: number) => void;
  threshold: number;
}

export function EventsList({
  entries, selectedEventId, selectedAnnotationId,
  onSelectEvent, onSelectAnnotation, threshold,
}: Props) {
  if (!entries.length) {
    return (
      <div className="mono" style={{ padding: 16, fontSize: 11, color: 'var(--ink-3)' }}>
        No events yet. Uploaded clips and spectrogram annotations will appear here.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
      {entries.map((entry) =>
        entry.kind === 'event' ? (
          <EventRow
            key={`event-${entry.event.event_id}`}
            event={entry.event}
            selected={entry.event.event_id === selectedEventId}
            threshold={threshold}
            onSelect={() => onSelectEvent(entry.event.event_id)}
          />
        ) : (
          <AnnotationRow
            key={`annotation-${entry.annotation.id}`}
            annotation={entry.annotation}
            selected={entry.annotation.id === selectedAnnotationId}
            onSelect={() => onSelectAnnotation(entry.annotation.id)}
          />
        ),
      )}
    </div>
  );
}

function EventRow({
  event: e, selected, threshold, onSelect,
}: {
  event: import('../types').DeviceEvent;
  selected: boolean;
  threshold: number;
  onSelect: () => void;
}) {
  const { timeFormat } = useTweaks();
  const breach = e.peak_db >= threshold;
  return (
    <button
      onClick={onSelect}
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
          {formatClock(e.ts, timeFormat, { withSeconds: true, withDate: true })}
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
}

function AnnotationRow({
  annotation: a, selected, onSelect,
}: {
  annotation: import('../types').SpectrogramAnnotation;
  selected: boolean;
  onSelect: () => void;
}) {
  const { timeFormat } = useTweaks();
  const duration = a.ts_end - a.ts_start;
  return (
    <button
      onClick={onSelect}
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
        style={{
          fontSize: 10,
          padding: '4px 8px',
          borderRadius: 3,
          background: 'oklch(82% 0.16 270 / 0.18)',
          border: '1px dashed oklch(82% 0.16 270 / 0.75)',
          color: 'oklch(85% 0.12 270)',
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
          textAlign: 'center',
        }}
      >
        ANN
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-0)' }}>
          {formatClock(a.ts_start, timeFormat, { withSeconds: true, withDate: true })}
        </span>
        <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
          {duration.toFixed(1)}s · <span style={{ color: 'var(--neon-ok)' }}>{a.label}</span>
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
          color: 'oklch(85% 0.12 270)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
        }}
      >
        ANNOTATION
      </span>
    </button>
  );
}

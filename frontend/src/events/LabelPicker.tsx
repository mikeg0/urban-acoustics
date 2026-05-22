import { useEffect, useState } from 'react';
import { submitEventLabel } from '../api';
import { EVENT_LABELS, type DeviceEvent, type EventLabel } from '../types';

interface Props {
  event: DeviceEvent | null;
  onLabelled?: (eventId: string, label: EventLabel) => void;
}

export function LabelPicker({ event, onLabelled }: Props) {
  const [pending, setPending] = useState<EventLabel | null>(null);
  const [applied, setApplied] = useState<EventLabel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setApplied(event?.label ?? null);
    setError(null);
  }, [event?.event_id, event?.label]);

  if (!event) {
    return (
      <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
        Select an event to label.
      </div>
    );
  }

  const submit = async (label: EventLabel) => {
    setPending(label);
    setError(null);
    try {
      await submitEventLabel(event.event_id, label);
      setApplied(label);
      onLabelled?.(event.event_id, label);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {EVENT_LABELS.map((label) => {
          const isApplied = applied === label;
          const isPending = pending === label;
          return (
            <button
              key={label}
              onClick={() => submit(label)}
              disabled={pending !== null}
              style={{
                padding: '5px 11px',
                fontSize: 11,
                fontFamily: 'var(--mono)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                background: isApplied ? 'var(--neon-ok)' : 'var(--bg-2)',
                color: isApplied ? '#0a0a0a' : 'var(--ink-1)',
                border: `1px solid ${isApplied ? 'var(--neon-ok)' : 'var(--line)'}`,
                borderRadius: 4,
                cursor: pending === null ? 'pointer' : 'wait',
                opacity: isPending ? 0.6 : 1,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
      {error && (
        <div className="mono" style={{ fontSize: 11, color: 'var(--neon-hot)' }}>
          {error}
        </div>
      )}
      {applied && !error && (
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em' }}>
          SUBMITTED · {applied.toUpperCase()}
        </div>
      )}
    </div>
  );
}

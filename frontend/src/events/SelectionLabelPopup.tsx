import { useEffect, useState } from 'react';
import { AnnotationApiError, submitAnnotation } from '../api';
import { EVENT_LABELS, type EventLabel, type SpectrogramAnnotation } from '../types';

const pad2 = (n: number) => String(n).padStart(2, '0');

function fmtClockSec(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

interface Props {
  deviceId: string;
  tsStart: number;
  tsEnd: number;
  /** Pixel position of the selection's left edge relative to the spectrogram
   *  container, used to anchor the popup. */
  anchorLeftPx: number;
  /** Pixel width of the selection rectangle, used so the popup centers over
   *  the band when there's room. */
  anchorWidthPx: number;
  onSubmitted: (annotation: SpectrogramAnnotation) => void;
  onCancel: () => void;
}

export function SelectionLabelPopup({
  deviceId, tsStart, tsEnd, anchorLeftPx, anchorWidthPx,
  onSubmitted, onCancel,
}: Props) {
  const [pending, setPending] = useState<EventLabel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = async (label: EventLabel) => {
    setPending(label);
    setError(null);
    try {
      const ann = await submitAnnotation(deviceId, {
        ts_start: tsStart,
        ts_end: tsEnd,
        label,
      });
      onSubmitted(ann);
    } catch (e) {
      if (e instanceof AnnotationApiError && e.status === 409) {
        setError('This range overlaps an existing event; label that event directly instead.');
      } else if (e instanceof AnnotationApiError && e.status === 400) {
        setError('No spectrogram data in this range — nothing to label.');
      } else {
        setError((e as Error).message);
      }
      setPending(null);
    }
  };

  const duration = tsEnd - tsStart;

  // Center the popup over the selection when possible, but keep it inside
  // the spectrogram container — anchorLeftPx is relative to the container,
  // and the popup is positioned absolutely against that same container.
  const POPUP_WIDTH = 380;
  const desiredLeft = anchorLeftPx + anchorWidthPx / 2 - POPUP_WIDTH / 2;

  return (
    <>
      <div
        // Backdrop catches outside clicks. Transparent — the user can still
        // see the spectrogram and the selection rectangle behind it.
        onMouseDown={onCancel}
        style={{
          position: 'absolute', inset: 0,
          zIndex: 10,
        }}
      />
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          left: Math.max(4, desiredLeft),
          top: '100%',
          marginTop: 6,
          width: POPUP_WIDTH,
          maxWidth: 'calc(100% - 8px)',
          background: 'rgba(8,8,12,0.96)',
          border: '1px solid var(--neon-focus)',
          borderRadius: 6,
          padding: 12,
          boxShadow: '0 8px 24px rgba(0,0,0,0.55)',
          zIndex: 11,
        }}
      >
        <div className="mono" style={{
          fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.12em',
          textTransform: 'uppercase', marginBottom: 8,
        }}>
          {fmtClockSec(tsStart)} → {fmtClockSec(tsEnd)} · {duration.toFixed(1)} s
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {EVENT_LABELS.map((label) => {
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
                  background: 'var(--bg-2)',
                  color: 'var(--ink-1)',
                  border: '1px solid var(--line)',
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
          <div className="mono" style={{
            fontSize: 11, color: 'var(--neon-hot)', marginBottom: 8,
          }}>
            {error}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            disabled={pending !== null}
            style={{
              padding: '5px 14px',
              fontSize: 11,
              fontFamily: 'var(--mono)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              background: 'transparent',
              color: 'var(--ink-2)',
              border: '1px solid var(--ink-3)',
              borderRadius: 4,
              cursor: pending === null ? 'pointer' : 'wait',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

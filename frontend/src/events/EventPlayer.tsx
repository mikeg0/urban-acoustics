import { useEffect, useState } from 'react';
import { fetchEventPlaybackUrl } from '../api';
import type { DeviceEvent } from '../types';

interface Props {
  event: DeviceEvent | null;
}

export function EventPlayer({ event }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setUrl(null);
    setError(null);
    if (!event) return;
    if (event.status !== 'available') {
      setError(`status=${event.status} — clip not ready for playback`);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchEventPlaybackUrl(event.event_id)
      .then((p) => {
        if (!cancelled) setUrl(p.url);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [event]);

  if (!event) {
    return (
      <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
        Select an event to play.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="mono" style={{ fontSize: 11, color: 'var(--ink-2)', letterSpacing: '0.1em' }}>
        FETCHING PLAYBACK URL…
      </div>
    );
  }
  if (error) {
    return (
      <div className="mono" style={{ fontSize: 11, color: 'var(--neon-hot)' }}>
        Playback unavailable: {error}
      </div>
    );
  }
  if (!url) return null;
  return <audio controls src={url} style={{ width: '100%' }} />;
}

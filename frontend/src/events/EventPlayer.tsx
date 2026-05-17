import { useEffect, useState } from 'react';
import { fetchEventPlaybackUrl } from '../api';
import { SpectrogramCanvas, computeEventSpectrogram } from '../spectrogram';
import { useTweaks } from '../tweaks';
import type { DeviceEvent } from '../types';

interface Props {
  event: DeviceEvent | null;
}

interface SpectCache {
  eventId: string;
  data: number[][];
  durationS: number;
  sampleRate: number;
}

export function EventPlayer({ event }: Props) {
  const { spectroColor } = useTweaks();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [spect, setSpect] = useState<SpectCache | null>(null);
  const [spectError, setSpectError] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);

  // Fetch the presigned playback URL whenever the selected event changes.
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

  // Drop any stale spectrogram as soon as the selection changes — keeps the
  // user from seeing the wrong event's bands while the new STFT runs.
  useEffect(() => {
    if (!event) { setSpect(null); return; }
    if (spect && spect.eventId !== event.event_id) setSpect(null);
  }, [event, spect]);

  // Compute the per-event spectrogram in the browser. Decoded audio →
  // 4096-pt Hann STFT (50 % overlap) → 1/3-octave band binning → 0..1
  // normalised matrix consumed by SpectrogramCanvas. Cached on event_id
  // so reselecting the same event doesn't recompute.
  useEffect(() => {
    if (!event || !url) return;
    if (spect && spect.eventId === event.event_id) return;
    let cancelled = false;
    setSpectError(null);
    setComputing(true);
    (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`audio fetch failed: ${r.status}`);
        const buf = await r.arrayBuffer();
        const AC: typeof AudioContext =
          window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AC();
        let decoded: AudioBuffer;
        try {
          decoded = await ctx.decodeAudioData(buf);
        } finally {
          // Close the context as soon as we have the samples — we never
          // play back through it, the <audio> element handles playback.
          try { await ctx.close(); } catch { /* ignore */ }
        }
        if (cancelled) return;
        const samples = decoded.getChannelData(0);
        const data = computeEventSpectrogram(samples, decoded.sampleRate);
        if (cancelled) return;
        setSpect({
          eventId: event.event_id,
          data,
          durationS: decoded.duration,
          sampleRate: decoded.sampleRate,
        });
      } catch (e) {
        if (!cancelled) setSpectError((e as Error).message);
      } finally {
        if (!cancelled) setComputing(false);
      }
    })();
    return () => { cancelled = true; };
  }, [event, url, spect]);

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
  return (
    <div>
      <audio controls src={url} style={{ width: '100%' }} />
      <div style={{ marginTop: 10 }}>
        <div className="mono" style={{
          display: 'flex', justifyContent: 'space-between',
          fontSize: 9, color: 'var(--ink-3)', letterSpacing: '0.12em',
          textTransform: 'uppercase', marginBottom: 4,
        }}>
          <span>Spectrogram · ⅓-octave</span>
          <span>
            {spect
              ? `${spect.durationS.toFixed(2)} s · ${(spect.sampleRate / 1000).toFixed(0)} kHz`
              : computing ? 'computing…' : '—'}
          </span>
        </div>
        <div style={{ position: 'relative', height: 140 }}>
          {spect && spect.eventId === event.event_id ? (
            <SpectrogramCanvas data={spect.data} palette={spectroColor} height={140} />
          ) : (
            <div style={{
              width: '100%', height: '100%', borderRadius: 4,
              background: 'var(--bg-2)', border: '1px solid var(--line)',
            }} />
          )}
          {computing && (
            <div className="mono" style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, letterSpacing: '0.14em', color: 'var(--ink-2)',
              background: 'rgba(0,0,0,0.45)', borderRadius: 4, pointerEvents: 'none',
            }}>
              COMPUTING SPECTROGRAM…
            </div>
          )}
          {spectError && !computing && (
            <div className="mono" style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, color: 'var(--neon-hot)', borderRadius: 4,
              padding: 8, textAlign: 'center',
            }}>
              Spectrogram failed: {spectError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

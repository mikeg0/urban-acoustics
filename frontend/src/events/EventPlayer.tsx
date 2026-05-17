import { useCallback, useEffect, useRef, useState } from 'react';
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

const pad2 = (n: number) => String(n).padStart(2, '0');

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${pad2(s)}`;
}

function formatClock(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function EventPlayer({ event }: Props) {
  const { spectroColor } = useTweaks();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [spect, setSpect] = useState<SpectCache | null>(null);
  const [spectError, setSpectError] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);

  // Playback state mirrored out of the hidden <audio> element so the
  // custom controls and the spectrogram playhead render off the same
  // source of truth.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);

  // The parent re-derives `selectedEvent` from the events list on every
  // poll, so the object reference changes even when the selection hasn't.
  // Key all effects on the stable event_id to avoid tearing down playback
  // and the spectrogram on every refresh.
  const eventId = event?.event_id ?? null;

  // Fetch the presigned playback URL whenever the selected event changes.
  // We always try the endpoint — the backend will verify an `uploaded` row
  // landed in storage and flip it to `available` on the fly, so trusting
  // the cached list status here would race the verifier.
  useEffect(() => {
    setUrl(null);
    setError(null);
    setCurrent(0);
    setDuration(0);
    setPlaying(false);
    if (!eventId) return;
    let cancelled = false;
    setLoading(true);
    fetchEventPlaybackUrl(eventId)
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
  }, [eventId]);

  // Drop any stale spectrogram as soon as the selection changes — keeps the
  // user from seeing the wrong event's bands while the new STFT runs.
  useEffect(() => {
    if (!eventId) { setSpect(null); return; }
    if (spect && spect.eventId !== eventId) setSpect(null);
  }, [eventId, spect]);

  // Compute the per-event spectrogram in the browser. Decoded audio →
  // 4096-pt Hann STFT (50 % overlap) → 1/3-octave band binning → 0..1
  // normalised matrix consumed by SpectrogramCanvas. Cached on event_id
  // so reselecting the same event doesn't recompute.
  useEffect(() => {
    if (!eventId || !url) return;
    if (spect && spect.eventId === eventId) return;
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
          eventId,
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
  }, [eventId, url, spect]);

  // --- audio element wiring ------------------------------------------------

  // Force max volume on every metadata load; the contract is "always loud,"
  // not "loud by default" — so we re-apply if anything tries to mute us.
  const onLoadedMetadata = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    a.volume = 1;
    setDuration(Number.isFinite(a.duration) ? a.duration : 0);
  }, []);

  const onVolumeChange = useCallback(() => {
    const a = audioRef.current;
    if (a && a.volume !== 1) a.volume = 1;
  }, []);

  const onTimeUpdate = useCallback(() => {
    const a = audioRef.current;
    if (a) setCurrent(a.currentTime);
  }, []);

  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused || a.ended) {
      if (a.ended) a.currentTime = 0;
      void a.play();
    } else {
      a.pause();
    }
  }, []);

  const skipToStart = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = 0;
    setCurrent(0);
  }, []);

  const skipToEnd = useCallback(() => {
    const a = audioRef.current;
    if (!a || !Number.isFinite(a.duration)) return;
    // Pause first so the brief seek to the tail doesn't replay the tip
    // of the clip on browsers that don't fire `ended` for programmatic
    // seeks to exactly duration.
    a.pause();
    a.currentTime = a.duration;
    setCurrent(a.duration);
  }, []);

  const seekTo = useCallback((sec: number) => {
    const a = audioRef.current;
    if (!a) return;
    const clamped = Math.max(0, Math.min(a.duration || 0, sec));
    a.currentTime = clamped;
    setCurrent(clamped);
  }, []);

  // --- scrubbing helpers ---------------------------------------------------

  // Both the progress bar and the spectrogram share the same fraction →
  // seconds mapping. Pointer capture lets us track drags that leave the
  // element bounds without juggling document-level listeners.
  const scrubFromEvent = useCallback((
    el: HTMLElement,
    clientX: number,
  ) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    seekTo(frac * (duration || 0));
  }, [seekTo, duration]);

  const handleScrubPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (!duration) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    scrubFromEvent(e.currentTarget as HTMLElement, e.clientX);
  };
  const handleScrubPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!duration) return;
    const el = e.currentTarget as HTMLElement;
    if (!el.hasPointerCapture(e.pointerId)) return;
    scrubFromEvent(el, e.clientX);
  };
  const handleScrubPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };

  // --- early returns -------------------------------------------------------

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

  const progressFrac = duration > 0 ? Math.min(1, current / duration) : 0;
  const downloadName = `event-${event.event_id.slice(0, 8)}-${Math.round(event.ts)}.flac`;

  return (
    <div>
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        style={{ display: 'none' }}
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onVolumeChange={onVolumeChange}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />

      {/* Playback controls — mirrors the reference WavPlayer layout. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <button
          onClick={skipToStart}
          aria-label="Skip to start"
          style={iconBtn(false)}
        >
          <svg width="11" height="11" viewBox="0 0 10 10">
            <path d="M7 2 L3 5 L7 8 Z M2 2 L2 8" stroke="currentColor" fill="currentColor" strokeWidth="1" />
          </svg>
        </button>

        <button
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
          style={{
            width: 40, height: 40, borderRadius: 20,
            background: 'var(--ink-0)', border: 'none', color: 'var(--bg-0)',
            cursor: 'pointer', display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          {playing
            ? (
              <svg width="14" height="14" viewBox="0 0 12 12">
                <rect x="2.5" y="2" width="2.5" height="8" fill="currentColor" />
                <rect x="7" y="2" width="2.5" height="8" fill="currentColor" />
              </svg>
            )
            : (
              <svg width="14" height="14" viewBox="0 0 12 12">
                <path d="M3 2 L10 6 L3 10 Z" fill="currentColor" />
              </svg>
            )}
        </button>

        <button
          onClick={skipToEnd}
          aria-label="Skip to end"
          style={iconBtn(false)}
        >
          <svg width="11" height="11" viewBox="0 0 10 10">
            <path d="M3 2 L7 5 L3 8 Z M8 2 L8 8" stroke="currentColor" fill="currentColor" strokeWidth="1" />
          </svg>
        </button>

        <div
          onPointerDown={handleScrubPointerDown}
          onPointerMove={handleScrubPointerMove}
          onPointerUp={handleScrubPointerUp}
          onPointerCancel={handleScrubPointerUp}
          style={{
            flex: 1, height: 20, position: 'relative',
            cursor: duration ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center',
            touchAction: 'none',
          }}
        >
          <div style={{
            position: 'absolute', inset: 'calc(50% - 2px) 0 auto 0',
            height: 4, background: 'var(--bg-3)', borderRadius: 2,
          }} />
          <div style={{
            position: 'absolute', top: 'calc(50% - 2px)', left: 0,
            width: `${progressFrac * 100}%`, height: 4,
            background: 'var(--neon-cool)', borderRadius: 2,
          }} />
          <div style={{
            position: 'absolute', left: `${progressFrac * 100}%`, top: '50%',
            width: 10, height: 10, marginLeft: -5, marginTop: -5,
            background: 'var(--ink-0)', borderRadius: 5,
            boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
          }} />
        </div>

        <div className="mono" style={{
          fontSize: 11, color: 'var(--ink-1)', minWidth: 70, textAlign: 'right',
        }}>
          {formatTime(current)}{' '}
          <span style={{ color: 'var(--ink-3)' }}>/ {formatTime(duration)}</span>
        </div>

        {/* Static speaker icon — playback is always max volume, so no slider. */}
        <svg width="14" height="14" viewBox="0 0 12 12" style={{ color: 'var(--ink-3)' }}>
          <path d="M1 4 L4 4 L7 1 L7 11 L4 8 L1 8 Z" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>

        <a
          href={url}
          download={downloadName}
          style={{
            padding: '6px 10px',
            background: 'var(--bg-1)',
            border: '1px solid var(--line)',
            borderRadius: 6,
            color: 'var(--ink-2)',
            cursor: 'pointer',
            fontFamily: 'var(--mono)',
            fontSize: 10,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            textDecoration: 'none',
          }}
          title={`Download ${downloadName}`}
        >
          ↓ FLAC
        </a>
      </div>

      <div className="mono" style={{
        fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.05em', marginBottom: 10,
      }}>
        {event.duration_s.toFixed(0)}s clip · starts at {formatClock(event.ts)}
      </div>

      <div>
        <div className="mono" style={{
          display: 'flex', justifyContent: 'space-between',
          fontSize: 9, color: 'var(--ink-3)', letterSpacing: '0.12em',
          textTransform: 'uppercase', marginBottom: 4,
        }}>
          <span>Spectrogram · ⅓-octave · click or drag to scrub</span>
          <span>
            {spect
              ? `${spect.durationS.toFixed(2)} s · ${(spect.sampleRate / 1000).toFixed(0)} kHz`
              : computing ? 'computing…' : '—'}
          </span>
        </div>
        <div
          onPointerDown={handleScrubPointerDown}
          onPointerMove={handleScrubPointerMove}
          onPointerUp={handleScrubPointerUp}
          onPointerCancel={handleScrubPointerUp}
          style={{
            position: 'relative', height: 140,
            cursor: duration ? 'pointer' : 'default',
            touchAction: 'none',
          }}
        >
          {spect && spect.eventId === eventId ? (
            <SpectrogramCanvas data={spect.data} palette={spectroColor} height={140} />
          ) : (
            <div style={{
              width: '100%', height: '100%', borderRadius: 4,
              background: 'var(--bg-2)', border: '1px solid var(--line)',
            }} />
          )}
          {/* Red playhead — vertical line at the current playback fraction. */}
          {duration > 0 && (
            <div style={{
              position: 'absolute', top: 0, bottom: 0,
              left: `${progressFrac * 100}%`,
              width: 2, marginLeft: -1,
              background: 'var(--neon-hot)',
              boxShadow: '0 0 6px var(--neon-hot)',
              pointerEvents: 'none',
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

function iconBtn(disabled: boolean): React.CSSProperties {
  return {
    width: 28, height: 28, borderRadius: 6,
    background: 'var(--bg-1)',
    border: '1px solid var(--line)',
    color: disabled ? 'var(--ink-3)' : 'var(--ink-1)',
    cursor: disabled ? 'default' : 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    opacity: disabled ? 0.5 : 1,
  };
}

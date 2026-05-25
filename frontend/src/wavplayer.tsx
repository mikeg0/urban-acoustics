import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTweaks } from './tweaks';
import { formatHour, mulberry32, type TimeFormat } from './utils';
import type { Day } from './types';

const SEGMENT_MINUTES = 5;
const SEGMENTS_PER_HOUR = 12;

const pad2 = (n: number) => String(n).padStart(2, '0');

function formatSegTime(h: number, segIndex: number, offsetSec: number, format: TimeFormat) {
  const totalSec = segIndex * SEGMENT_MINUTES * 60 + offsetSec;
  const mm = Math.floor(totalSec / 60);
  const ss = Math.floor(totalSec % 60);
  if (format === '12h') {
    const hh = h % 12 === 0 ? 12 : h % 12;
    const ap = h < 12 ? 'AM' : 'PM';
    return `${hh}:${pad2(mm)}:${pad2(ss)} ${ap}`;
  }
  return `${pad2(h)}:${pad2(mm)}:${pad2(ss)}`;
}

function formatDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${pad2(s)}`;
}

function synthesizeSegment(audioCtx: AudioContext, seed: number, intensityDb: number): AudioBuffer {
  const duration = 10;
  const rate = audioCtx.sampleRate;
  const length = Math.floor(rate * duration);
  const buffer = audioCtx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  const rng = mulberry32(seed);

  const amp = Math.max(0.05, Math.min(0.9, (intensityDb - 45) / 60));

  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < length; i++) {
    const white = rng() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
    data[i] = pink * amp * 0.55;
  }

  const rumbleF = 60 + rng() * 60;
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    data[i] += Math.sin(2 * Math.PI * rumbleF * t) * amp * 0.12 * (0.7 + 0.3 * Math.sin(t * 1.3));
  }

  const fmt1 = 220 + rng() * 140;
  const fmt2 = 520 + rng() * 280;
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    const env = 0.5 + 0.5 * Math.sin(t * 0.8 + rng() * 0.001);
    data[i] += Math.sin(2 * Math.PI * fmt1 * t) * amp * 0.04 * env;
    data[i] += Math.sin(2 * Math.PI * fmt2 * t) * amp * 0.03 * env;
  }

  const nT = 2 + Math.floor(rng() * 3);
  for (let k = 0; k < nT; k++) {
    const at = Math.floor(rng() * (length - 2000));
    const f = 400 + rng() * 1400;
    const dur = Math.floor(0.15 * rate + rng() * 0.3 * rate);
    for (let i = 0; i < dur && at + i < length; i++) {
      const env = Math.exp(-i / (rate * 0.15));
      data[at + i] += Math.sin(2 * Math.PI * f * (i / rate)) * amp * env * 0.45;
    }
  }

  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(data[i]));
  const norm = peak > 0 ? 0.85 / peak : 1;
  for (let i = 0; i < length; i++) data[i] = Math.tanh(data[i] * norm);

  return buffer;
}

function btnIcon(disabled: boolean): CSSProperties {
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

interface WavPlayerProps {
  day: Day;
  hour: number;
  threshold: number;
  segIndex?: number;
  onSegIndex?: (i: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  onProgressChange?: (p: number) => void;
}

export function WavPlayer({
  day, hour, threshold,
  segIndex: segProp, onSegIndex,
  onPlayingChange, onProgressChange,
}: WavPlayerProps) {
  const { timeFormat } = useTweaks();
  const [segLocal, setSegLocal] = useState<number>(() => {
    const seed = (day.key.charCodeAt(4) * 31 + hour * 2731 + day.hours[hour] * 100) | 0;
    return ((seed >>> 0) % SEGMENTS_PER_HOUR);
  });
  const segIndex = segProp != null ? segProp : segLocal;
  const setSegIndex = (v: number) => { onSegIndex ? onSegIndex(v) : setSegLocal(v); };

  const [playing, setPlaying] = useState(false);
  useEffect(() => { onPlayingChange?.(playing); }, [playing, onPlayingChange]);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(10);
  const [volume, setVolume] = useState(0.7);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const startedAtRef = useRef(0);
  const startOffsetRef = useRef(0);
  const rafRef = useRef<number>(0);
  const bufferRef = useRef<AudioBuffer | null>(null);

  const stop = useCallback(() => {
    try { srcRef.current?.stop(); } catch { /* already stopped */ }
    srcRef.current = null;
    cancelAnimationFrame(rafRef.current);
    setPlaying(false);
  }, []);

  useEffect(() => {
    stop();
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = audioCtxRef.current ?? (audioCtxRef.current = new Ctx());
    const seed = ((day.key.charCodeAt(4) * 31 + hour * 2731 + day.hours[hour] * 100 + segIndex * 9173) | 0) >>> 0;
    const buf = synthesizeSegment(ctx, seed, day.hours[hour]);
    bufferRef.current = buf;
    setDuration(buf.duration);
    setProgress(0);
    startOffsetRef.current = 0;
    onProgressChange?.(0);
  }, [day.key, hour, segIndex]);

  const play = useCallback(() => {
    const ctx = audioCtxRef.current;
    const buf = bufferRef.current;
    if (!ctx || !buf) return;
    if (ctx.state === 'suspended') ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(ctx.destination);
    src.start(0, startOffsetRef.current);
    src.onended = () => {
      if (srcRef.current === src) {
        srcRef.current = null;
        setPlaying(false);
        setProgress(0);
        startOffsetRef.current = 0;
      }
    };
    srcRef.current = src;
    gainRef.current = gain;
    startedAtRef.current = ctx.currentTime;
    setPlaying(true);

    const tick = () => {
      if (!srcRef.current) return;
      const elapsed = ctx.currentTime - startedAtRef.current;
      const p = startOffsetRef.current + elapsed;
      const capped = Math.min(p, buf.duration);
      setProgress(capped);
      onProgressChange?.(capped / (buf.duration || 1));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [volume]);

  const toggle = useCallback(() => {
    if (playing) {
      const ctx = audioCtxRef.current;
      if (ctx && srcRef.current) {
        const elapsed = ctx.currentTime - startedAtRef.current;
        startOffsetRef.current = Math.min(startOffsetRef.current + elapsed, duration);
      }
      stop();
    } else {
      play();
    }
  }, [playing, play, stop, duration]);

  useEffect(() => { if (gainRef.current) gainRef.current.gain.value = volume; }, [volume]);
  useEffect(() => () => { stop(); try { audioCtxRef.current?.close(); } catch { /* ignore */ } }, [stop]);

  const segments = useMemo(() => {
    const rng = mulberry32((day.key.charCodeAt(4) * 17 + hour * 31) | 0);
    return Array.from({ length: SEGMENTS_PER_HOUR }, (_, i) => {
      const wobble = (rng() - 0.5) * 3;
      const db = Math.max(40, Math.min(108, day.hours[hour] + wobble));
      return {
        i,
        db: +db.toFixed(1),
        breach: db >= threshold,
        size: ((700 + rng() * 300) | 0),
      };
    });
  }, [day.key, hour, threshold]);

  const current = segments[segIndex];
  const segStart = segIndex * SEGMENT_MINUTES;
  const fileName = `${day.key}_${pad2(hour)}-${pad2(segStart)}.wav`;

  const scrub = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    startOffsetRef.current = x * duration;
    setProgress(x * duration);
    if (playing) { stop(); play(); }
  };

  return (
    <div style={{
      background: 'var(--bg-2)',
      border: '1px solid var(--line)',
      borderRadius: 8,
      padding: 12,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            Recording · 5-min WAV · 48 kHz mono
          </div>
          <div className="mono" style={{ fontSize: 12, color: 'var(--ink-0)', marginTop: 2 }}>
            {fileName}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
            SEG {pad2(segIndex + 1)}/12 · {current.size} KB
          </div>
          <div className="mono" style={{ fontSize: 10, color: current.breach ? 'var(--neon-hot)' : 'var(--ink-2)', marginTop: 2 }}>
            {current.db.toFixed(1)} dB {current.breach ? '· BREACH' : ''}
          </div>
        </div>
      </div>

      <div>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${SEGMENTS_PER_HOUR}, 1fr)`, gap: 2 }}>
          {segments.map((s) => {
            const active = s.i === segIndex;
            return (
              <button
                key={s.i}
                onClick={() => setSegIndex(s.i)}
                title={`${formatSegTime(hour, s.i, 0, timeFormat)} · ${s.db} dB`}
                style={{
                  height: 26,
                  background: s.breach
                    ? (active ? 'var(--neon-hot)' : 'oklch(45% 0.12 35)')
                    : (active ? 'var(--bg-3)' : 'var(--bg-1)'),
                  border: `1px solid ${active ? 'var(--neon-focus)' : 'var(--line)'}`,
                  borderRadius: 3,
                  cursor: 'pointer',
                  color: active && s.breach ? '#0a0a0a' : 'var(--ink-2)',
                  fontFamily: 'var(--mono)',
                  fontSize: 9,
                  padding: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 120ms',
                }}
              >
                {pad2(s.i + 1)}
              </button>
            );
          })}
        </div>
        <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--ink-3)', marginTop: 4 }}>
          <span>{formatHour(hour, timeFormat)}</span><span>:15</span><span>:30</span><span>:45</span><span>{formatHour((hour + 1) % 24, timeFormat)}</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={() => setSegIndex(Math.max(0, segIndex - 1))} disabled={segIndex === 0}
          style={btnIcon(segIndex === 0)} aria-label="Previous segment">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M7 2 L3 5 L7 8 Z M2 2 L2 8" stroke="currentColor" fill="currentColor" strokeWidth="1" /></svg>
        </button>

        <button onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}
          style={{ width: 36, height: 36, borderRadius: 18, background: 'var(--ink-0)', border: 'none', color: 'var(--bg-0)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          {playing
            ? <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2.5" y="2" width="2.5" height="8" fill="currentColor" /><rect x="7" y="2" width="2.5" height="8" fill="currentColor" /></svg>
            : <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 2 L10 6 L3 10 Z" fill="currentColor" /></svg>}
        </button>

        <button onClick={() => setSegIndex(Math.min(SEGMENTS_PER_HOUR - 1, segIndex + 1))} disabled={segIndex === SEGMENTS_PER_HOUR - 1}
          style={btnIcon(segIndex === SEGMENTS_PER_HOUR - 1)} aria-label="Next segment">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 2 L7 5 L3 8 Z M8 2 L8 8" stroke="currentColor" fill="currentColor" strokeWidth="1" /></svg>
        </button>

        <div onClick={scrub} style={{ flex: 1, height: 20, position: 'relative', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
          <div style={{ position: 'absolute', inset: 'calc(50% - 2px) 0 auto 0', height: 4, background: 'var(--bg-3)', borderRadius: 2 }} />
          <div style={{ position: 'absolute', top: 'calc(50% - 2px)', left: 0, width: `${(progress / duration) * 100}%`, height: 4, background: 'var(--neon-cool)', borderRadius: 2 }} />
          <div style={{ position: 'absolute', left: `${(progress / duration) * 100}%`, top: '50%', width: 10, height: 10, marginLeft: -5, marginTop: -5, background: 'var(--ink-0)', borderRadius: 5, boxShadow: '0 1px 3px rgba(0,0,0,0.5)' }} />
        </div>

        <div className="mono" style={{ fontSize: 11, color: 'var(--ink-1)', minWidth: 60, textAlign: 'right' }}>
          {formatDuration(progress)} <span style={{ color: 'var(--ink-3)' }}>/ {formatDuration(duration)}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: 80 }}>
          <svg width="12" height="12" viewBox="0 0 12 12" style={{ color: 'var(--ink-3)' }}>
            <path d="M1 4 L4 4 L7 1 L7 11 L4 8 L1 8 Z" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
          <input type="range" min="0" max="1" step="0.01" value={volume}
            onChange={(e) => setVolume(+e.target.value)} style={{ flex: 1 }} />
        </div>

        <button
          onClick={() => alert(`Would download ${fileName}\n\n(This is a prototype — segments are synthesized in-browser.)`)}
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
          }}
          title="Download .wav"
        >
          ↓ WAV
        </button>
      </div>

      <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.05em' }}>
        PREVIEW · 10s of {SEGMENT_MINUTES}-min segment · starts at {formatSegTime(hour, segIndex, 0, timeFormat)}
      </div>
    </div>
  );
}

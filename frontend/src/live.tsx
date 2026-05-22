import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  deleteEvent,
  fetchDevice,
  fetchEventIndex,
  fetchEventsInRange,
  fetchSpectrogramHistory,
  fetchTelemetry,
  liveDeviceSocket,
  liveSocket,
} from './api';
import { EventsList } from './events/EventsList';
import { EventPlayer } from './events/EventPlayer';
import { HourPlaybackViewer } from './events/HourPlayback';
import { LabelPicker } from './events/LabelPicker';
import {
  HistoryRibbon24h,
  HistorySpectrogram,
  LiveSpectrogram,
  SPECTROGRAM_COLUMN_MS,
  useHistoryRibbon,
  useRollingBands,
} from './spectrogram';
import { useTweaks } from './tweaks';
import type {
  DeviceEvent,
  DeviceInfo,
  DeviceLiveMessage,
  DeviceTelemetryPoint,
  EventIndexEntry,
  Gap,
  LiveMessage,
} from './types';

const fmtTime = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const pad2 = (n: number) => String(n).padStart(2, '0');

function fmtHourRange(unixSec: number): string {
  const start = new Date(unixSec * 1000);
  const end = new Date((unixSec + 3600) * 1000);
  return `${pad2(start.getHours())}:${pad2(start.getMinutes())} → ${pad2(end.getHours())}:${pad2(end.getMinutes())}`;
}

interface LiveSnapshot {
  date: string;
  minutes: (number | null)[];
  gaps: Gap[];
  nowMin: number;
  streaming: boolean;
  stoppedAt: number | null;
}

const EMPTY_SNAPSHOT: LiveSnapshot = {
  date: '',
  minutes: [],
  gaps: [],
  nowMin: 0,
  streaming: false,
  stoppedAt: null,
};

function useLiveStream(enabled: boolean): {
  state: LiveSnapshot;
  toggle: () => void;
} {
  const [state, setState] = useState<LiveSnapshot>(EMPTY_SNAPSHOT);
  const wsRef = useRef<WebSocket | null>(null);
  const wantRef = useRef(true);

  const open = () => {
    wantRef.current = true;
    const ws = liveSocket();
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as LiveMessage;
        if (msg.type === 'snapshot') {
          setState({
            date: msg.date,
            minutes: msg.minutes,
            gaps: msg.gaps,
            nowMin: msg.now_min,
            streaming: true,
            stoppedAt: null,
          });
        } else if (msg.type === 'tick') {
          setState((prev) => {
            const minutes = prev.minutes.slice();
            // Backend sends absolute minute index; pad if there's a jump.
            while (minutes.length <= msg.now_min) minutes.push(null);
            minutes[msg.now_min] = msg.db;
            return { ...prev, nowMin: msg.now_min, minutes, streaming: true };
          });
        }
      } catch {
        // ignore malformed payloads
      }
    };
    ws.onclose = () => {
      if (wantRef.current) {
        // unexpected close — reflect as stopped
        setState((prev) => ({ ...prev, streaming: false, stoppedAt: prev.nowMin }));
      }
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  };

  useEffect(() => {
    if (!enabled) return;
    open();
    return () => {
      wantRef.current = false;
      try { wsRef.current?.close(); } catch { /* ignore */ }
    };
  }, [enabled]);

  const toggle = () => {
    if (state.streaming) {
      wantRef.current = false;
      try { wsRef.current?.close(); } catch { /* ignore */ }
      setState((prev) => ({ ...prev, streaming: false, stoppedAt: prev.nowMin }));
    } else {
      open();
    }
  };

  return { state, toggle };
}

interface LiveViewProps { threshold: number }

export function LiveView({ threshold }: LiveViewProps) {
  const { state, toggle } = useLiveStream(true);
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [actualNow, setActualNow] = useState(0);

  useEffect(() => { setActualNow(state.nowMin); }, [state.nowMin]);
  useEffect(() => {
    // Keep "actualNow" ticking when stopped — simulates wall clock for the NOW marker.
    if (state.streaming) return;
    const id = setInterval(() => {
      setActualNow((t) => Math.min(24 * 60 - 1, t + 1));
    }, 4000);
    return () => clearInterval(id);
  }, [state.streaming]);

  const lastStreamMin = state.streaming ? state.nowMin : (state.stoppedAt ?? state.nowMin);

  const valid = state.minutes.filter((v): v is number => v != null);
  const mean = valid.length ? +(valid.reduce((a, v) => a + v, 0) / valid.length).toFixed(1) : 0;
  const peak = valid.length ? Math.max(...valid) : 0;
  const peakIdx = peak ? state.minutes.indexOf(peak) : -1;
  const breaches = state.minutes.filter((v): v is number => v != null && v >= threshold).length;
  const lastDb = state.minutes[lastStreamMin] ?? null;

  const hourly = useMemo(() => {
    return Array.from({ length: 24 }, (_, h) => {
      const slice = state.minutes.slice(h * 60, (h + 1) * 60).filter((v): v is number => v != null);
      if (!slice.length) return null;
      return {
        mean: slice.reduce((a, v) => a + v, 0) / slice.length,
        peak: Math.max(...slice),
        coverage: slice.length / 60,
      };
    });
  }, [state.minutes]);

  const totalGapMin = state.gaps.reduce(
    (a, g) => a + Math.max(0, Math.min(g.end, lastStreamMin) - Math.min(g.start, lastStreamMin)),
    0,
  );
  const coverage = lastStreamMin > 0 ? 1 - totalGapMin / (lastStreamMin + 1) : 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 14, height: '100%', overflow: 'auto' }}>
      <StatusBanner
        streaming={state.streaming}
        lastStreamMin={lastStreamMin}
        actualNow={actualNow}
        coverage={coverage}
        onToggle={toggle}
        date={state.date}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
        <BigLiveStat label="Right now" value={lastDb != null ? lastDb.toFixed(1) : '—'} unit="dB"
          tone={lastDb != null && lastDb >= threshold ? 'hot' : lastDb != null && lastDb >= threshold - 8 ? 'warn' : 'default'}
          pulse={state.streaming} />
        <BigLiveStat label="Today's peak" value={peak.toFixed(1)} unit={`dB · ${fmtTime(peakIdx >= 0 ? peakIdx : 0)}`} tone="hot" />
        <BigLiveStat label="Today's avg" value={mean.toFixed(1)} unit="dB" />
        <BigLiveStat label="Breach minutes" value={String(breaches)} unit={`min ≥ ${threshold} dB`}
          tone={breaches > 0 ? 'warn' : 'default'} />
        <BigLiveStat label="Local time" value={fmtTime(actualNow)} unit={state.date} />
      </div>

      <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <div style={{ fontSize: 13, color: 'var(--ink-0)', fontWeight: 500 }}>
                {selectedHour == null ? 'Current hour · minute-resolution' : `Hour ${String(selectedHour).padStart(2, '0')}:00 · minute-resolution`}
              </div>
              {selectedHour != null && (
                <button
                  onClick={() => setSelectedHour(null)}
                  style={{
                    fontSize: 9, fontFamily: 'var(--mono)', letterSpacing: '0.12em',
                    textTransform: 'uppercase', padding: '3px 8px',
                    background: 'var(--bg-2)', border: '1px solid var(--line)',
                    color: 'var(--ink-2)', borderRadius: 3, cursor: 'pointer',
                  }}
                >● Follow live</button>
              )}
            </div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em', marginTop: 2 }}>
              {(() => {
                const h = selectedHour != null ? selectedHour : Math.floor(lastStreamMin / 60);
                const endMin = selectedHour != null ? Math.min(h * 60 + 59, lastStreamMin) : lastStreamMin;
                return `${state.date} · ${fmtTime(h * 60)} → ${fmtTime(endMin)} · 60-min canvas`;
              })()}
            </div>
          </div>
          <div className="mono" style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--ink-3)' }}>
            <Legend dot="var(--neon-cool)" label="Live" />
            <Legend dot="oklch(78% 0.18 35)" label={`≥ ${threshold} dB`} />
            <Legend dot="repeating-linear-gradient(45deg, oklch(40% 0.08 35) 0 4px, transparent 4px 8px)" label="Gap" striped />
            <Legend dot="var(--bg-3)" label="Future / not yet" />
          </div>
        </div>

        <CurrentHourTimeline
          minutes={state.minutes}
          gaps={state.gaps}
          nowMin={actualNow}
          lastStreamMin={lastStreamMin}
          streaming={state.streaming}
          threshold={threshold}
          selectedHour={selectedHour}
        />

        <div style={{ marginTop: 14 }}>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em', marginBottom: 6 }}>
            BY HOUR
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 2, height: 36 }}>
            {hourly.map((h, i) => {
              const isFuture = i * 60 > lastStreamMin;
              const isCurrent = Math.floor(lastStreamMin / 60) === i;
              if (!h || isFuture) {
                return (
                  <div key={i} title={isFuture ? 'Future' : 'No data'} style={{
                    background: isFuture ? 'var(--bg-2)' : 'transparent',
                    border: `1px ${isFuture ? 'solid' : 'dashed'} var(--line)`,
                    borderRadius: 3,
                  }} />
                );
              }
              const breach = h.mean >= threshold;
              const warn = h.mean >= threshold - 8;
              const t = Math.max(0, Math.min(1, (h.mean - 40) / 50));
              const fill = breach
                ? 'oklch(72% 0.2 35)'
                : warn
                ? 'oklch(82% 0.16 70)'
                : `oklch(${30 + t * 40}% ${(0.04 + t * 0.1).toFixed(3)} ${(210 - t * 15).toFixed(1)})`;
              return (
                <div
                  key={i}
                  onClick={() => setSelectedHour(isCurrent ? null : i)}
                  title={`${String(i).padStart(2, '0')}:00 · avg ${h.mean.toFixed(1)} dB · peak ${h.peak.toFixed(1)} · ${(h.coverage * 100).toFixed(0)}% covered${isCurrent ? ' · CURRENT HOUR' : ' · click to view'}`}
                  style={{
                    background: fill,
                    borderRadius: 3,
                    position: 'relative',
                    opacity: h.coverage < 0.95 ? 0.55 : 1,
                    cursor: 'pointer',
                    outline: selectedHour === i
                      ? '1.5px solid var(--neon-focus)'
                      : isCurrent
                      ? `1.5px solid ${state.streaming ? 'var(--neon-cool)' : 'oklch(78% 0.18 35)'}`
                      : 'none',
                    outlineOffset: 1,
                    boxShadow: selectedHour === i
                      ? '0 0 10px oklch(70% 0.14 215 / 0.6)'
                      : isCurrent
                      ? `0 0 8px ${state.streaming ? 'oklch(70% 0.14 215 / 0.5)' : 'oklch(78% 0.18 35 / 0.5)'}`
                      : 'none',
                  }}>
                  {h.coverage < 0.95 && (
                    <div style={{
                      position: 'absolute', inset: 0,
                      background: 'repeating-linear-gradient(45deg, transparent 0 3px, rgba(0,0,0,0.4) 3px 5px)',
                      borderRadius: 3, pointerEvents: 'none',
                    }} />
                  )}
                </div>
              );
            })}
          </div>
          <div className="mono" style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', fontSize: 9, color: 'var(--ink-3)', marginTop: 4 }}>
            {Array.from({ length: 24 }).map((_, h) => (
              <div key={h} style={{ textAlign: 'center', opacity: h % 3 === 0 ? 1 : 0.4 }}>{String(h).padStart(2, '0')}</div>
            ))}
          </div>
        </div>
      </div>

      <GapLog
        gaps={state.gaps}
        lastStreamMin={lastStreamMin}
        actualNow={actualNow}
        streaming={state.streaming}
        totalGapMin={totalGapMin}
      />
    </div>
  );
}

function StatusBanner({
  streaming, lastStreamMin, actualNow, coverage, onToggle, date,
}: {
  streaming: boolean; lastStreamMin: number; actualNow: number; coverage: number; onToggle: () => void; date: string;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 16px',
      background: streaming ? 'var(--bg-1)' : 'oklch(22% 0.06 35)',
      border: `1px solid ${streaming ? 'var(--line)' : 'oklch(50% 0.15 35)'}`,
      borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 10, height: 10, borderRadius: 5,
            background: streaming ? 'var(--neon-hot)' : 'oklch(78% 0.18 35)',
            boxShadow: streaming ? '0 0 10px var(--neon-hot)' : 'none',
            animation: streaming ? 'live-pulse 1.4s ease-in-out infinite' : 'none',
          }} />
          <span className="mono" style={{
            fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase',
            color: streaming ? 'var(--neon-hot)' : 'oklch(85% 0.16 35)',
            fontWeight: 600,
          }}>
            {streaming ? 'Streaming live' : 'Stream stopped'}
          </span>
        </div>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-2)' }}>
          SNS-0412 · Canal & 7th · 48 kHz · A-weighted
        </span>
        {!streaming && (
          <span className="mono" style={{ fontSize: 11, color: 'oklch(85% 0.16 35)' }}>
            · last sample {fmtTime(lastStreamMin)} · {Math.max(0, actualNow - lastStreamMin)} min ago
          </span>
        )}
        {date && (
          <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>· {date}</span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
          COVERAGE {(coverage * 100).toFixed(1)}%
        </span>
        <button
          onClick={onToggle}
          style={{
            padding: '5px 12px',
            fontSize: 10, fontFamily: 'var(--mono)',
            letterSpacing: '0.12em', textTransform: 'uppercase',
            background: streaming ? 'var(--bg-2)' : 'var(--neon-hot)',
            border: `1px solid ${streaming ? 'var(--line)' : 'var(--neon-hot)'}`,
            color: streaming ? 'var(--ink-1)' : '#0a0a0a',
            borderRadius: 4, cursor: 'pointer', fontWeight: 600,
          }}
        >{streaming ? 'Simulate stop' : 'Resume'}</button>
      </div>
    </div>
  );
}

function BigLiveStat({ label, value, unit, tone = 'default', pulse = false }: {
  label: string; value: string; unit?: string; tone?: 'hot' | 'warn' | 'default'; pulse?: boolean;
}) {
  const color = tone === 'hot' ? 'var(--neon-hot)' : tone === 'warn' ? 'oklch(82% 0.16 70)' : 'var(--ink-0)';
  return (
    <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 14px', position: 'relative', overflow: 'hidden' }}>
      <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 4 }}>
        <span className="mono" style={{ fontSize: 24, color, letterSpacing: '-0.02em', fontWeight: 500 }}>{value}</span>
        {unit && <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>{unit}</span>}
        {pulse && <span style={{ marginLeft: 'auto', width: 6, height: 6, borderRadius: 3, background: 'var(--neon-hot)', animation: 'live-pulse 1.4s ease-in-out infinite' }} />}
      </div>
    </div>
  );
}

function Legend({ dot, label, striped }: { dot: string; label: string; striped?: boolean }) {
  const _ = striped;  // styling parity with original; kept as a single-prop hook
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 14, height: 8, background: dot, borderRadius: 1 }} />
      <span style={{ color: 'var(--ink-2)' }}>{label}</span>
    </span>
  );
}

function GapLog({ gaps, lastStreamMin, actualNow, streaming, totalGapMin }: {
  gaps: Gap[]; lastStreamMin: number; actualNow: number; streaming: boolean; totalGapMin: number;
}) {
  const visibleGaps = gaps.filter((g) => g.start <= lastStreamMin);
  return (
    <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <div style={{ fontSize: 13, color: 'var(--ink-0)', fontWeight: 500 }}>Streaming gaps · today</div>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em' }}>
          {visibleGaps.length + (!streaming ? 1 : 0)} EVENT(S) · {totalGapMin} MIN MISSING
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visibleGaps.map((g, i) => (
          <GapRow key={i} start={g.start} end={Math.min(g.end, lastStreamMin)} reason={g.reason} />
        ))}
        {!streaming && (
          <GapRow
            start={lastStreamMin}
            end={actualNow}
            reason="Stream stopped — awaiting reconnect"
            ongoing
          />
        )}
        {streaming && visibleGaps.length === 0 && (
          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', padding: '8px 0' }}>
            No gaps detected so far today.
          </div>
        )}
      </div>
    </div>
  );
}

function GapRow({ start, end, reason, ongoing }: {
  start: number; end: number; reason: string; ongoing?: boolean;
}) {
  const duration = Math.max(0, end - start);
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '120px 1fr 80px 200px',
      alignItems: 'center',
      gap: 10,
      padding: '8px 10px',
      background: 'var(--bg-2)',
      borderRadius: 4,
      borderLeft: `2px solid ${ongoing ? 'var(--neon-hot)' : 'oklch(60% 0.12 35)'}`,
    }}>
      <span className="mono" style={{ fontSize: 11, color: 'var(--ink-1)' }}>
        {fmtTime(start)} → {ongoing ? `${fmtTime(end)} (now)` : fmtTime(end)}
      </span>
      <div style={{ height: 6, background: 'var(--bg-3)', borderRadius: 3, position: 'relative', overflow: 'hidden' }}>
        <div style={{
          position: 'absolute',
          left: `${(start / (24 * 60)) * 100}%`,
          width: `${(duration / (24 * 60)) * 100}%`,
          top: 0, bottom: 0,
          background: ongoing
            ? 'var(--neon-hot)'
            : 'repeating-linear-gradient(45deg, oklch(60% 0.12 35) 0 4px, oklch(40% 0.08 35) 4px 8px)',
        }} />
      </div>
      <span className="mono" style={{ fontSize: 11, color: 'var(--ink-2)', textAlign: 'right' }}>{duration} min</span>
      <span className="mono" style={{ fontSize: 11, color: ongoing ? 'var(--neon-hot)' : 'var(--ink-2)' }}>
        {ongoing ? '● ' : ''}{reason}
      </span>
    </div>
  );
}

function makeHatch(tone: 'amber' | 'hot' = 'amber'): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 8;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = tone === 'hot' ? 'oklch(35% 0.12 35 / 0.55)' : 'oklch(30% 0.06 35 / 0.5)';
  ctx.fillRect(0, 0, 8, 8);
  ctx.strokeStyle = tone === 'hot' ? 'oklch(72% 0.2 35 / 0.7)' : 'oklch(60% 0.12 35 / 0.7)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-1, 9); ctx.lineTo(9, -1);
  ctx.moveTo(-1, 17); ctx.lineTo(17, -1);
  ctx.stroke();
  return c;
}

function Marker({ pos, color, label, time, pulse, dashed }: {
  pos: number; color: string; label: string; time: string; pulse?: boolean; dashed?: boolean;
}) {
  const style: CSSProperties = {
    position: 'absolute',
    left: `${pos * 100}%`,
    top: 0, bottom: 16,
    width: 0,
    borderLeft: `${dashed ? '1px dashed' : '1.5px solid'} ${color}`,
    pointerEvents: 'none',
  };
  return (
    <div style={style}>
      <div className="mono" style={{
        position: 'absolute', top: -2, left: 4,
        whiteSpace: 'nowrap', fontSize: 9, color, letterSpacing: '0.1em',
        background: 'var(--bg-1)', padding: '1px 5px', borderRadius: 2, border: `1px solid ${color}`,
      }}>
        {pulse
          ? <span style={{ animation: 'live-pulse 1.4s ease-in-out infinite' }}>{label}</span>
          : label}
        <span style={{ color: 'var(--ink-3)', marginLeft: 6 }}>{time}</span>
      </div>
    </div>
  );
}

function CurrentHourTimeline({
  minutes, gaps, nowMin, lastStreamMin, streaming, threshold, selectedHour,
}: {
  minutes: (number | null)[]; gaps: Gap[]; nowMin: number; lastStreamMin: number;
  streaming: boolean; threshold: number; selectedHour: number | null;
}) {
  const isLive = selectedHour == null;
  const hourStart = isLive ? Math.floor(lastStreamMin / 60) * 60 : selectedHour * 60;
  const localLast = isLive
    ? lastStreamMin - hourStart
    : Math.min(59, Math.max(-1, lastStreamMin - hourStart));
  const SUB = 60;
  const W = 60 * SUB;
  const H = 110;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let m = 0; m <= 60; m += 5) {
      ctx.beginPath();
      const x = m * SUB + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
      ctx.stroke();
    }
    const tY = H - ((threshold - 30) / 70) * H;
    ctx.strokeStyle = 'oklch(78% 0.18 35 / 0.5)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, tY); ctx.lineTo(W, tY);
    ctx.stroke();
    ctx.setLineDash([]);

    if (localLast < 60) {
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect((localLast + 1) * SUB, 0, (60 - localLast - 1) * SUB, H);
    }

    const seedRand = (seed: number) => {
      let s = (seed * 2654435761) >>> 0;
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xffffffff;
      };
    };

    for (let i = 0; i <= localLast && i < 60; i++) {
      const v = minutes[hourStart + i];
      if (v == null) continue;
      const r = seedRand(hourStart + i + 7919);
      const N = 50;
      for (let k = 0; k < N; k++) {
        const noise = (r() - 0.5) * 6;
        const spike = r() < 0.06 ? r() * 14 : 0;
        const dip = r() < 0.04 ? -r() * 8 : 0;
        const sampleV = Math.max(30, Math.min(100, v + noise + spike + dip));
        const y = H - Math.max(2, ((sampleV - 30) / 70) * H);
        const breach = sampleV >= threshold;
        const warn = sampleV >= threshold - 8;
        ctx.fillStyle = breach
          ? 'oklch(78% 0.2 35)'
          : warn
          ? 'oklch(82% 0.16 70)'
          : `oklch(${42 + ((sampleV - 40) / 40) * 40}% ${(0.05 + ((sampleV - 40) / 40) * 0.08).toFixed(3)} 215)`;
        const x = i * SUB + Math.floor((k / N) * SUB);
        ctx.fillRect(x, y, 1, H - y);
      }
    }

    gaps.forEach((g) => {
      const gs = Math.max(g.start, hourStart);
      const ge = Math.min(g.end, hourStart + Math.min(60, localLast + 1));
      if (gs >= ge) return;
      const pat = ctx.createPattern(makeHatch(), 'repeat');
      if (pat) { ctx.fillStyle = pat; ctx.fillRect((gs - hourStart) * SUB, 0, (ge - gs) * SUB, H); }
      ctx.strokeStyle = 'oklch(60% 0.12 35 / 0.7)';
      ctx.strokeRect((gs - hourStart) * SUB + 0.5, 0.5, (ge - gs) * SUB - 1, H - 1);
    });

    if (!streaming && nowMin > lastStreamMin) {
      const stopStart = Math.max(0, lastStreamMin - hourStart + 1);
      const stopEnd = Math.min(60, nowMin - hourStart + 1);
      if (stopEnd > stopStart) {
        const pat = ctx.createPattern(makeHatch('hot'), 'repeat');
        if (pat) { ctx.fillStyle = pat; ctx.fillRect(stopStart * SUB, 0, (stopEnd - stopStart) * SUB, H); }
        ctx.strokeStyle = 'oklch(78% 0.18 35)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(stopStart * SUB + 0.5, 0.5, (stopEnd - stopStart) * SUB - 1, H - 1);
      }
    }
  }, [minutes, gaps, nowMin, lastStreamMin, streaming, threshold, hourStart, localLast]);

  return (
    <div style={{ position: 'relative' }}>
      <canvas ref={canvasRef}
        style={{ width: '100%', height: H, display: 'block', borderRadius: 4, background: 'var(--bg-2)' }} />
      {isLive && (
        <Marker
          pos={(localLast + 1) / 60}
          color={streaming ? 'var(--neon-cool)' : 'oklch(78% 0.18 35)'}
          label={streaming ? '● LIVE' : '● LAST SAMPLE'}
          time={fmtTime(lastStreamMin)}
          pulse={streaming}
        />
      )}
      {!streaming && isLive && nowMin > lastStreamMin && nowMin < hourStart + 60 && (
        <Marker pos={(nowMin - hourStart + 1) / 60} color="var(--ink-2)" label="NOW" time={fmtTime(nowMin)} dashed />
      )}
      <div className="mono" style={{
        display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)',
        fontSize: 9, color: 'var(--ink-3)', marginTop: 4,
      }}>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} style={{ textAlign: i === 0 ? 'left' : i === 11 ? 'right' : 'center' }}>
            {fmtTime(hourStart + i * 5)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Real-device mode — Phase 1 minimal panel powered by /api/v1
// ---------------------------------------------------------------------------

const TELEMETRY_WINDOW_S = 30 * 60;   // last 30 minutes at 1m resolution
const TELEMETRY_POLL_MS = 5000;
const EVENT_POLL_MS = 10000;

// Spectrogram rolling-window: ~60 s at the wire rate (≈12 Hz, see Pi
// supervisor's spectrogram_decimate). 720 columns is enough headroom even
// if a particular Pi runs un-decimated.
const SPECT_MAX_FRAMES = 720;

// History ribbon: 1-hour window, ~1200 display columns → 3 s/bucket. Frames
// inside a bucket are max-merged, so spikes survive the downsample.
const HISTORY_WINDOW_S = 3600;
const HISTORY_COLS = 1200;

interface RealLiveViewProps {
  deviceId: string;
  threshold: number;
}

export function RealLiveView({ deviceId, threshold }: RealLiveViewProps) {
  const { spectroColor } = useTweaks();
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [points, setPoints] = useState<DeviceTelemetryPoint[]>([]);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  // Lightweight (ts, duration_s) listing for the 24h ribbon overlay. Polled
  // separately from `events` so we can keep that one capped at 50 for the
  // panel while still drawing every event as a band on the ribbon.
  const [eventIndex, setEventIndex] = useState<EventIndexEntry[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedHourTs, setSelectedHourTs] = useState<number | null>(null);
  // Set by clicking an event band on the 60-min ribbon — narrows the events
  // panel to just that one clip without touching the 24h hour selection.
  const [bandEventId, setBandEventId] = useState<string | null>(null);
  const [hourEvents, setHourEvents] = useState<DeviceEvent[] | null>(null);
  const [hourEventsLoading, setHourEventsLoading] = useState(false);
  const [hourEventsError, setHourEventsError] = useState<string | null>(null);
  const [deletingUnlabeled, setDeletingUnlabeled] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const spectRing = useRollingBands(SPECT_MAX_FRAMES);
  const historyRibbon = useHistoryRibbon(HISTORY_WINDOW_S, HISTORY_COLS);
  // Hold the push functions in refs so the WS effect doesn't re-subscribe
  // each render — the underlying buffers are stable across pushes.
  const spectPushRef = useRef(spectRing.push);
  const historyPushRef = useRef(historyRibbon.push);
  useEffect(() => { spectPushRef.current = spectRing.push; }, [spectRing.push]);
  useEffect(() => { historyPushRef.current = historyRibbon.push; }, [historyRibbon.push]);

  // Backfill the history ribbon on mount / device change, and again whenever
  // the tab regains visibility — backgrounded tabs throttle WS delivery and
  // timers, so live pushes drop frames and the ribbon shows NaN gaps. The
  // endpoint returns all stored frames in the window; push() max-merges them
  // into display buckets, which is idempotent for already-filled columns.
  useEffect(() => {
    let cancelled = false;
    const backfill = () => {
      const now = Date.now() / 1000;
      fetchSpectrogramHistory(deviceId, now - HISTORY_WINDOW_S, now)
        .then((r) => {
          if (cancelled) return;
          for (const fr of r.frames) historyPushRef.current(fr.ts, fr.bands);
        })
        .catch(() => { /* ribbon stays as-is on backfill failure */ });
    };
    backfill();
    const onVisible = () => {
      if (document.visibilityState === 'visible') backfill();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [deviceId]);

  // Device metadata: fetched once.
  useEffect(() => {
    let cancelled = false;
    fetchDevice(deviceId)
      .then((d) => { if (!cancelled) setDevice(d); })
      .catch((e: Error) => { if (!cancelled) setDeviceError(e.message); });
    return () => { cancelled = true; };
  }, [deviceId]);

  // Telemetry: poll every 5s. Live WS ticks (when available) interleave into
  // the same `points` buffer; if the WS never opens, polling is the source.
  const refreshTelemetry = useCallback(async () => {
    const now = Date.now() / 1000;
    try {
      const r = await fetchTelemetry(deviceId, now - TELEMETRY_WINDOW_S, now, '1m');
      setPoints(r.points);
      setTelemetryError(null);
    } catch (e) {
      setTelemetryError((e as Error).message);
    }
  }, [deviceId]);

  useEffect(() => {
    refreshTelemetry();
    // Skip the interval while the WS is pushing ticks — otherwise the 5 s
    // 1 m-bucketed poll keeps overwriting the dense per-second WS data and
    // the chart flips between sparse and dense. The initial fetch above
    // still runs so the chart fills in instantly on open / reconnect.
    if (wsConnected) return;
    const id = setInterval(refreshTelemetry, TELEMETRY_POLL_MS);
    return () => clearInterval(id);
  }, [refreshTelemetry, wsConnected]);

  // Events: poll every 10s. Default (unfiltered) view shows up to 50 most-recent
  // events from the past 24h — older clips only surface via the hour ribbon.
  const refreshEvents = useCallback(async () => {
    try {
      const now = Date.now() / 1000;
      const r = await fetchEventsInRange(deviceId, now - 86400, now, 50);
      setEvents(r);
      setEventsError(null);
    } catch (e) {
      setEventsError((e as Error).message);
    }
  }, [deviceId]);

  useEffect(() => {
    refreshEvents();
    const id = setInterval(refreshEvents, EVENT_POLL_MS);
    return () => clearInterval(id);
  }, [refreshEvents]);

  const handleDeleteUnlabeled = useCallback(async () => {
    if (deletingUnlabeled) return;
    const targets = (hourEvents ?? []).filter((e) => e.label == null);
    if (targets.length === 0) return;
    const ok = window.confirm(
      `Delete ${targets.length} unlabeled clip${targets.length === 1 ? '' : 's'} ` +
      `(audio + record) from this hour? This cannot be undone.`,
    );
    if (!ok) return;
    setDeletingUnlabeled(true);
    const results = await Promise.allSettled(
      targets.map((e) => deleteEvent(e.event_id)),
    );
    const deletedIds = new Set(
      results
        .map((r, i) => (r.status === 'fulfilled' ? targets[i].event_id : null))
        .filter((id): id is string => id != null),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    setEvents((prev) => prev.filter((e) => !deletedIds.has(e.event_id)));
    setHourEvents((prev) => prev?.filter((e) => !deletedIds.has(e.event_id)) ?? null);
    setSelectedEventId((prev) => (prev != null && deletedIds.has(prev) ? null : prev));
    setDeletingUnlabeled(false);
    refreshEvents();
    if (failed > 0) {
      window.alert(`Failed to delete ${failed} clip${failed === 1 ? '' : 's'}.`);
    }
  }, [deletingUnlabeled, hourEvents, refreshEvents]);

  // Event index: feeds the 24h ribbon's band overlay. Cheap enough to share
  // the events poll cadence — failures are silent so a backend hiccup just
  // freezes the bands instead of showing an error in the events panel.
  const refreshEventIndex = useCallback(async () => {
    try {
      const now = Date.now() / 1000;
      const r = await fetchEventIndex(deviceId, now - 86400, now);
      setEventIndex(r.events);
    } catch {
      // ignore — bands will simply stop updating
    }
  }, [deviceId]);

  useEffect(() => {
    refreshEventIndex();
    const id = setInterval(refreshEventIndex, EVENT_POLL_MS);
    return () => clearInterval(id);
  }, [refreshEventIndex]);

  // Hour-scoped events: when the user clicks a tile in the 24h ribbon, swap the
  // events list to that hour's clips (events older than the recent-50 may not
  // be in `events`, so a plain filter would miss them).
  useEffect(() => {
    if (selectedHourTs == null) {
      setHourEvents(null);
      setHourEventsError(null);
      setHourEventsLoading(false);
      return;
    }
    let cancelled = false;
    setHourEventsLoading(true);
    setHourEventsError(null);
    setSelectedEventId(null);
    fetchEventsInRange(deviceId, selectedHourTs, selectedHourTs + 3600)
      .then((rows) => {
        if (cancelled) return;
        setHourEvents(rows);
        // Pre-select earliest event so the breach-timeline highlights one.
        const asc = [...rows].sort((a, b) => a.ts - b.ts);
        if (asc.length) setSelectedEventId(asc[0].event_id);
      })
      .catch((e: Error) => { if (!cancelled) setHourEventsError(e.message); })
      .finally(() => { if (!cancelled) setHourEventsLoading(false); });
    return () => { cancelled = true; };
  }, [deviceId, selectedHourTs]);

  // Forward-compatible live WS: tick messages append to telemetry. If the
  // endpoint isn't wired up yet (close on connect), polling still drives the
  // display.
  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    try {
      ws = liveDeviceSocket(deviceId);
    } catch {
      return;
    }
    ws.onopen = () => { if (!closed) setWsConnected(true); };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as DeviceLiveMessage;
        if (msg.type === 'tick') {
          setPoints((prev) => {
            const next = prev.concat({
              ts: msg.ts,
              laeq: msg.laeq,
              lafmax: msg.lafmax,
              lcpeak: msg.lcpeak,
            });
            const cutoff = Date.now() / 1000 - TELEMETRY_WINDOW_S;
            return next.filter((p) => p.ts >= cutoff);
          });
        } else if (msg.type === 'spect') {
          spectPushRef.current(msg.ts, msg.bands);
          historyPushRef.current(msg.ts, msg.bands);
        }
        // 'ping' is a keepalive — no UI side-effect.
      } catch {
        // ignore malformed payloads
      }
    };
    ws.onclose = () => setWsConnected(false);
    ws.onerror = () => {
      setWsConnected(false);
      try { ws?.close(); } catch { /* ignore */ }
    };
    return () => {
      closed = true;
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [deviceId]);

  const lastPoint = points.length ? points[points.length - 1] : null;
  const currentDb = lastPoint?.laeq ?? null;
  const peak = points.length ? Math.max(...points.map((p) => p.lafmax)) : null;
  const mean = points.length
    ? points.reduce((a, p) => a + p.laeq, 0) / points.length
    : null;
  const breaches = points.filter((p) => p.laeq >= threshold).length;
  const lastSampleAge = lastPoint ? Math.max(0, Date.now() / 1000 - lastPoint.ts) : null;

  // Band click takes precedence over the hour filter: it pins the panel to
  // a single event. If the chosen event has rolled off `events` (poll churn),
  // fall back to whatever the active filter would otherwise show.
  const bandEvent = useMemo(
    () => (bandEventId ? events.find((e) => e.event_id === bandEventId) ?? null : null),
    [bandEventId, events],
  );
  const activeEvents = bandEvent ? [bandEvent] : hourEvents ?? events;
  const selectedEvent = useMemo(
    () => activeEvents.find((e) => e.event_id === selectedEventId) ?? null,
    [activeEvents, selectedEventId],
  );
  const nextEvent = useMemo(() => {
    if (!selectedEventId) return null;
    const i = activeEvents.findIndex((e) => e.event_id === selectedEventId);
    return i >= 0 && i + 1 < activeEvents.length ? activeEvents[i + 1] : null;
  }, [activeEvents, selectedEventId]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 14, padding: 14,
      height: '100%', overflow: 'auto',
    }}>
      <DeviceBanner
        deviceId={deviceId}
        device={device}
        deviceError={deviceError}
        wsConnected={wsConnected}
        lastSampleAge={lastSampleAge}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        <BigLiveStat
          label="Right now"
          value={currentDb != null ? currentDb.toFixed(1) : '—'}
          unit="dB · LAeq"
          tone={
            currentDb != null && currentDb >= threshold
              ? 'hot'
              : currentDb != null && currentDb >= threshold - 8
                ? 'warn'
                : 'default'
          }
          pulse={wsConnected || lastPoint != null}
        />
        <BigLiveStat
          label="Window peak"
          value={peak != null ? peak.toFixed(1) : '—'}
          unit="dB · LAFmax"
          tone={peak != null && peak >= threshold ? 'hot' : 'default'}
        />
        <BigLiveStat
          label="Window avg"
          value={mean != null ? mean.toFixed(1) : '—'}
          unit="dB · LAeq"
        />
        <BigLiveStat
          label="Breach minutes"
          value={String(breaches)}
          unit={`min ≥ ${threshold} dB`}
          tone={breaches > 0 ? 'warn' : 'default'}
        />
      </div>

      <RealLiveSpectrogramPanel
        deviceId={deviceId}
        ring={spectRing}
        ribbon={historyRibbon}
        palette={spectroColor}
        threshold={threshold}
        points={points}
        recentEvents={events}
        ribbonEvents={eventIndex}
        selectedHourTs={selectedHourTs}
        onHourClick={(h) => {
          // Hour click clears any band-level event filter — the panel switches
          // to "events in that hour" instead of "events for this one clip".
          setBandEventId(null);
          setSelectedHourTs((prev) => (prev === h ? null : h));
        }}
        bandEventId={bandEventId}
        onBandClick={(id) => {
          setBandEventId(id);
          setSelectedEventId(id);
        }}
        hourEvents={hourEvents ?? []}
        hourEventsLoading={hourEventsLoading}
        hourEventsError={hourEventsError}
        selectedEventId={selectedEventId}
        onSelectEvent={setSelectedEventId}
        onCloseHour={() => setSelectedHourTs(null)}
        onDeleteUnlabeled={handleDeleteUnlabeled}
        deletingUnlabeled={deletingUnlabeled}
      />

      {telemetryError && (
        <div className="mono" style={{ fontSize: 11, color: 'var(--neon-hot)' }}>
          Telemetry: {telemetryError}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', gap: 14, minHeight: 0 }}>
        <div style={{
          background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8,
          display: 'flex', flexDirection: 'column', minHeight: 320,
        }}>
          <div style={{
            padding: '10px 14px', borderBottom: '1px solid var(--line)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div>
              <div className="mono" style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-2)' }}>
                {bandEvent ? 'Selected event' : selectedHourTs != null ? 'Hour events' : 'Recent events'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-1)', marginTop: 2 }}>
                {bandEvent
                  ? `Pinned from 60-min timeline · click ✕ to return to ${selectedHourTs != null ? 'hour' : 'recent'} list`
                  : selectedHourTs != null
                  ? `${activeEvents.length} event${activeEvents.length === 1 ? '' : 's'} in ${fmtHourRange(selectedHourTs)} · pick one to play & label`
                  : `${activeEvents.length} event${activeEvents.length === 1 ? '' : 's'} · pick one to play & label`}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {bandEvent && (
                <button
                  type="button"
                  onClick={() => setBandEventId(null)}
                  style={{
                    fontSize: 9, fontFamily: 'var(--mono)', letterSpacing: '0.12em',
                    textTransform: 'uppercase', padding: '3px 8px',
                    background: 'var(--bg-2)', border: '1px solid var(--line)',
                    color: 'var(--ink-2)', borderRadius: 3, cursor: 'pointer',
                  }}
                >✕ Clear event</button>
              )}
              {selectedHourTs != null && !bandEvent && (
                <button
                  type="button"
                  onClick={() => setSelectedHourTs(null)}
                  style={{
                    fontSize: 9, fontFamily: 'var(--mono)', letterSpacing: '0.12em',
                    textTransform: 'uppercase', padding: '3px 8px',
                    background: 'var(--bg-2)', border: '1px solid var(--line)',
                    color: 'var(--ink-2)', borderRadius: 3, cursor: 'pointer',
                  }}
                >✕ Clear filter</button>
              )}
              {(eventsError || hourEventsError) && (
                <span className="mono" style={{ fontSize: 10, color: 'var(--neon-hot)' }}>
                  {hourEventsError ?? eventsError}
                </span>
              )}
            </div>
          </div>
          <EventsList
            events={activeEvents}
            selectedId={selectedEventId}
            onSelect={(e) => setSelectedEventId(e.event_id)}
            threshold={threshold}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-2)', marginBottom: 8 }}>
              Playback
            </div>
            <EventPlayer
              event={selectedEvent}
              onNext={nextEvent ? () => setSelectedEventId(nextEvent.event_id) : undefined}
              onDeleted={(id) => {
                setEvents((prev) => prev.filter((e) => e.event_id !== id));
                setHourEvents((prev) => prev?.filter((e) => e.event_id !== id) ?? null);
                setSelectedEventId(null);
                refreshEvents();
              }}
            />
          </div>
          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-2)', marginBottom: 8 }}>
              Label
            </div>
            <LabelPicker
              event={selectedEvent}
              onLabelled={(eventId, label) => {
                // Optimistically patch the label across every list that
                // renders this event so the row text + ribbon band color
                // flip instantly, without waiting for the next 10s poll.
                const patch = (e: DeviceEvent) =>
                  e.event_id === eventId ? { ...e, label } : e;
                setEvents((prev) => prev.map(patch));
                setHourEvents((prev) => prev?.map(patch) ?? null);
                // The 24h ribbon's band overlay is keyed by ts (the index
                // entries don't carry event_id), so flip `labeled` on the
                // matching ts.
                const evTs = (events.find((e) => e.event_id === eventId)
                  ?? hourEvents?.find((e) => e.event_id === eventId))?.ts;
                if (evTs != null) {
                  setEventIndex((prev) =>
                    prev.map((x) => (x.ts === evTs ? { ...x, labeled: true } : x)));
                }
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function DeviceBanner({
  deviceId, device, deviceError, wsConnected, lastSampleAge,
}: {
  deviceId: string;
  device: DeviceInfo | null;
  deviceError: string | null;
  wsConnected: boolean;
  lastSampleAge: number | null;
}) {
  const fresh = lastSampleAge != null && lastSampleAge < 90;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 16px',
      background: fresh ? 'var(--bg-1)' : 'oklch(22% 0.06 35)',
      border: `1px solid ${fresh ? 'var(--line)' : 'oklch(50% 0.15 35)'}`,
      borderRadius: 8,
      gap: 14, flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 10, height: 10, borderRadius: 5,
            background: fresh ? 'var(--neon-ok)' : 'oklch(78% 0.18 35)',
            boxShadow: fresh ? '0 0 10px var(--neon-ok)' : 'none',
            animation: fresh ? 'live-pulse 1.4s ease-in-out infinite' : 'none',
          }} />
          <span className="mono" style={{
            fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase',
            color: fresh ? 'var(--neon-ok)' : 'oklch(85% 0.16 35)',
            fontWeight: 600,
          }}>
            {fresh ? 'Receiving telemetry' : lastSampleAge == null ? 'Waiting for data' : 'Stale'}
          </span>
        </div>
        <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
          ID {deviceId}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {lastSampleAge != null && (
          <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
            last sample {lastSampleAge < 90 ? `${Math.round(lastSampleAge)}s` : `${Math.round(lastSampleAge / 60)}m`} ago
          </span>
        )}
        <span className="mono" style={{ fontSize: 10, color: wsConnected ? 'var(--neon-cool)' : 'var(--ink-3)', letterSpacing: '0.12em' }}>
          {wsConnected ? '● WS LIVE' : '○ POLLING'}
        </span>
        {deviceError && (
          <span className="mono" style={{ fontSize: 10, color: 'var(--neon-hot)' }}>{deviceError}</span>
        )}
      </div>
    </div>
  );
}

function RealLiveSpectrogramPanel({
  deviceId, ring, ribbon, palette, threshold, points,
  recentEvents, ribbonEvents, bandEventId, onBandClick,
  selectedHourTs, onHourClick, hourEvents, hourEventsLoading, hourEventsError,
  selectedEventId, onSelectEvent, onCloseHour,
  onDeleteUnlabeled, deletingUnlabeled,
}: {
  deviceId: string;
  ring: ReturnType<typeof useRollingBands>;
  ribbon: ReturnType<typeof useHistoryRibbon>;
  palette: ReturnType<typeof useTweaks>['spectroColor'];
  threshold: number;
  points: DeviceTelemetryPoint[];
  recentEvents: DeviceEvent[];
  ribbonEvents: EventIndexEntry[];
  bandEventId: string | null;
  onBandClick: (eventId: string) => void;
  selectedHourTs: number | null;
  onHourClick: (hourTs: number) => void;
  hourEvents: DeviceEvent[];
  hourEventsLoading: boolean;
  hourEventsError: string | null;
  selectedEventId: string | null;
  onSelectEvent: (id: string) => void;
  onCloseHour: () => void;
  onDeleteUnlabeled: () => void;
  deletingUnlabeled: boolean;
}) {
  const [showOverlay, setShowOverlay] = useState(true);
  const waiting = !ring.hasData;
  const ribbonWaiting = !ribbon.hasData;
  const windowMin = Math.round((ribbon.displayCols * ribbon.bucketMs) / 1000 / 60);
  const OVERLAY_MIN_DB = 30;
  const OVERLAY_MAX_DB = 140;
  return (
    <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 13, color: 'var(--ink-0)', fontWeight: 500 }}>
            Live spectrogram · ⅓-octave · 20 Hz–16 kHz
          </div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em', marginTop: 2 }}>
            ~{Math.round((ring.maxFrames * 85.33) / 1000)} s window · {ring.nBands} bands · breach ≥ {threshold} dB
          </div>
        </div>
        <div className="mono" style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em', alignItems: 'center' }}>
          <button
            onClick={() => setShowOverlay((v) => !v)}
            title={showOverlay ? 'Hide dB overlay lines' : 'Show dB overlay lines'}
            style={{
              fontSize: 9, fontFamily: 'var(--mono)', letterSpacing: '0.12em',
              textTransform: 'uppercase', padding: '3px 8px',
              background: showOverlay ? 'var(--bg-2)' : 'transparent',
              border: '1px solid var(--line)',
              color: showOverlay ? 'var(--ink-1)' : 'var(--ink-3)',
              borderRadius: 3, cursor: 'pointer',
            }}
          >{showOverlay ? '● dB overlay' : '○ dB overlay'}</button>
          <LineSwatch color={LAEQ_STROKE} label="LAeq" dimmed={!showOverlay} />
          <LineSwatch color={LAFMAX_STROKE} label="LAFmax" dimmed={!showOverlay} />
          <LineSwatch color={LCPEAK_STROKE} label="LCpeak" dimmed={!showOverlay} />
          <span style={{ opacity: 0.6 }}>·</span>
          <span>QUIET → LOUD</span>
          <span style={{
            display: 'inline-block', width: 64, height: 8,
            verticalAlign: 'middle', borderRadius: 2,
            background: paletteCss(palette),
            border: '1px solid var(--line)',
          }} />
        </div>
      </div>
      <div style={{ position: 'relative' }}>
        <LiveSpectrogram
          ring={ring}
          palette={palette}
          height={180}
          minDb={20}
          maxDb={110}
          showFreqAxis
          showGrid
        />
        {showOverlay && (
          <LiveMetricsOverlay
            points={points}
            currentCol={ring.currentCol}
            maxFrames={ring.maxFrames}
            minDb={OVERLAY_MIN_DB}
            maxDb={OVERLAY_MAX_DB}
          />
        )}
        {points.length > 0 && !waiting && (
          <LiveSpectrogramHoverProbe
            points={points}
            currentCol={ring.currentCol}
            maxFrames={ring.maxFrames}
          />
        )}
        {waiting && (
          <div className="mono" style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, letterSpacing: '0.14em', color: 'var(--ink-3)',
            background: 'rgba(0,0,0,0.35)', borderRadius: 4, pointerEvents: 'none',
          }}>
            WAITING FOR SPECTROGRAM FRAMES…
          </div>
        )}
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="mono" style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.12em', marginBottom: 6,
        }}>
          <span>LAST {windowMin} MIN · MAX/BUCKET</span>
          <span>NOW →</span>
        </div>
        <div style={{ position: 'relative' }}>
          <HistorySpectrogram
            ribbon={ribbon}
            palette={palette}
            height={56}
            minDb={20}
            maxDb={110}
          />
          <EventBandsOverlay
            events={recentEvents}
            ribbon={ribbon}
            selectedEventId={selectedEventId}
            bandEventId={bandEventId}
            onClick={onBandClick}
          />
          {ribbonWaiting && (
            <div className="mono" style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, letterSpacing: '0.14em', color: 'var(--ink-3)',
              background: 'rgba(0,0,0,0.35)', borderRadius: 4, pointerEvents: 'none',
            }}>
              LOADING HISTORY…
            </div>
          )}
        </div>
        <div className="mono" style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, 1fr)',
          fontSize: 9, color: 'var(--ink-3)', marginTop: 4,
        }}>
          {Array.from({ length: 6 }).map((_, i) => {
            const minsAgo = windowMin - Math.round((i * windowMin) / 5);
            return (
              <div key={i} style={{ textAlign: i === 0 ? 'left' : i === 5 ? 'right' : 'center' }}>
                {minsAgo === 0 ? 'now' : `-${minsAgo}m`}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="mono" style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.12em', marginBottom: 6,
        }}>
          <span>LAST 24 H · MAX/SEC PER HOUR-TILE · CLICK A TILE TO REPLAY</span>
          <span>NOW →</span>
        </div>
        <HistoryRibbon24h
          deviceId={deviceId}
          palette={palette}
          height={56}
          selectedHourTs={selectedHourTs}
          onHourClick={onHourClick}
          events={ribbonEvents}
        />
        <div className="mono" style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(24, 1fr)',
          fontSize: 9, color: 'var(--ink-3)', marginTop: 4,
        }}>
          {Array.from({ length: 24 }).map((_, i) => {
            const hoursAgo = 23 - i;
            // Label every 4th tick to avoid crowding.
            const show = hoursAgo === 0 || hoursAgo % 4 === 0;
            const d = new Date(Date.now() - hoursAgo * 3600 * 1000);
            const h = d.getHours();
            const hour12 = h % 12 === 0 ? 12 : h % 12;
            const ampm = h < 12 ? 'am' : 'pm';
            return (
              <div key={i} style={{ textAlign: 'center' }}>
                {show ? `${hour12}${ampm}` : ''}
              </div>
            );
          })}
        </div>
      </div>

      {selectedHourTs != null && (
        <HourPlaybackViewer
          hourTs={selectedHourTs}
          threshold={threshold}
          events={hourEvents}
          loading={hourEventsLoading}
          error={hourEventsError}
          selectedId={selectedEventId}
          onSelect={onSelectEvent}
          onClose={onCloseHour}
          onDeleteUnlabeled={onDeleteUnlabeled}
          deletingUnlabeled={deletingUnlabeled}
          deviceId={deviceId}
          palette={palette}
        />
      )}
    </div>
  );
}

// Clickable bands overlaid on the 60-min history ribbon — one per event in
// the visible window. Anchored to the ribbon's bucket grid so the bands slide
// in lockstep with the spectrogram. Events shorter than ~3 buckets render at
// a 4 px minimum so they stay clickable; the selected band glows hot.
function EventBandsOverlay({
  events, ribbon, selectedEventId, bandEventId, onClick,
}: {
  events: DeviceEvent[];
  ribbon: ReturnType<typeof useHistoryRibbon>;
  selectedEventId: string | null;
  bandEventId: string | null;
  onClick: (eventId: string) => void;
}) {
  // Right edge of the ribbon = end of the current bucket; left edge follows
  // from window width. Using the ribbon's own anchor (not Date.now()) keeps
  // bands aligned with the painted columns even between scroll ticks.
  const rightEdgeMs = (ribbon.currentCol + 1) * ribbon.bucketMs;
  const totalMs = ribbon.displayCols * ribbon.bucketMs;
  const leftEdgeMs = rightEdgeMs - totalMs;

  const visible = events.filter((e) => {
    const startMs = e.ts * 1000;
    const endMs = startMs + e.duration_s * 1000;
    return endMs > leftEdgeMs && startMs < rightEdgeMs;
  });
  if (!visible.length) return null;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {visible.map((e) => {
        const startMs = e.ts * 1000;
        const xFrac = Math.max(0, (startMs - leftEdgeMs) / totalMs);
        const widthFrac = Math.min(1 - xFrac, (e.duration_s * 1000) / totalMs);
        const selected = e.event_id === bandEventId || e.event_id === selectedEventId;
        const labeled = e.label != null;
        const ts = new Date(e.ts * 1000);
        const label = `${e.peak_db.toFixed(1)} dB · ${pad2(ts.getHours())}:${pad2(ts.getMinutes())}:${pad2(ts.getSeconds())} · ${e.label ?? e.classification ?? 'unclassified'} · click to play`;
        const baseHue = labeled ? '82% 0.14 160' : '88% 0.16 80';
        return (
          <button
            key={e.event_id}
            type="button"
            onClick={() => onClick(e.event_id)}
            title={label}
            aria-label={label}
            style={{
              position: 'absolute',
              left: `${xFrac * 100}%`,
              width: `max(4px, ${widthFrac * 100}%)`,
              top: -2, bottom: -2,
              padding: 0,
              background: selected
                ? 'oklch(82% 0.18 310 / 0.35)'
                : `oklch(${baseHue} / 0.18)`,
              border: `1px solid ${selected ? 'var(--neon-focus)' : `oklch(${baseHue} / 0.75)`}`,
              borderRadius: 2,
              cursor: 'pointer',
              pointerEvents: 'auto',
              boxShadow: selected
                ? '0 0 8px oklch(82% 0.18 310 / 0.75)'
                : `0 0 4px oklch(${baseHue} / 0.45)`,
            }}
          />
        );
      })}
    </div>
  );
}

// Stroke colors for the three broadband-metric overlay lines. Picked to
// stay legible against every spectrogram palette (heat / ice / mono / neon):
// cool cyan for the average, amber for the fast-RMS max, hot red for the
// true peak — mirrors the visual hierarchy on pro acoustic meters.
const LAEQ_STROKE = 'oklch(85% 0.14 215)';
const LAFMAX_STROKE = 'oklch(88% 0.16 80)';
const LCPEAK_STROKE = 'oklch(72% 0.22 30)';

function LineSwatch({ color, label, dimmed }: { color: string; label: string; dimmed?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, opacity: dimmed ? 0.35 : 1 }}>
      <span style={{
        display: 'inline-block', width: 14, height: 2,
        background: color, borderRadius: 1,
        boxShadow: dimmed ? 'none' : `0 0 4px ${color}`,
      }} />
      <span style={{ color: 'var(--ink-2)' }}>{label}</span>
    </span>
  );
}

/** SVG overlay of LAeq / LAFmax / LCpeak on top of the live spectrogram.
 *
 *  The spectrogram's right edge is locked to ``Date.now() - buffer``; we map
 *  each point's wall-clock ``ts`` to the same column space so the lines slide
 *  in lockstep with the scrolling canvas. Lines break on gaps > 2 s so a
 *  dropped WS doesn't draw a fake "trend" across missing seconds. */
function LiveMetricsOverlay({
  points, currentCol, maxFrames, minDb, maxDb,
}: {
  points: DeviceTelemetryPoint[];
  currentCol: number;
  maxFrames: number;
  minDb: number;
  maxDb: number;
}) {
  const W = 1000;
  const H = 100;
  const rightEdgeMs = currentCol * SPECTROGRAM_COLUMN_MS;
  const totalMs = maxFrames * SPECTROGRAM_COLUMN_MS;
  const leftEdgeMs = rightEdgeMs - totalMs;
  const dbSpan = Math.max(1, maxDb - minDb);

  const xFor = (ts_s: number) => ((ts_s * 1000 - leftEdgeMs) / totalMs) * W;
  const yFor = (db: number) => {
    const v = Math.max(0, Math.min(1, (db - minDb) / dbSpan));
    return (1 - v) * H;
  };

  // Visible window with a small bleed on either side so a path entering or
  // leaving the canvas still draws its connecting segment.
  const bleedMs = 2000;
  const visible: DeviceTelemetryPoint[] = [];
  for (const p of points) {
    const ms = p.ts * 1000;
    if (ms < leftEdgeMs - bleedMs || ms > rightEdgeMs + bleedMs) continue;
    visible.push(p);
  }

  const buildPath = (key: 'laeq' | 'lafmax' | 'lcpeak') => {
    let d = '';
    let lastTs: number | null = null;
    for (const p of visible) {
      const cmd = (lastTs == null || p.ts - lastTs > 2) ? 'M' : 'L';
      d += `${cmd}${xFor(p.ts).toFixed(2)},${yFor(p[key]).toFixed(2)}`;
      lastTs = p.ts;
    }
    return d;
  };

  const ticks = [40, 70, 100, 130];

  return (
    <>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      >
        {ticks.map((db) => {
          const y = yFor(db);
          return (
            <line key={db} x1={0} x2={W} y1={y} y2={y}
              stroke="rgba(255,255,255,0.07)" strokeWidth={1}
              strokeDasharray="2 4"
              vectorEffect="non-scaling-stroke" />
          );
        })}
        {visible.length >= 2 && (
          <>
            <path d={buildPath('laeq')} stroke={LAEQ_STROKE} strokeWidth={1.4}
              fill="none" vectorEffect="non-scaling-stroke" opacity={0.9}
              strokeLinejoin="round" strokeLinecap="round" />
            <path d={buildPath('lafmax')} stroke={LAFMAX_STROKE} strokeWidth={1.2}
              fill="none" vectorEffect="non-scaling-stroke" opacity={0.8}
              strokeLinejoin="round" strokeLinecap="round" />
            <path d={buildPath('lcpeak')} stroke={LCPEAK_STROKE} strokeWidth={1.4}
              fill="none" vectorEffect="non-scaling-stroke" opacity={0.95}
              strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}
      </svg>
      <div style={{
        position: 'absolute', left: 4, top: 0, bottom: 0,
        fontFamily: 'var(--mono)', fontSize: 9, color: 'rgba(255,255,255,0.7)',
        pointerEvents: 'none',
      }}>
        {ticks.map((db) => (
          <span key={db} style={{
            position: 'absolute',
            top: `${(yFor(db) / H) * 100}%`,
            transform: 'translateY(-50%)',
            textShadow: '0 0 4px rgba(0,0,0,0.85)', padding: '0 2px',
          }}>
            {db} dB
          </span>
        ))}
      </div>
    </>
  );
}

/** Transparent capture layer over the live spectrogram. On hover, draws a
 *  vertical line at the cursor and a tooltip showing LAeq/LAFmax/LCpeak from
 *  the nearest telemetry point. Uses the same wall-clock → x mapping as
 *  ``LiveMetricsOverlay`` so the line and the overlay paths stay aligned. */
function LiveSpectrogramHoverProbe({
  points, currentCol, maxFrames,
}: {
  points: DeviceTelemetryPoint[];
  currentCol: number;
  maxFrames: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Only the cursor position lives in state. The nearest point is recomputed
  // on every render so the tooltip refreshes as the spectrogram scrolls under
  // a stationary cursor (parent re-renders at the column-advance cadence).
  const [xFrac, setXFrac] = useState<number | null>(null);

  const rightEdgeMs = currentCol * SPECTROGRAM_COLUMN_MS;
  const totalMs = maxFrames * SPECTROGRAM_COLUMN_MS;
  const leftEdgeMs = rightEdgeMs - totalMs;

  const handleMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setXFrac(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
  };

  let point: DeviceTelemetryPoint | null = null;
  if (xFrac != null && points.length > 0) {
    const targetSec = (leftEdgeMs + xFrac * totalMs) / 1000;
    let bestDiff = Infinity;
    for (const p of points) {
      const diff = Math.abs(p.ts - targetSec);
      if (diff < bestDiff) { bestDiff = diff; point = p; }
    }
    // Hide tooltip if the nearest point is far from the cursor (gap in data).
    if (bestDiff > 3) point = null;
  }

  return (
    <div
      ref={ref}
      onMouseMove={handleMove}
      onMouseLeave={() => setXFrac(null)}
      style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }}
    >
      {xFrac != null && point && (
        <>
          <div style={{
            position: 'absolute',
            left: `${xFrac * 100}%`,
            top: 0, bottom: 0,
            width: 0,
            borderLeft: '1px solid rgba(255,255,255,0.7)',
            boxShadow: '0 0 4px rgba(255,255,255,0.4)',
            pointerEvents: 'none',
          }} />
          <HoverTooltip xFrac={xFrac} point={point} />
        </>
      )}
    </div>
  );
}

function HoverTooltip({ xFrac, point }: { xFrac: number; point: DeviceTelemetryPoint }) {
  const flip = xFrac > 0.7;
  const date = new Date(point.ts * 1000);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  const rows = [
    { label: 'LAeq', value: point.laeq, color: LAEQ_STROKE },
    { label: 'LAFmax', value: point.lafmax, color: LAFMAX_STROKE },
    { label: 'LCpeak', value: point.lcpeak, color: LCPEAK_STROKE },
  ].sort((a, b) => b.value - a.value);
  return (
    <div
      className="mono"
      style={{
        position: 'absolute',
        left: `${xFrac * 100}%`,
        top: 6,
        transform: flip ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)',
        background: 'rgba(8,8,12,0.92)',
        border: '1px solid var(--line)',
        borderRadius: 3,
        padding: '6px 8px',
        fontSize: 10,
        color: 'var(--ink-1)',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
      }}
    >
      <div style={{ fontSize: 9, color: 'var(--ink-3)', letterSpacing: '0.1em', marginBottom: 4 }}>
        {time}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '2px 10px' }}>
        {rows.map((r) => (
          <Fragment key={r.label}>
            <span style={{ color: r.color }}>{r.label}</span>
            <span style={{ textAlign: 'right' }}>{r.value.toFixed(1)} dB</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// Mirrors the inline gradient strings in palettes.ts so the chip in the
// header matches whichever palette the user picked in Settings.
function paletteCss(key: ReturnType<typeof useTweaks>['spectroColor']): string {
  switch (key) {
    case 'heat':
      return 'linear-gradient(90deg, rgb(8,6,14), rgb(48,12,82), rgb(156,30,78), rgb(234,62,40), rgb(252,176,48), rgb(254,240,120))';
    case 'ice':
      return 'linear-gradient(90deg, rgb(6,8,14), rgb(14,48,96), rgb(16,164,220), rgb(164,232,220), rgb(240,252,240))';
    case 'mono':
      return 'linear-gradient(90deg, rgb(10,10,10), rgb(120,120,120), rgb(250,250,246))';
    case 'neon':
      return 'linear-gradient(90deg, rgb(10,6,24), rgb(50,18,120), rgb(220,40,160), rgb(252,220,80), rgb(245,245,220))';
  }
}

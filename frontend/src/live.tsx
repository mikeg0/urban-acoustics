import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  deleteAnnotation,
  deleteEvent,
  fetchDevice,
  fetchEventIndex,
  fetchEventsInRange,
  fetchSpectrogramHistory,
  fetchTelemetry,
  listAnnotations,
  liveDeviceSocket,
  liveSocket,
} from './api';
import { EventsList } from './events/EventsList';
import { EventPlayer } from './events/EventPlayer';
import { HourPlaybackViewer } from './events/HourPlayback';
import { LabelPicker } from './events/LabelPicker';
import { SelectionLabelPopup } from './events/SelectionLabelPopup';
import {
  HistoryRibbon24h,
  HistorySpectrogram,
  LiveSpectrogram,
  SPECTROGRAM_COLUMN_MS,
  useHistoryRibbon,
  useRollingBands,
} from './spectrogram';
import { useTweaks } from './tweaks';
import { formatClock, formatHour, formatHourTick, type TimeFormat } from './utils';
import type {
  DeviceEvent,
  DeviceInfo,
  DeviceLiveMessage,
  DeviceTelemetryPoint,
  EventIndexEntry,
  Gap,
  LiveMessage,
  RecentEntry,
  SpectrogramAnnotation,
} from './types';

/** Format minutes-since-midnight as HH:MM (24h) or h:mm AM/PM (12h). */
const fmtTime = (m: number, format: TimeFormat = '24h') => {
  const h = Math.floor(m / 60) % 24;
  const mm = String(m % 60).padStart(2, '0');
  if (format === '12h') {
    const hh = h % 12 === 0 ? 12 : h % 12;
    const ap = h < 12 ? 'AM' : 'PM';
    return `${hh}:${mm} ${ap}`;
  }
  return `${String(h).padStart(2, '0')}:${mm}`;
};

const pad2 = (n: number) => String(n).padStart(2, '0');

function fmtHourRange(unixSec: number, format: TimeFormat): string {
  return `${formatClock(unixSec, format)} → ${formatClock(unixSec + 3600, format)}`;
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
  const { timeFormat } = useTweaks();
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
        <BigLiveStat label="Today's peak" value={peak.toFixed(1)} unit={`dB · ${fmtTime(peakIdx >= 0 ? peakIdx : 0, timeFormat)}`} tone="hot" />
        <BigLiveStat label="Today's avg" value={mean.toFixed(1)} unit="dB" />
        <BigLiveStat label="Breach minutes" value={String(breaches)} unit={`min ≥ ${threshold} dB`}
          tone={breaches > 0 ? 'warn' : 'default'} />
        <BigLiveStat label="Local time" value={fmtTime(actualNow, timeFormat)} unit={state.date} />
      </div>

      <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <div style={{ fontSize: 13, color: 'var(--ink-0)', fontWeight: 500 }}>
                {selectedHour == null ? 'Current hour · minute-resolution' : `Hour ${formatHour(selectedHour, timeFormat)} · minute-resolution`}
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
                return `${state.date} · ${fmtTime(h * 60, timeFormat)} → ${fmtTime(endMin, timeFormat)} · 60-min canvas`;
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
                  title={`${formatHour(i, timeFormat)} · avg ${h.mean.toFixed(1)} dB · peak ${h.peak.toFixed(1)} · ${(h.coverage * 100).toFixed(0)}% covered${isCurrent ? ' · CURRENT HOUR' : ' · click to view'}`}
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
              <div key={h} style={{ textAlign: 'center', opacity: h % 3 === 0 ? 1 : 0.4 }}>{formatHourTick(h, timeFormat)}</div>
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
  const { timeFormat } = useTweaks();
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
            · last sample {fmtTime(lastStreamMin, timeFormat)} · {Math.max(0, actualNow - lastStreamMin)} min ago
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

export function BigLiveStat({ label, value, unit, tone = 'default', pulse = false }: {
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
  const { timeFormat } = useTweaks();
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
        {fmtTime(start, timeFormat)} → {ongoing ? `${fmtTime(end, timeFormat)} (now)` : fmtTime(end, timeFormat)}
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
  const { timeFormat } = useTweaks();
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
          time={fmtTime(lastStreamMin, timeFormat)}
          pulse={streaming}
        />
      )}
      {!streaming && isLive && nowMin > lastStreamMin && nowMin < hourStart + 60 && (
        <Marker pos={(nowMin - hourStart + 1) / 60} color="var(--ink-2)" label="NOW" time={fmtTime(nowMin, timeFormat)} dashed />
      )}
      <div className="mono" style={{
        display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)',
        fontSize: 9, color: 'var(--ink-3)', marginTop: 4,
      }}>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} style={{ textAlign: i === 0 ? 'left' : i === 11 ? 'right' : 'center' }}>
            {fmtTime(hourStart + i * 5, timeFormat)}
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
  const { spectroColor, timeFormat } = useTweaks();
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
  // Sort direction for the Recent / Hour events list. Hour view defaults to
  // ascending (chronological); recent view defaults to descending (newest
  // first). The auto-default is applied on entry/exit of hour mode below;
  // the user can override either via the toggle in the panel header.
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [deletingUnlabeled, setDeletingUnlabeled] = useState(false);
  // User-drawn spectrogram annotations for the past 24 h. Polled alongside
  // events so the merged Recent-events feed and the overlays on the 4
  // spectrogram surfaces stay in sync. `selectedAnnotationId` mirrors the
  // event selection state so picking a band on any surface highlights the
  // matching row in the events list and vice-versa.
  const [annotations, setAnnotations] = useState<SpectrogramAnnotation[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] =
    useState<number | null>(null);
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

  // Annotations: poll on the same cadence as events. The window mirrors the
  // events feed (past 24 h) so the merged Recent-events list and the overlays
  // on the 4 surfaces all see the same set. Failures are silent — the live
  // ribbon doesn't break because we couldn't fetch a few violet bands.
  const refreshAnnotations = useCallback(async () => {
    try {
      const now = Date.now() / 1000;
      const r = await listAnnotations(deviceId, now - 86400, now);
      setAnnotations(r);
    } catch {
      // ignore
    }
  }, [deviceId]);

  useEffect(() => {
    refreshAnnotations();
    const id = setInterval(refreshAnnotations, EVENT_POLL_MS);
    return () => clearInterval(id);
  }, [refreshAnnotations]);

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
    setSortDir(selectedHourTs != null ? 'asc' : 'desc');
  }, [selectedHourTs]);

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

  // Annotations to surface in whichever events scope the user is looking at.
  // Mirror the events filter: a single-band selection hides them; otherwise
  // show all annotations whose [ts_start, ts_end) overlaps the active window.
  const activeAnnotations = useMemo<SpectrogramAnnotation[]>(() => {
    if (bandEvent) return [];
    if (selectedHourTs != null) {
      const lo = selectedHourTs;
      const hi = selectedHourTs + 3600;
      return annotations.filter((a) => a.ts_end > lo && a.ts_start < hi);
    }
    return annotations;
  }, [annotations, bandEvent, selectedHourTs]);

  // Merge events + annotations into a single Recent-events feed. Sort
  // direction is controlled by `sortDir` (see toggle in the panel header);
  // it defaults to descending in the Recent view and ascending in Hour view.
  const recentEntries = useMemo<RecentEntry[]>(() => {
    const eventEntries: RecentEntry[] = activeEvents.map((e) => ({ kind: 'event', event: e }));
    const annEntries: RecentEntry[] = activeAnnotations.map((a) => ({
      kind: 'annotation', annotation: a,
    }));
    const merged = [...eventEntries, ...annEntries];
    merged.sort((a, b) => {
      const ats = a.kind === 'event' ? a.event.ts : a.annotation.ts_start;
      const bts = b.kind === 'event' ? b.event.ts : b.annotation.ts_start;
      return sortDir === 'asc' ? ats - bts : bts - ats;
    });
    return merged;
  }, [activeEvents, activeAnnotations, sortDir]);

  // Prev/Next walk the events in the same order they're displayed in the
  // Recent-events list (annotations are skipped — they have their own
  // playback surface).
  const [prevEvent, nextEvent] = useMemo(() => {
    if (!selectedEventId) return [null, null] as const;
    const sortedEvents = recentEntries.flatMap((e) => (e.kind === 'event' ? [e.event] : []));
    const i = sortedEvents.findIndex((e) => e.event_id === selectedEventId);
    if (i < 0) return [null, null] as const;
    return [
      i > 0 ? sortedEvents[i - 1] : null,
      i + 1 < sortedEvents.length ? sortedEvents[i + 1] : null,
    ] as const;
  }, [recentEntries, selectedEventId]);

  const selectedAnnotation = useMemo(
    () => annotations.find((a) => a.id === selectedAnnotationId) ?? null,
    [annotations, selectedAnnotationId],
  );

  const handleAnnotationCreated = useCallback((ann: SpectrogramAnnotation) => {
    setAnnotations((prev) => {
      // De-dupe by id (POST returns the persisted row; in-flight refetches
      // could race with us — last write wins on the same id).
      const without = prev.filter((a) => a.id !== ann.id);
      return [ann, ...without];
    });
    // Pull focus onto the new annotation so the user sees the row light up.
    setSelectedAnnotationId(ann.id);
    setSelectedEventId(null);
    setBandEventId(null);
  }, []);

  const handleSelectAnnotation = useCallback((id: number) => {
    setSelectedAnnotationId(id);
    setSelectedEventId(null);
    setBandEventId(null);
  }, []);

  const handleDeleteAnnotation = useCallback(async (id: number) => {
    try {
      await deleteAnnotation(id);
    } catch {
      // Network blip: re-fetch will eventually resync. Leaving the row
      // in place is safer than ghosting it on a failed delete.
      refreshAnnotations();
      return;
    }
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    setSelectedAnnotationId((prev) => (prev === id ? null : prev));
  }, [refreshAnnotations]);

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
        annotations={annotations}
        selectedAnnotationId={selectedAnnotationId}
        onAnnotationCreated={handleAnnotationCreated}
        onSelectAnnotation={handleSelectAnnotation}
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
          setSelectedAnnotationId(null);
        }}
        hourEvents={hourEvents ?? []}
        hourEventsLoading={hourEventsLoading}
        hourEventsError={hourEventsError}
        selectedEventId={selectedEventId}
        onSelectEvent={(id) => {
          setSelectedEventId(id);
          setSelectedAnnotationId(null);
        }}
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
                {(() => {
                  if (bandEvent) {
                    return `Pinned from 60-min timeline · click ✕ to return to ${selectedHourTs != null ? 'hour' : 'recent'} list`;
                  }
                  const eventCount = activeEvents.length;
                  const annCount = activeAnnotations.length;
                  const eventPart = `${eventCount} event${eventCount === 1 ? '' : 's'}`;
                  const annPart = annCount > 0
                    ? ` + ${annCount} annotation${annCount === 1 ? '' : 's'}`
                    : '';
                  const scope = selectedHourTs != null
                    ? ` in ${fmtHourRange(selectedHourTs, timeFormat)}`
                    : '';
                  return `${eventPart}${annPart}${scope} · pick one to play & label`;
                })()}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {!bandEvent && (
                <button
                  type="button"
                  onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                  title={`Sort ${sortDir === 'asc' ? 'ascending (oldest → newest)' : 'descending (newest → oldest)'} · click to flip`}
                  style={{
                    fontSize: 9, fontFamily: 'var(--mono)', letterSpacing: '0.12em',
                    textTransform: 'uppercase', padding: '3px 8px',
                    background: 'var(--bg-2)', border: '1px solid var(--line)',
                    color: 'var(--ink-2)', borderRadius: 3, cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                  }}
                >
                  <span>Sort {sortDir === 'asc' ? 'oldest first' : 'newest first'}</span>
                  <span style={{ color: 'var(--ink-1)' }}>{sortDir === 'asc' ? '↑' : '↓'}</span>
                </button>
              )}
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
            entries={recentEntries}
            selectedEventId={selectedEventId}
            selectedAnnotationId={selectedAnnotationId}
            onSelectEvent={(id) => {
              setSelectedEventId(id);
              setSelectedAnnotationId(null);
            }}
            onSelectAnnotation={handleSelectAnnotation}
            threshold={threshold}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-2)', marginBottom: 8 }}>
              Playback
            </div>
            {selectedAnnotation ? (
              <AnnotationPlayback
                annotation={selectedAnnotation}
                onDelete={() => handleDeleteAnnotation(selectedAnnotation.id)}
              />
            ) : (
              <EventPlayer
                event={selectedEvent}
                onNext={nextEvent ? () => setSelectedEventId(nextEvent.event_id) : undefined}
                onPrev={prevEvent ? () => setSelectedEventId(prevEvent.event_id) : undefined}
                onDeleted={(id) => {
                  setEvents((prev) => prev.filter((e) => e.event_id !== id));
                  setHourEvents((prev) => prev?.filter((e) => e.event_id !== id) ?? null);
                  setSelectedEventId(null);
                  refreshEvents();
                }}
              />
            )}
          </div>
          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-2)', marginBottom: 8 }}>
              Label
            </div>
            {selectedAnnotation ? (
              <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                Annotation labeled <span style={{ color: 'var(--neon-ok)' }}>{selectedAnnotation.label}</span>.
                Delete and re-draw to change the label.
              </div>
            ) : (
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
                  // Advance to the next clip in display order. EventPlayer
                  // honors the clipAutoPlay tweak when a new event is loaded,
                  // so labelling becomes a one-click "label + go".
                  if (nextEvent && nextEvent.event_id !== eventId) {
                    setSelectedEventId(nextEvent.event_id);
                    setSelectedAnnotationId(null);
                    setBandEventId(null);
                  }
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AnnotationPlayback({
  annotation, onDelete,
}: {
  annotation: SpectrogramAnnotation;
  onDelete: () => void;
}) {
  const { timeFormat } = useTweaks();
  const duration = annotation.ts_end - annotation.ts_start;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
        Spectrogram annotation · no audio
      </div>
      <div className="mono" style={{ fontSize: 12, color: 'var(--ink-1)' }}>
        {formatClock(annotation.ts_start, timeFormat, { withSeconds: true })} → {formatClock(annotation.ts_end, timeFormat, { withSeconds: true })} · {duration.toFixed(1)} s ·{' '}
        <span style={{ color: 'var(--neon-ok)' }}>{annotation.label}</span>
      </div>
      <div>
        <button
          type="button"
          onClick={onDelete}
          style={{
            fontSize: 10, fontFamily: 'var(--mono)', letterSpacing: '0.12em',
            textTransform: 'uppercase', padding: '5px 12px',
            background: 'var(--bg-2)',
            border: '1px solid var(--neon-hot)',
            color: 'var(--neon-hot)',
            borderRadius: 4, cursor: 'pointer',
          }}
        >🗑 Delete annotation</button>
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
  annotations, selectedAnnotationId, onAnnotationCreated, onSelectAnnotation,
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
  annotations: SpectrogramAnnotation[];
  selectedAnnotationId: number | null;
  onAnnotationCreated: (ann: SpectrogramAnnotation) => void;
  onSelectAnnotation: (id: number) => void;
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
  const { timeFormat } = useTweaks();
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
        {/* Selection layer (drag-to-create) sits *below* the annotation
            overlay so clicking an existing band selects it instead of
            starting a new drag. The selection layer is full-bleed and
            captures pointer events on empty regions; the annotation
            buttons on top intercept clicks within their bounds. */}
        <LiveEventBandsOverlay
          events={recentEvents}
          currentCol={ring.currentCol}
          maxFrames={ring.maxFrames}
        />
        <LiveSpectrogramSelectionLayer
          deviceId={deviceId}
          ring={ring}
          points={points}
          waiting={waiting}
          onAnnotationCreated={onAnnotationCreated}
        />
        <LiveAnnotationsOverlay
          annotations={annotations}
          currentCol={ring.currentCol}
          maxFrames={ring.maxFrames}
          selectedAnnotationId={selectedAnnotationId}
          onSelect={onSelectAnnotation}
        />
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
          <AnnotationBandsRibbonOverlay
            annotations={annotations}
            ribbon={ribbon}
            selectedAnnotationId={selectedAnnotationId}
            onClick={onSelectAnnotation}
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
          annotations={annotations}
          selectedAnnotationId={selectedAnnotationId}
          onAnnotationClick={onSelectAnnotation}
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
            return (
              <div key={i} style={{ textAlign: 'center' }}>
                {show ? formatHourTick(d.getHours(), timeFormat) : ''}
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
          annotations={annotations}
          selectedAnnotationId={selectedAnnotationId}
          onSelectAnnotation={onSelectAnnotation}
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
  const { timeFormat } = useTweaks();
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
        const label = `${e.peak_db.toFixed(1)} dB · ${formatClock(e.ts, timeFormat, { withSeconds: true })} · ${e.label ?? e.classification ?? 'unclassified'} · click to play`;
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

// --- Annotation overlays ----------------------------------------------------

// Violet hue distinguishes user-drawn annotations from audio-backed event
// bands (green for labeled, amber for unlabeled). The dashed border reads as
// "marked, not captured" — a deliberate visual asymmetry with the solid
// event-band borders.
const ANNOTATION_HUE = '82% 0.16 270';

// Non-interactive overlay marking each triggered noise event as a vertical
// band on the **live spectrogram**. Same time-anchor math as
// ``LiveAnnotationsOverlay`` so bands track the scrolling columns. Uses the
// labeled/unlabeled hue scheme from the 60-min ribbon's EventBandsOverlay for
// visual continuity. ``pointerEvents: 'none'`` keeps drag-to-create
// annotations working through the band region.
function LiveEventBandsOverlay({
  events, currentCol, maxFrames,
}: {
  events: DeviceEvent[];
  currentCol: number;
  maxFrames: number;
}) {
  const rightEdgeMs = currentCol * SPECTROGRAM_COLUMN_MS;
  const totalMs = maxFrames * SPECTROGRAM_COLUMN_MS;
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
        const baseHue = e.label != null ? '82% 0.14 160' : '88% 0.16 80';
        return (
          <div
            key={e.event_id}
            style={{
              position: 'absolute',
              left: `${xFrac * 100}%`,
              width: `max(2px, ${widthFrac * 100}%)`,
              top: 0, bottom: 0,
              background: `oklch(${baseHue} / 0.14)`,
              borderLeft: `1px solid oklch(${baseHue} / 0.85)`,
              borderRight: `1px solid oklch(${baseHue} / 0.85)`,
              boxShadow: `0 0 4px oklch(${baseHue} / 0.45)`,
            }}
          />
        );
      })}
    </div>
  );
}

// Clickable bands overlaid on the **live spectrogram** for each saved
// annotation visible in the rolling window. Time-anchored to ``ring.currentCol``
// so the bands slide in lockstep with the scrolling bands underneath.
function LiveAnnotationsOverlay({
  annotations, currentCol, maxFrames, selectedAnnotationId, onSelect,
}: {
  annotations: SpectrogramAnnotation[];
  currentCol: number;
  maxFrames: number;
  selectedAnnotationId: number | null;
  onSelect: (id: number) => void;
}) {
  const { timeFormat } = useTweaks();
  const rightEdgeMs = currentCol * SPECTROGRAM_COLUMN_MS;
  const totalMs = maxFrames * SPECTROGRAM_COLUMN_MS;
  const leftEdgeMs = rightEdgeMs - totalMs;

  const visible = annotations.filter((a) => {
    const startMs = a.ts_start * 1000;
    const endMs = a.ts_end * 1000;
    return endMs > leftEdgeMs && startMs < rightEdgeMs;
  });
  if (!visible.length) return null;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {visible.map((a) => {
        const startMs = a.ts_start * 1000;
        const endMs = a.ts_end * 1000;
        const xFrac = Math.max(0, (startMs - leftEdgeMs) / totalMs);
        const widthFrac = Math.min(1 - xFrac, (endMs - startMs) / totalMs);
        const selected = a.id === selectedAnnotationId;
        const duration = a.ts_end - a.ts_start;
        const title =
          `${a.label} · ${duration.toFixed(1)} s · ` +
          `${formatClock(a.ts_start, timeFormat, { withSeconds: true })} · click to select`;
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onSelect(a.id)}
            title={title}
            aria-label={title}
            style={{
              position: 'absolute',
              left: `${xFrac * 100}%`,
              width: `max(4px, ${widthFrac * 100}%)`,
              top: 0, bottom: 0,
              padding: 0,
              background: selected
                ? `oklch(${ANNOTATION_HUE} / 0.35)`
                : `oklch(${ANNOTATION_HUE} / 0.20)`,
              border: `1px dashed ${selected ? 'var(--neon-focus)' : `oklch(${ANNOTATION_HUE} / 0.75)`}`,
              borderRadius: 2,
              cursor: 'pointer',
              pointerEvents: 'auto',
              boxShadow: selected
                ? `0 0 8px oklch(${ANNOTATION_HUE} / 0.75)`
                : `0 0 4px oklch(${ANNOTATION_HUE} / 0.35)`,
            }}
          />
        );
      })}
    </div>
  );
}

// Parallel overlay on the **60-min history ribbon**. Mirrors EventBandsOverlay
// math (same right/left edge derivation from the ribbon's bucket grid) so the
// bands track the scrolling spectrogram tick-by-tick.
function AnnotationBandsRibbonOverlay({
  annotations, ribbon, selectedAnnotationId, onClick,
}: {
  annotations: SpectrogramAnnotation[];
  ribbon: ReturnType<typeof useHistoryRibbon>;
  selectedAnnotationId: number | null;
  onClick: (id: number) => void;
}) {
  const { timeFormat } = useTweaks();
  const rightEdgeMs = (ribbon.currentCol + 1) * ribbon.bucketMs;
  const totalMs = ribbon.displayCols * ribbon.bucketMs;
  const leftEdgeMs = rightEdgeMs - totalMs;

  const visible = annotations.filter((a) => {
    const startMs = a.ts_start * 1000;
    const endMs = a.ts_end * 1000;
    return endMs > leftEdgeMs && startMs < rightEdgeMs;
  });
  if (!visible.length) return null;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {visible.map((a) => {
        const startMs = a.ts_start * 1000;
        const endMs = a.ts_end * 1000;
        const xFrac = Math.max(0, (startMs - leftEdgeMs) / totalMs);
        const widthFrac = Math.min(1 - xFrac, (endMs - startMs) / totalMs);
        const selected = a.id === selectedAnnotationId;
        const duration = a.ts_end - a.ts_start;
        const title =
          `${a.label} · ${duration.toFixed(1)} s · ` +
          `${formatClock(a.ts_start, timeFormat, { withSeconds: true })} · click to select`;
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onClick(a.id)}
            title={title}
            aria-label={title}
            style={{
              position: 'absolute',
              left: `${xFrac * 100}%`,
              width: `max(4px, ${widthFrac * 100}%)`,
              top: -2, bottom: -2,
              padding: 0,
              background: selected
                ? `oklch(${ANNOTATION_HUE} / 0.40)`
                : `oklch(${ANNOTATION_HUE} / 0.20)`,
              border: `1px dashed ${selected ? 'var(--neon-focus)' : `oklch(${ANNOTATION_HUE} / 0.75)`}`,
              borderRadius: 2,
              cursor: 'pointer',
              pointerEvents: 'auto',
              boxShadow: selected
                ? `0 0 8px oklch(${ANNOTATION_HUE} / 0.75)`
                : `0 0 4px oklch(${ANNOTATION_HUE} / 0.35)`,
            }}
          />
        );
      })}
    </div>
  );
}

// Drag-to-annotate capture layer over the live spectrogram. Sits *above*
// LiveSpectrogramHoverProbe in z-order; while idle it's pointer-transparent
// (the probe owns hover); while dragging it captures the pointer and draws
// the selection rectangle. The frozen selection + popup live here too so
// the rectangle and dialog stay siblings of the same canvas.
function LiveSpectrogramSelectionLayer({
  deviceId, ring, points, waiting, onAnnotationCreated,
}: {
  deviceId: string;
  ring: ReturnType<typeof useRollingBands>;
  points: DeviceTelemetryPoint[];
  waiting: boolean;
  onAnnotationCreated: (ann: SpectrogramAnnotation) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Drag start is anchored to a *timestamp* — the cell under the cursor at
  // mousedown — so a stationary mouse over a scrolling spectrogram visibly
  // grows the selection (the start drifts leftward with the bands). The
  // current cursor x is tracked in pixel space so the right edge sticks to
  // the cursor wherever it is right now.
  const [drag, setDrag] = useState<{ tsStart: number; mouseX: number } | null>(null);
  // Frozen selection — both ends in timestamps so the visible band keeps
  // sliding with the bands underneath, but the popup's anchor is captured
  // once at mouseup so the dialog itself doesn't migrate as time advances.
  const [selection, setSelection] = useState<{
    tsStart: number;
    tsEnd: number;
    popupLeftPx: number;
    popupWidthPx: number;
  } | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // The hover probe needs to keep working when no drag/selection is active —
  // forward pointer events to it by sitting pointer-transparent at rest.
  const interactive = drag !== null || selection !== null;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Map x-pixel → wall-clock seconds, using the same column math the canvas
  // uses internally. Keeps the selection rectangle anchored to bands as the
  // ring advances.
  const xToTs = useCallback((xPx: number): number => {
    if (containerWidth <= 0) return 0;
    const leftCol = ring.currentCol - ring.maxFrames + 1;
    const colFrac = xPx / containerWidth;
    const col = leftCol + colFrac * (ring.maxFrames - 1);
    return (col * SPECTROGRAM_COLUMN_MS) / 1000;
  }, [containerWidth, ring.currentCol, ring.maxFrames]);

  const tsToX = useCallback((ts: number): number => {
    if (containerWidth <= 0) return 0;
    const leftCol = ring.currentCol - ring.maxFrames + 1;
    const col = (ts * 1000) / SPECTROGRAM_COLUMN_MS;
    const frac = (col - leftCol) / (ring.maxFrames - 1);
    return frac * containerWidth;
  }, [containerWidth, ring.currentCol, ring.maxFrames]);

  // Cancel an in-progress drag or close an open popup on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (drag) setDrag(null);
      else if (selection) setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag, selection]);

  // Auto-close the popup when its selection has scrolled off the left edge.
  useEffect(() => {
    if (!selection) return;
    const leftEdgeTs =
      ((ring.currentCol - ring.maxFrames + 1) * SPECTROGRAM_COLUMN_MS) / 1000;
    if (selection.tsEnd < leftEdgeTs) setSelection(null);
  }, [selection, ring.currentCol, ring.maxFrames]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (waiting) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setDrag({ tsStart: xToTs(x), mouseX: x });
    // Clear any open selection so the next mouseup opens fresh.
    setSelection(null);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!drag) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    setDrag({ ...drag, mouseX: x });
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (!drag) return;
    const el = containerRef.current;
    if (!el) {
      setDrag(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const tsEnd = xToTs(x);
    const tsStart = drag.tsStart;
    setDrag(null);
    // Order endpoints (drags right-to-left are valid; backend wants tsStart < tsEnd).
    const finalStart = Math.min(tsStart, tsEnd);
    const finalEnd = Math.max(tsStart, tsEnd);
    // Skip ultra-short drags (stray clicks). Use the backend's minimum
    // duration so any selection we open the popup for is one the backend
    // will accept.
    if (finalEnd - finalStart < 0.5) return;
    // Freeze the popup's anchor to where the band is *at mouseup time* —
    // the band itself continues to drift, but the dialog stays put.
    const startPx = tsToX(finalStart);
    const endPx = tsToX(finalEnd);
    const popupLeftPx = Math.min(startPx, endPx);
    const popupWidthPx = Math.max(2, Math.abs(endPx - startPx));
    setSelection({
      tsStart: finalStart,
      tsEnd: finalEnd,
      popupLeftPx,
      popupWidthPx,
    });
  };

  const handleMouseLeave = () => {
    if (drag) setDrag(null);
  };

  // Mute the hover-probe cursor while a drag is in progress so it doesn't
  // race with the selection rectangle.
  const cursor = drag ? 'col-resize' : selection ? 'default' : 'crosshair';

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      style={{
        position: 'absolute', inset: 0,
        cursor,
        // The drag layer always captures pointer events. The hover probe sits
        // *inside* this div so its mousemove handler still runs (events
        // bubble up to our handlers), and mousedown on the probe bubbles
        // here to start a drag. While dragging the probe is unrendered to
        // suppress the tooltip from racing the selection rectangle.
        pointerEvents: waiting ? 'none' : 'auto',
        zIndex: 4,
      }}
    >
      {points.length > 0 && !waiting && !interactive && (
        <LiveSpectrogramHoverProbe
          points={points}
          currentCol={ring.currentCol}
          maxFrames={ring.maxFrames}
        />
      )}
      <>
        {drag && containerWidth > 0 && (() => {
          // Left edge: timestamp-anchored — drifts left as the ring advances.
          // Right edge: tracks the live cursor in pixel space.
          const startPx = tsToX(drag.tsStart);
          const left = Math.min(startPx, drag.mouseX);
          const width = Math.abs(drag.mouseX - startPx);
          return (
            <div style={{
              position: 'absolute',
              left,
              width,
              top: 0, bottom: 0,
              background: `oklch(${ANNOTATION_HUE} / 0.22)`,
              border: `1px dashed oklch(${ANNOTATION_HUE} / 0.9)`,
              borderRadius: 2,
              pointerEvents: 'none',
            }} />
          );
        })()}
        {selection && containerWidth > 0 && (() => {
          // Visible band — both ends anchored to timestamps, keeps sliding
          // with the bands so the user can still see which data they marked.
          const leftPx = tsToX(selection.tsStart);
          const widthPx = Math.max(2, tsToX(selection.tsEnd) - leftPx);
          return (
            <>
              <div style={{
                position: 'absolute',
                left: leftPx,
                width: widthPx,
                top: 0, bottom: 0,
                background: `oklch(${ANNOTATION_HUE} / 0.30)`,
                border: '1px dashed var(--neon-focus)',
                borderRadius: 2,
                boxShadow: `0 0 8px oklch(${ANNOTATION_HUE} / 0.6)`,
                pointerEvents: 'none',
              }} />
              {/* Popup uses the FROZEN anchor captured at mouseup, not the
                  drifting band — so the dialog stays at its open position. */}
              <SelectionLabelPopup
                deviceId={deviceId}
                tsStart={selection.tsStart}
                tsEnd={selection.tsEnd}
                anchorLeftPx={selection.popupLeftPx}
                anchorWidthPx={selection.popupWidthPx}
                onSubmitted={(ann) => {
                  setSelection(null);
                  onAnnotationCreated(ann);
                }}
                onCancel={() => setSelection(null)}
              />
            </>
          );
        })()}
      </>
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
  const { timeFormat } = useTweaks();
  const flip = xFrac > 0.7;
  const time = formatClock(point.ts, timeFormat, { withSeconds: true });
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

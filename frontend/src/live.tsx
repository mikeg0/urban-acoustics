import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { fetchDevice, fetchEvents, fetchTelemetry, liveDeviceSocket, liveSocket } from './api';
import { EventsList } from './events/EventsList';
import { EventPlayer } from './events/EventPlayer';
import { LabelPicker } from './events/LabelPicker';
import type {
  DeviceEvent,
  DeviceInfo,
  DeviceLiveMessage,
  DeviceTelemetryPoint,
  Gap,
  LiveMessage,
} from './types';

const fmtTime = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

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

interface RealLiveViewProps {
  deviceId: string;
  threshold: number;
}

export function RealLiveView({ deviceId, threshold }: RealLiveViewProps) {
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [points, setPoints] = useState<DeviceTelemetryPoint[]>([]);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

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

  // Events: poll every 10s.
  const refreshEvents = useCallback(async () => {
    try {
      const r = await fetchEvents(deviceId, 50);
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
        }
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

  const selectedEvent = useMemo(
    () => events.find((e) => e.event_id === selectedEventId) ?? null,
    [events, selectedEventId],
  );

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

      <RealTelemetrySparkline points={points} threshold={threshold} />

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
                Recent events
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-1)', marginTop: 2 }}>
                {events.length} event{events.length === 1 ? '' : 's'} · pick one to play & label
              </div>
            </div>
            {eventsError && (
              <span className="mono" style={{ fontSize: 10, color: 'var(--neon-hot)' }}>
                {eventsError}
              </span>
            )}
          </div>
          <EventsList
            events={events}
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
            <EventPlayer event={selectedEvent} />
          </div>
          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-2)', marginBottom: 8 }}>
              Label
            </div>
            <LabelPicker
              event={selectedEvent}
              onLabelled={() => { refreshEvents(); }}
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
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-1)' }}>
          {device?.name ?? deviceId}
        </span>
        {device?.location && (
          <span className="mono" style={{ fontSize: 11, color: 'var(--ink-2)' }}>
            · {device.location}
          </span>
        )}
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

function RealTelemetrySparkline({
  points, threshold,
}: { points: DeviceTelemetryPoint[]; threshold: number }) {
  const W = 800;
  const H = 140;
  if (!points.length) {
    return (
      <div style={{
        background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8,
        padding: 14, fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--mono)',
      }}>
        No telemetry in the last {Math.round(TELEMETRY_WINDOW_S / 60)} minutes.
      </div>
    );
  }
  // Round axis bounds to 5 dB so gridlines + labels land cleanly. LCpeak can
  // spike well above LAFmax, so clamp the max so a single transient peak
  // doesn't compress the LAeq trace into a thin band at the bottom.
  const laeqVals = points.map((p) => p.laeq);
  const lafmaxVals = points.map((p) => p.lafmax);
  const rawMin = Math.min(...laeqVals, threshold - 10);
  const rawMax = Math.max(...lafmaxVals, threshold + 5);
  const min = Math.floor(rawMin / 5) * 5;
  const max = Math.ceil(rawMax / 5) * 5;
  const range = Math.max(1, max - min);
  const firstTs = points[0].ts;
  const lastTs = points[points.length - 1].ts;
  const span = Math.max(1, lastTs - firstTs);
  const xOf = (ts: number) => ((ts - firstTs) / span) * W;
  const yOf = (v: number) =>
    H - ((Math.max(min, Math.min(max, v)) - min) / range) * (H - 8) - 4;
  const tY = yOf(threshold);

  const laeqLine = points.map((p, i) =>
    `${i === 0 ? 'M' : 'L'}${xOf(p.ts).toFixed(1)},${yOf(p.laeq).toFixed(1)}`,
  ).join(' ');
  const laeqArea = `${laeqLine} L${xOf(lastTs).toFixed(1)},${H} L${xOf(firstTs).toFixed(1)},${H} Z`;
  const lafmaxLine = points.map((p, i) =>
    `${i === 0 ? 'M' : 'L'}${xOf(p.ts).toFixed(1)},${yOf(p.lafmax).toFixed(1)}`,
  ).join(' ');

  // Gradient stops: cool floor → amber band starting threshold-8 → hot at
  // threshold. Stops are expressed as a percentage of the chart height; lower
  // % = higher on screen (SVG y grows downward).
  const stopAt = (v: number) => `${((max - v) / range) * 100}%`;
  const gridLines = Array.from({ length: Math.floor(range / 5) + 1 }, (_, i) => min + i * 5)
    .filter((v) => v > min && v < max);

  return (
    <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 13, color: 'var(--ink-0)', fontWeight: 500 }}>
            Last {Math.round(TELEMETRY_WINDOW_S / 60)} min · LAeq · LAFmax · LCpeak
          </div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em', marginTop: 2 }}>
            {points.length} points · {new Date(firstTs * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}
            {' → '}
            {new Date(lastTs * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}
          </div>
        </div>
        <div className="mono" style={{ display: 'flex', gap: 12, fontSize: 10, color: 'var(--ink-3)' }}>
          <TraceLegend dot="var(--neon-cool)" label="LAeq" />
          <TraceLegend dot="oklch(82% 0.16 70)" label="LAFmax" dashed />
          <TraceLegend dot="oklch(75% 0.22 350)" label="LCpeak" dot3 />
          <TraceLegend dot="var(--neon-hot)" label={`≥ ${threshold}`} dashed />
        </div>
      </div>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
        style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id="laeqAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset={stopAt(max)} stopColor="oklch(72% 0.2 35)" stopOpacity="0.5" />
            <stop offset={stopAt(threshold)} stopColor="oklch(72% 0.2 35)" stopOpacity="0.42" />
            <stop offset={stopAt(threshold - 0.001)} stopColor="oklch(82% 0.16 70)" stopOpacity="0.32" />
            <stop offset={stopAt(threshold - 8)} stopColor="oklch(82% 0.16 70)" stopOpacity="0.22" />
            <stop offset={stopAt(min)} stopColor="oklch(60% 0.14 215)" stopOpacity="0.12" />
          </linearGradient>
        </defs>

        {/* breach-zone wash above threshold */}
        <rect x="0" y="0" width={W} height={Math.max(0, tY)}
          fill="oklch(72% 0.2 35)" fillOpacity="0.05" />

        {/* horizontal gridlines + dB labels */}
        {gridLines.map((v) => (
          <g key={v}>
            <line x1="0" x2={W} y1={yOf(v)} y2={yOf(v)}
              stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            <text x="2" y={yOf(v) - 2}
              fontFamily="var(--mono)" fontSize="9" fill="var(--ink-3)" opacity="0.6">
              {v}
            </text>
          </g>
        ))}

        {/* threshold marker */}
        <line x1="0" x2={W} y1={tY} y2={tY}
          stroke="var(--neon-hot)" strokeDasharray="3 3" strokeWidth="1" opacity="0.7" />

        {/* LCpeak transients — dots only, often well above LAFmax */}
        {points.map((p, i) => (
          <circle key={`pk-${i}`} cx={xOf(p.ts)} cy={yOf(p.lcpeak)}
            r="1.4" fill="oklch(75% 0.22 350)" opacity="0.65" />
        ))}

        {/* LAeq filled area */}
        <path d={laeqArea} fill="url(#laeqAreaGrad)" />

        {/* LAFmax dashed overlay */}
        <path d={lafmaxLine} fill="none"
          stroke="oklch(82% 0.16 70)" strokeWidth="1" strokeDasharray="2 2" opacity="0.75" />

        {/* LAeq line — primary trace */}
        <path d={laeqLine} fill="none" stroke="var(--neon-cool)" strokeWidth="1.6" />

        {/* Breach LAeq points */}
        {points.map((p, i) => {
          if (p.laeq < threshold) return null;
          return <circle key={`br-${i}`} cx={xOf(p.ts)} cy={yOf(p.laeq)}
            r="2.5" fill="var(--neon-hot)" />;
        })}
      </svg>
    </div>
  );
}

function TraceLegend({ dot, label, dashed, dot3 }: {
  dot: string; label: string; dashed?: boolean; dot3?: boolean;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      {dot3 ? (
        <span style={{ display: 'inline-flex', gap: 2 }}>
          <span style={{ width: 3, height: 3, borderRadius: 2, background: dot }} />
          <span style={{ width: 3, height: 3, borderRadius: 2, background: dot }} />
          <span style={{ width: 3, height: 3, borderRadius: 2, background: dot }} />
        </span>
      ) : (
        <span style={{
          width: 16, height: 0,
          borderTop: `${dashed ? '1.5px dashed' : '2px solid'} ${dot}`,
        }} />
      )}
      <span style={{ color: 'var(--ink-2)' }}>{label}</span>
    </span>
  );
}

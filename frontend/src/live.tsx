import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { liveSocket } from './api';
import type { Gap, LiveMessage } from './types';

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

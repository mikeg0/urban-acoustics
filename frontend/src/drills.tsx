import { useEffect, useMemo, useState } from 'react';
import { Sparkline } from './atoms';
import { dbColor, type PaletteKey } from './palettes';
import { RealHourTile, SpectrogramCanvas, buildSpectrogram } from './spectrogram';
import { useTweaks } from './tweaks';
import { formatHourRange, formatHourTick, mulberry32, normDb } from './utils';
import { WavPlayer } from './wavplayer';
import type { Day, MonthHydrated } from './types';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// ---- YEAR heatmap: 7×53 grid of days colored by mean dB ----
export function YearHeatmap({
  days, threshold, onPickDay, selectedDay,
}: {
  days: Day[];
  threshold: number;
  onPickDay?: (d: Day) => void;
  selectedDay?: string | null;
}) {
  if (days.length === 0) {
    return (
      <div className="mono" style={{
        padding: '24px 0', color: 'var(--ink-3)', fontSize: 11,
        letterSpacing: '0.1em', textTransform: 'uppercase',
      }}>
        No history yet — waiting for the first day of telemetry to land.
      </div>
    );
  }
  const start = new Date(days[0].date + 'T00:00:00');
  const startDow = start.getDay();
  const first = new Date(start);
  first.setDate(first.getDate() - startDow);

  const weeks = 53;
  const cellW = 14, cellH = 14, gap = 2;
  const rowLabelW = 20, colLabelH = 14;
  const w = rowLabelW + weeks * (cellW + gap);
  const h = colLabelH + 7 * (cellH + gap);

  const byKey = new Map<string, Day>(days.map((d) => [d.key, d]));

  const colorFor = (db: number | null) => {
    if (db == null) return 'transparent';
    if (db >= threshold) return 'oklch(72% 0.2 35)';
    if (db >= threshold - 5) return 'oklch(82% 0.18 70)';
    if (db >= threshold - 10) return 'oklch(86% 0.16 95)';
    const t = Math.max(0, Math.min(1, (db - 50) / (threshold - 10 - 50)));
    const L = 32 + t * 45;
    const C = 0.04 + t * 0.11;
    const H = 210 - t * 20;
    return `oklch(${L}% ${C.toFixed(3)} ${H.toFixed(1)})`;
  };

  const monthAnchors: { col: number; label: string }[] = [];
  for (let c = 0; c < weeks; c++) {
    const cellDate = new Date(first);
    cellDate.setDate(cellDate.getDate() + c * 7);
    if (cellDate.getFullYear() === start.getFullYear() && cellDate.getDate() <= 7) {
      monthAnchors.push({ col: c, label: MONTH_LABELS[cellDate.getMonth()].toUpperCase() });
    }
  }

  const rows = [1, 3, 5];

  return (
    <div style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line)',
      borderRadius: 8,
      padding: '14px 16px 12px',
      marginTop: 14,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
          Year heat · daily mean dB · {days.length} days
        </div>
        <div className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 10, color: 'var(--ink-3)' }}>
          <span>quiet</span>
          <span style={{ display: 'inline-flex', gap: 2 }}>
            {[48, 56, 64, 70, 75, 80, 85].map((db) => (
              <span key={db} title={`${db} dB`} style={{ width: 10, height: 10, background: colorFor(db), borderRadius: 1 }} />
            ))}
          </span>
          <span>loud</span>
          <span style={{ width: 10, height: 10, background: 'oklch(72% 0.2 35)', borderRadius: 1, marginLeft: 6 }} />
          <span>≥ {threshold} dB</span>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <svg width={w} height={h} style={{ display: 'block' }}>
          {monthAnchors.map((m) => (
            <text
              key={m.col}
              x={rowLabelW + m.col * (cellW + gap)}
              y={10}
              fontSize="9"
              fontFamily="ui-monospace, monospace"
              fill="var(--ink-3)"
              letterSpacing="0.08em"
            >{m.label}</text>
          ))}
          {rows.map((r) => (
            <text
              key={r}
              x={0}
              y={colLabelH + r * (cellH + gap) + cellH - 3}
              fontSize="9"
              fontFamily="ui-monospace, monospace"
              fill="var(--ink-3)"
            >{DOW_LABELS[r]}</text>
          ))}
          {Array.from({ length: weeks }).map((_, c) =>
            Array.from({ length: 7 }).map((__, r) => {
              const cellDate = new Date(first);
              cellDate.setDate(cellDate.getDate() + c * 7 + r);
              if (cellDate.getFullYear() !== start.getFullYear()) return null;
              const key = cellDate.toISOString().slice(0, 10);
              const d = byKey.get(key);
              if (!d) return null;
              const isSel = selectedDay === d.key;
              const x = rowLabelW + c * (cellW + gap);
              const y = colLabelH + r * (cellH + gap);
              return (
                <g key={key}>
                  <rect
                    x={x} y={y}
                    width={cellW} height={cellH}
                    rx={1}
                    fill={colorFor(d.mean)}
                    stroke={isSel ? 'var(--neon-focus)' : 'transparent'}
                    strokeWidth={isSel ? 1.5 : 0}
                    shapeRendering="crispEdges"
                    style={{ cursor: onPickDay ? 'pointer' : 'default' }}
                    onClick={() => onPickDay?.(d)}
                  >
                    <title>{`${d.key} · ${d.mean} dB avg · peak ${d.peak} · ${d.breaches} breach${d.breaches !== 1 ? 'es' : ''}${d.event ? ` · ${d.event}` : ''}`}</title>
                  </rect>
                  {d.breaches > 0 && !isSel && (
                    <rect x={x - 0.5} y={y - 0.5} width={cellW + 1} height={cellH + 1} rx={1.5}
                      fill="none" stroke="oklch(95% 0.02 85)" strokeWidth={1} opacity={0.85} pointerEvents="none" />
                  )}
                </g>
              );
            })
          )}
        </svg>
      </div>
    </div>
  );
}

// ---- YEAR view: 12 month cards with breach dots + sparkline ----
export function YearView({
  months, threshold, onPick, selectedMonth,
}: {
  months: MonthHydrated[];
  threshold: number;
  onPick: (m: number) => void;
  selectedMonth?: number | null;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
      {months.map((m) => {
        const isSel = selectedMonth === m.index;
        return (
          <div
            key={m.index}
            onClick={() => onPick(m.index)}
            style={{
              background: isSel ? 'var(--bg-2)' : 'var(--bg-1)',
              border: `1px solid ${isSel ? 'var(--neon-focus)' : 'var(--line)'}`,
              borderRadius: 8,
              padding: 12,
              cursor: 'pointer',
              transition: 'all 120ms',
              minWidth: 0,
              overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={{ fontSize: 12, color: 'var(--ink-2)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>{m.short}</div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
                {m.days[m.days.length - 1]?.date.slice(0, 4) ?? ''}
              </div>
            </div>
            <div className="mono" style={{ fontSize: 22, marginTop: 6, color: 'var(--ink-0)', letterSpacing: '-0.02em' }}>
              {m.mean.toFixed(1)}
              <span style={{ fontSize: 10, color: 'var(--ink-3)', marginLeft: 3 }}>dB avg</span>
            </div>
            <div style={{ marginTop: 8 }}>
              <Sparkline values={m.days.map((d) => d.mean)} threshold={threshold} width={180} height={26}
                palette={m.breaches > 15 ? 'hot' : 'cool'} responsive />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
                peak <span style={{ color: 'var(--neon-hot)' }}>{m.peak.toFixed(1)}</span>
              </div>
              <div className="mono" style={{ fontSize: 10, color: m.breaches > 0 ? 'var(--neon-hot)' : 'var(--ink-3)' }}>
                {m.breaches} breach{m.breaches !== 1 ? 'es' : ''}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- MONTH view: calendar grid with day cells colored by breach intensity ----
export function MonthView({
  month, months, threshold, onPick, onPickMonth, selectedDay,
}: {
  month: MonthHydrated;
  /** All hydrated months in the current dataset — drives the JAN…DEC tab strip
   *  so the user can pivot without bouncing back to the year view. */
  months?: MonthHydrated[];
  threshold: number;
  onPick: (d: Day) => void;
  onPickMonth?: (m: number) => void;
  selectedDay?: string | null;
}) {
  // `month.days` can span multiple years (the rolling 365-day window puts e.g.
  // May 2025 + May 2026 into the same month-of-year bucket). Pick the most
  // recent year present so the calendar grid is unambiguous, and filter days
  // to that year for the lookup.
  const years = month.days.map((d) => Number(d.date.slice(0, 4)));
  const monthYear = years.length ? Math.max(...years) : new Date().getFullYear();
  const yearDays = month.days.filter((d) => d.date.startsWith(String(monthYear)));
  const byDayNum = new Map<number, Day>(
    yearDays.map((d) => [Number(d.date.slice(8, 10)), d]),
  );

  const firstDow = new Date(monthYear, month.index, 1).getDay();
  const daysInMonth = new Date(monthYear, month.index + 1, 0).getDate();

  type Cell = { kind: 'pad' } | { kind: 'data'; day: Day } | { kind: 'empty'; dayNum: number };
  const cells: Cell[] = [];
  for (let i = 0; i < firstDow; i++) cells.push({ kind: 'pad' });
  for (let n = 1; n <= daysInMonth; n++) {
    const d = byDayNum.get(n);
    cells.push(d ? { kind: 'data', day: d } : { kind: 'empty', dayNum: n });
  }
  while (cells.length % 7 !== 0) cells.push({ kind: 'pad' });

  const availableMonths = new Set((months ?? []).map((m) => m.index));

  return (
    <div>
      <div className="mono" style={{
        fontSize: 11, color: 'var(--ink-2)', letterSpacing: '0.08em',
        marginBottom: 8,
      }}>
        {MONTH_LABELS[month.index]} {monthYear}
      </div>
      {onPickMonth && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 4,
          marginBottom: 12,
        }}>
          {MONTH_LABELS.map((lbl, i) => {
            const active = i === month.index;
            const hasData = availableMonths.has(i);
            return (
              <button
                key={i}
                onClick={() => hasData && onPickMonth(i)}
                disabled={!hasData}
                title={hasData ? `${lbl}` : `${lbl} · no data`}
                style={{
                  padding: '5px 0',
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  background: active ? 'var(--neon-focus)' : 'var(--bg-2)',
                  color: active ? '#0a0a0a' : hasData ? 'var(--ink-1)' : 'var(--ink-3)',
                  border: `1px solid ${active ? 'var(--neon-focus)' : 'var(--line)'}`,
                  borderRadius: 4,
                  cursor: hasData && !active ? 'pointer' : 'default',
                  opacity: hasData ? 1 : 0.4,
                  transition: 'all 120ms',
                }}
              >
                {lbl.toUpperCase()}
              </button>
            );
          })}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 6 }}>
        {DOW_LABELS.map((d, i) => (
          <div key={i} className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', textAlign: 'center' }}>{d}</div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((c, i) => {
          if (c.kind === 'pad') return <div key={i} style={{ aspectRatio: '1 / 1' }} />;
          if (c.kind === 'empty') {
            return (
              <div
                key={i}
                title={`${monthYear}-${String(month.index + 1).padStart(2, '0')}-${String(c.dayNum).padStart(2, '0')} · no data`}
                style={{
                  aspectRatio: '1 / 1',
                  background: 'var(--bg-1)',
                  border: '1px dashed var(--line)',
                  borderRadius: 4,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  padding: 4,
                  opacity: 0.55,
                }}
              >
                <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', fontWeight: 500 }}>
                  {c.dayNum}
                </div>
                <div className="mono" style={{ fontSize: 8, color: 'var(--ink-3)', textAlign: 'right', letterSpacing: '0.08em' }}>
                  —
                </div>
              </div>
            );
          }
          const d = c.day;
          const isSel = selectedDay === d.key;
          const color = dbColor(d.peak, threshold);
          const dayDate = new Date(d.date + 'T00:00:00');
          return (
            <div
              key={i}
              onClick={() => onPick(d)}
              style={{
                aspectRatio: '1 / 1',
                background: d.breaches > 0 ? color : 'var(--bg-2)',
                border: `1.5px solid ${isSel ? 'var(--neon-focus)' : 'transparent'}`,
                borderRadius: 4,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: 4,
                cursor: 'pointer',
                position: 'relative',
              }}
              title={`${d.key} · peak ${d.peak} dB · ${d.breaches} breaches`}
            >
              <div className="mono" style={{ fontSize: 10, color: d.breaches > 0 ? '#0a0a0a' : 'var(--ink-2)', fontWeight: 500 }}>
                {dayDate.getDate()}
              </div>
              <div className="mono" style={{ fontSize: 9, color: d.breaches > 0 ? 'rgba(0,0,0,0.7)' : 'var(--ink-3)', textAlign: 'right' }}>
                {d.mean.toFixed(0)}
              </div>
              {d.event && <div style={{ position: 'absolute', top: 2, right: 2, width: 4, height: 4, borderRadius: 2, background: 'var(--neon-focus)' }} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- DAY view: 24 hour bars ----
export function DayView({
  day, threshold, onPickHour, selectedHour,
}: {
  day: Day;
  threshold: number;
  onPickHour: (h: number) => void;
  selectedHour?: number | null;
}) {
  const { timeFormat } = useTweaks();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'flex-end', height: 120, gap: 2 }}>
          {day.hours.map((db, h) => {
            const pct = (db - 30) / 75;
            const isSel = selectedHour === h;
            const isBreach = db >= threshold;
            return (
              <div key={h} style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
                onClick={() => onPickHour(h)}
              >
                <div style={{
                  width: '100%',
                  height: `${Math.max(4, pct * 100)}%`,
                  background: isBreach ? 'var(--neon-hot)' : db >= threshold - 8 ? 'var(--neon-warn)' : 'var(--bg-3)',
                  outline: isSel ? '1.5px solid var(--neon-focus)' : 'none',
                  outlineOffset: 1,
                  borderRadius: '2px 2px 0 0',
                  cursor: 'pointer',
                  transition: 'all 150ms',
                }} />
              </div>
            );
          })}
        </div>
        <div className="mono" style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', fontSize: 9, color: 'var(--ink-3)', marginTop: 4 }}>
          {Array.from({ length: 24 }).map((_, h) => (
            <div key={h} style={{ textAlign: 'center', opacity: h % 3 === 0 ? 1 : 0.35 }}>{formatHourTick(h, timeFormat)}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- HOUR view: zoomed spectrogram for a single hour ----
const SOURCE_DEFS = [
  { key: 'moto',  label: 'Motorcycles / modified muffler', short: 'MOTO',   color: 'oklch(78% 0.18 35)' },
  { key: 'car',   label: 'Cars / modified muffler',        short: 'CAR',    color: 'oklch(70% 0.12 230)' },
  { key: 'cons',  label: 'Construction / transient',       short: 'CONSTR', color: 'oklch(75% 0.14 60)' },
  { key: 'siren', label: 'Sirens / transient',             short: 'SIREN',  color: 'oklch(78% 0.16 310)' },
  { key: 'amb',   label: 'Weather / ambient',              short: 'AMB',    color: 'oklch(60% 0.04 180)' },
] as const;

type SourceKey = typeof SOURCE_DEFS[number]['key'];

interface SegInfo { i: number; db: number; src: SourceKey }

function classifySegments(day: Day, hour: number): SegInfo[] {
  const rng = mulberry32((day.key.charCodeAt(4) * 53 + hour * 919) | 0);
  const baseDb = day.hours[hour];
  return Array.from({ length: 12 }, (_, i) => {
    const wobble = (rng() - 0.5) * 3;
    const db = Math.max(40, Math.min(108, baseDb + wobble));
    const r = rng();
    let src: SourceKey;
    if (db >= 88) src = r < 0.55 ? 'moto' : r < 0.8 ? 'car' : 'siren';
    else if (db >= 80) src = r < 0.5 ? 'car' : r < 0.75 ? 'moto' : r < 0.9 ? 'cons' : 'siren';
    else if (db >= 68) src = r < 0.5 ? 'car' : r < 0.8 ? 'cons' : 'amb';
    else src = r < 0.7 ? 'amb' : 'car';
    return { i, db: +db.toFixed(1), src };
  });
}

export function HourView({
  day, hour, palette, threshold, deviceId = null,
}: {
  day: Day;
  hour: number;
  palette: PaletteKey;
  threshold: number;
  /** Real-device mode: render the hour's historical tile from the backend
   *  instead of the seeded buildSpectrogram preview. */
  deviceId?: string | null;
}) {
  const data = useMemo(() => {
    const seed = (day.key.charCodeAt(4) * 31 + hour * 2731 + day.hours[hour] * 100) | 0;
    return buildSpectrogram(seed, 0.7 + normDb(day.hours[hour]) * 1.1);
  }, [day.key, hour]);

  const segments = useMemo(() => classifySegments(day, hour), [day.key, hour]);

  const defaultSeg = useMemo(() => {
    const seed = (day.key.charCodeAt(4) * 31 + hour * 2731 + day.hours[hour] * 100) | 0;
    return ((seed >>> 0) % 12);
  }, [day.key, hour]);

  const [segIndex, setSegIndex] = useState(defaultSeg);
  const [hoverSeg, setHoverSeg] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playProgress, setPlayProgress] = useState(0);
  useEffect(() => { setSegIndex(defaultSeg); }, [defaultSeg]);

  const { timeFormat } = useTweaks();
  const hourLabelStr = (h: number) => formatHourRange(h, timeFormat);
  const segLeftPct = (segIndex / 12) * 100;
  const segWidthPct = 100 / 12;
  const byKey = Object.fromEntries(SOURCE_DEFS.map((s) => [s.key, s])) as Record<SourceKey, typeof SOURCE_DEFS[number]>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div className="mono" style={{
          display: 'flex', justifyContent: 'space-between',
          fontSize: 9, color: 'var(--ink-3)',
          letterSpacing: '0.12em', textTransform: 'uppercase',
          marginBottom: 4,
        }}>
          <span>Probable source · per 5-min slice</span>
          <span style={{ display: 'inline-flex', gap: 10 }}>
            {SOURCE_DEFS.map((s) => (
              <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 6, height: 6, background: s.color, borderRadius: 1 }} />
                <span style={{ color: 'var(--ink-2)' }}>{s.short}</span>
              </span>
            ))}
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 2, height: 16 }}>
          {segments.map((s) => {
            const sd = byKey[s.src];
            const active = s.i === segIndex;
            return (
              <div
                key={s.i}
                onClick={() => setSegIndex(s.i)}
                title={`${String(hour).padStart(2, '0')}:${String(s.i * 5).padStart(2, '0')}–${String((s.i + 1) * 5).padStart(2, '0')} · ${sd.label} · ${s.db} dB`}
                style={{
                  background: sd.color,
                  opacity: active ? 1 : 0.75,
                  cursor: 'pointer',
                  borderRadius: 2,
                  outline: active ? '1.5px solid var(--neon-focus)' : 'none',
                  outlineOffset: 1,
                  transition: 'opacity 120ms',
                }}
              />
            );
          })}
        </div>
      </div>

      <div
        style={{ position: 'relative', cursor: 'crosshair' }}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          const x = (e.clientX - rect.left) / rect.width;
          const s = Math.max(0, Math.min(11, Math.floor(x * 12)));
          setHoverSeg(s);
        }}
        onMouseLeave={() => setHoverSeg(null)}
        onClick={() => hoverSeg != null && setSegIndex(hoverSeg)}
      >
        {deviceId
          ? <RealHourTile deviceId={deviceId} dayKey={day.key} hour={hour} palette={palette} height={220} />
          : <SpectrogramCanvas data={data} palette={palette} height={220} />}
        {hoverSeg != null && hoverSeg !== segIndex && (
          <div style={{
            position: 'absolute',
            left: `${(hoverSeg / 12) * 100}%`,
            top: 0, bottom: 0,
            width: `${100 / 12}%`,
            background: 'rgba(255,255,255,0.08)',
            borderLeft: '1px solid rgba(255,255,255,0.35)',
            borderRight: '1px solid rgba(255,255,255,0.35)',
            pointerEvents: 'none',
          }} />
        )}
        <div style={{
          position: 'absolute',
          left: `${segLeftPct}%`,
          top: 0,
          bottom: 0,
          width: `${segWidthPct}%`,
          pointerEvents: 'none',
          border: '1.5px solid var(--neon-focus)',
          boxShadow: '0 0 0 9999px rgba(4, 4, 6, 0.55)',
          clipPath: 'inset(0)',
          borderRadius: 2,
          transition: 'left 180ms cubic-bezier(.2,.8,.2,1)',
        }}>
          {playing && (
            <div style={{
              position: 'absolute',
              left: `${playProgress * 100}%`,
              top: -4, bottom: -4,
              width: 2,
              background: 'var(--neon-focus)',
              boxShadow: '0 0 6px var(--neon-focus)',
            }} />
          )}
          <div className="mono" style={{
            position: 'absolute',
            top: -18,
            left: 0,
            fontSize: 9,
            color: 'var(--neon-focus)',
            letterSpacing: '0.1em',
            whiteSpace: 'nowrap',
          }}>
            ◆ SEG {String(segIndex + 1).padStart(2, '0')}/12 · {byKey[segments[segIndex].src].short} · {String(segIndex * 5).padStart(2, '0')}:00–{String((segIndex + 1) * 5).padStart(2, '0')}:00
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }} className="mono">
        <span style={{ fontSize: 9, color: 'var(--ink-3)' }}>20 Hz</span>
        <span style={{ fontSize: 9, color: 'var(--ink-3)' }}>60 min window · {hourLabelStr(hour)}</span>
        <span style={{ fontSize: 9, color: 'var(--ink-3)' }}>20 kHz</span>
      </div>
      <WavPlayer
        day={day}
        hour={hour}
        threshold={threshold}
        segIndex={segIndex}
        onSegIndex={setSegIndex}
        onPlayingChange={setPlaying}
        onProgressChange={setPlayProgress}
      />
    </div>
  );
}

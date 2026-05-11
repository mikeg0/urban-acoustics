import { Pill } from './atoms';
import type { Anomaly, Day, ForecastPoint, Source } from './types';

const SEV_LABEL = (z: number) => z >= 4 ? 'CRITICAL' : z >= 3 ? 'HIGH' : z >= 2.6 ? 'ELEVATED' : 'NOTABLE';
const SEV_TONE = (z: number): 'hot' | 'warn' | 'cool' => z >= 3 ? 'hot' : z >= 2.6 ? 'warn' : 'cool';

const hourLabel = (h: number) => {
  const ap = h < 12 ? 'AM' : 'PM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:00 ${ap}`;
};

export function AnomaliesFeed({
  anomalies,
  onSelect,
  sensitivity = 2.3,
  focusKey,
}: {
  anomalies: Anomaly[];
  onSelect?: (a: Anomaly) => void;
  sensitivity?: number;
  focusKey?: string | null;
}) {
  const filtered = anomalies.filter((a) => a.z >= sensitivity).slice(0, 40);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, flex: 1, minHeight: 0, overflow: 'auto' }}>
      {filtered.map((a, i) => {
        const isFocus = focusKey === a.key;
        const date = new Date(a.date + 'T00:00:00');
        return (
          <div
            key={a.key + i}
            onClick={() => onSelect?.(a)}
            style={{
              padding: '10px 0',
              borderBottom: '1px solid var(--line)',
              display: 'grid',
              gridTemplateColumns: '72px 88px 1fr auto',
              gap: 12,
              alignItems: 'center',
              cursor: 'pointer',
              background: isFocus ? 'oklch(22% 0.03 310)' : 'transparent',
              borderLeft: isFocus ? '2px solid var(--neon-focus)' : '2px solid transparent',
              paddingLeft: 10,
              marginLeft: -12,
              marginRight: -12,
              paddingRight: 12,
            }}
          >
            <div>
              <Pill tone={SEV_TONE(a.z)} icon>{SEV_LABEL(a.z)}</Pill>
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-2)' }}>
              {date.toLocaleDateString('en-US', { month: 'short', day: '2-digit' })}<br />
              <span style={{ color: 'var(--ink-3)' }}>{hourLabel(a.hour)}</span>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, color: 'var(--ink-0)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.event || `Unexplained spike · ${a.db.toFixed(1)} dB`}
              </div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>
                z = {a.z.toFixed(2)}  ·  +{(a.z * 3.2).toFixed(1)} dB vs baseline
              </div>
            </div>
            <div className="mono" style={{
              fontSize: 22,
              color: a.z >= 3 ? 'var(--neon-hot)' : 'var(--ink-0)',
              fontWeight: 500,
              letterSpacing: '-0.02em',
            }}>
              {a.db.toFixed(1)}
              <span style={{ fontSize: 10, color: 'var(--ink-3)', marginLeft: 3 }}>dB</span>
            </div>
          </div>
        );
      })}
      {filtered.length === 0 && (
        <div style={{ padding: 20, color: 'var(--ink-3)', fontSize: 12 }}>
          No anomalies at sensitivity z ≥ {sensitivity.toFixed(1)}
        </div>
      )}
    </div>
  );
}

export function BreachRibbon({ days, threshold }: { days: Day[]; threshold: number }) {
  const maxBreaches = Math.max(...days.map((d) => d.breaches), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.12em' }}>
        365 DAYS · Intensity of ≥{threshold} dB hours
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${days.length}, 1fr)`, gap: 1, height: 36 }}>
        {days.map((d, i) => {
          const v = d.breaches / maxBreaches;
          return (
            <div
              key={i}
              title={`${d.key} · ${d.breaches} breaches · peak ${d.peak} dB`}
              style={{
                background: d.breaches === 0
                  ? 'var(--bg-2)'
                  : `oklch(${55 + v * 25}% ${0.05 + v * 0.15} ${50 - v * 20})`,
                borderRadius: 1,
              }}
            />
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--ink-3)' }} className="mono">
        <span>JAN</span><span>MAR</span><span>MAY</span><span>JUL</span><span>SEP</span><span>NOV</span>
      </div>
    </div>
  );
}

export function PeakHoursChart({ hours }: { hours: number[] }) {
  const max = Math.max(...hours);
  const peakHour = hours.indexOf(max);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', height: 100, gap: 2 }}>
        {hours.map((v, h) => {
          const pct = (v - 30) / 60;
          const isPeak = h === peakHour;
          return (
            <div key={h} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' }}>
              <div style={{
                width: '100%',
                height: `${pct * 100}%`,
                background: isPeak ? 'var(--neon-hot)' : v >= 75 ? 'var(--neon-warn)' : 'var(--bg-3)',
                borderRadius: '2px 2px 0 0',
                transition: 'height 300ms',
              }} />
            </div>
          );
        })}
      </div>
      <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--ink-3)', marginTop: 4 }}>
        {[0, 6, 12, 18, 23].map((h) => <span key={h}>{String(h).padStart(2, '0')}:00</span>)}
      </div>
    </div>
  );
}

export function ForecastPanel({ forecast, threshold }: { forecast: ForecastPoint[]; threshold: number }) {
  const max = Math.max(...forecast.map((f) => f.high));
  const min = Math.min(...forecast.map((f) => f.low));
  const w = 100, h = 80;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <svg viewBox={`0 0 ${w * forecast.length} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: 80 }}>
        <path
          d={
            'M ' + forecast.map((f, i) => {
              const x = i * w + w / 2;
              const y = h - ((f.high - min) / (max - min)) * h;
              return `${x},${y}`;
            }).join(' L ') +
            ' L ' + forecast.map((_, i) => {
              const x = (forecast.length - 1 - i) * w + w / 2;
              const f2 = forecast[forecast.length - 1 - i];
              const y = h - ((f2.low - min) / (max - min)) * h;
              return `${x},${y}`;
            }).join(' L ') + ' Z'
          }
          fill="oklch(75% 0.14 230 / 0.15)"
        />
        <polyline
          fill="none"
          stroke="var(--neon-cool)"
          strokeWidth="1.5"
          points={forecast.map((f, i) => {
            const x = i * w + w / 2;
            const y = h - ((f.mean - min) / (max - min)) * h;
            return `${x},${y}`;
          }).join(' ')}
        />
        {threshold >= min && threshold <= max && (() => {
          const y = h - ((threshold - min) / (max - min)) * h;
          return <line x1="0" x2={w * forecast.length} y1={y} y2={y} stroke="var(--neon-hot)" strokeDasharray="4 4" strokeWidth="1" opacity="0.5" />;
        })()}
        {forecast.map((f, i) => {
          const x = i * w + w / 2;
          const y = h - ((f.mean - min) / (max - min)) * h;
          return <circle key={i} cx={x} cy={y} r="3" fill="var(--neon-cool)" />;
        })}
      </svg>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${forecast.length}, 1fr)`, gap: 4 }}>
        {forecast.map((f, i) => (
          <div key={i} style={{ textAlign: 'center' }}>
            <div className="mono" style={{ fontSize: 9, color: 'var(--ink-3)', letterSpacing: '0.1em' }}>
              {['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][f.dow]}
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-1)', marginTop: 2 }}>
              {f.mean.toFixed(0)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SourceBreakdown({ sources }: { sources: Source[] }) {
  const total = sources.reduce((a, s) => a + s.pct, 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', width: '100%', height: 10, borderRadius: 2, overflow: 'hidden' }}>
        {sources.map((s) => (
          <div key={s.name} title={`${s.name} · ${s.pct}%`}
            style={{ width: `${(s.pct / total) * 100}%`, background: s.color }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {sources.map((s) => (
          <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ink-1)' }}>
              <span style={{ width: 6, height: 6, background: s.color, borderRadius: 1 }} />
              {s.name}
            </span>
            <span className="mono" style={{ color: 'var(--ink-2)' }}>{s.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

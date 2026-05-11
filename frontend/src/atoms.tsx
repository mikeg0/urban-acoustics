import { Fragment, type ReactNode } from 'react';

type PillTone = 'default' | 'hot' | 'warn' | 'cool' | 'ok';

const TONE_STYLES: Record<PillTone, { bg: string; border: string; color: string }> = {
  default: { bg: 'var(--bg-2)', border: 'var(--line)', color: 'var(--ink-1)' },
  hot:     { bg: 'oklch(25% 0.04 35)', border: 'oklch(40% 0.1 35)', color: 'var(--neon-hot)' },
  warn:    { bg: 'oklch(25% 0.04 70)', border: 'oklch(40% 0.08 70)', color: 'var(--neon-warn)' },
  cool:    { bg: 'oklch(22% 0.03 230)', border: 'oklch(35% 0.06 230)', color: 'var(--neon-cool)' },
  ok:      { bg: 'oklch(22% 0.03 160)', border: 'oklch(35% 0.06 160)', color: 'var(--neon-ok)' },
};

export function Pill({ children, tone = 'default', onClick, active, icon }: {
  children: ReactNode;
  tone?: PillTone;
  onClick?: () => void;
  active?: boolean;
  icon?: boolean;
}) {
  const t = TONE_STYLES[tone];
  return (
    <span
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px',
        background: active ? 'var(--bg-3)' : t.bg,
        border: `1px solid ${t.border}`,
        borderRadius: 999,
        fontSize: 11,
        fontFamily: 'var(--mono)',
        letterSpacing: '0.04em',
        color: t.color,
        cursor: onClick ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
      }}
    >
      {icon && <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: t.color }} />}
      {children}
    </span>
  );
}

export function Card({ title, subtitle, children, right, padding = 16, className }: {
  title?: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  right?: ReactNode;
  padding?: number;
  className?: string;
}) {
  return (
    <div className={className} style={{
      background: 'var(--bg-1)',
      border: '1px solid var(--line)',
      borderRadius: 'var(--rad-lg)',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
    }}>
      {(title || right) && (
        <div style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--line)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12,
        }}>
          <div>
            {title && <div style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-2)' }}>{title}</div>}
            {subtitle && <div style={{ fontSize: 12, color: 'var(--ink-1)', marginTop: 2 }}>{subtitle}</div>}
          </div>
          {right}
        </div>
      )}
      <div style={{ padding, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
    </div>
  );
}

export function StatBig({ label, value, unit, delta, tone }: {
  label: string;
  value: ReactNode;
  unit?: string;
  delta?: string;
  tone?: 'hot' | 'default';
}) {
  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>{label}</div>
      <div className="mono" style={{
        fontSize: 28, fontWeight: 500,
        color: tone === 'hot' ? 'var(--neon-hot)' : 'var(--ink-0)',
        marginTop: 4, letterSpacing: '-0.02em',
      }}>
        {value}
        {unit && <span style={{ fontSize: 12, color: 'var(--ink-3)', marginLeft: 4 }}>{unit}</span>}
      </div>
      {delta && (
        <div className="mono" style={{ fontSize: 11, color: 'var(--ink-2)', marginTop: 2 }}>{delta}</div>
      )}
    </div>
  );
}

export function Sparkline({ values, width = 120, height = 28, threshold, palette = 'cool', responsive = false }: {
  values: number[];
  width?: number;
  height?: number;
  threshold?: number;
  palette?: 'cool' | 'hot' | 'warn';
  responsive?: boolean;
}) {
  if (!values?.length) return null;
  const max = Math.max(...values), min = Math.min(...values);
  const pts: [number, number][] = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / (max - min || 1)) * (height - 2) - 1;
    return [x, y];
  });
  const stroke = palette === 'hot' ? 'var(--neon-hot)' : palette === 'warn' ? 'var(--neon-warn)' : 'var(--neon-cool)';
  const svgProps = responsive
    ? { width: '100%', height, viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' as const }
    : { width, height };
  return (
    <svg {...svgProps} style={{ display: 'block' }}>
      {threshold != null && (() => {
        const y = height - ((threshold - min) / (max - min || 1)) * (height - 2) - 1;
        return <line x1="0" x2={width} y1={y} y2={y} stroke="var(--neon-hot)" strokeDasharray="2 3" strokeWidth="1" opacity="0.5" />;
      })()}
      <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={stroke} strokeWidth="1.25" />
      {values.map((v, i) => threshold != null && v >= threshold ? (
        <circle key={i} cx={pts[i][0]} cy={pts[i][1]} r="1.8" fill="var(--neon-hot)" />
      ) : null)}
    </svg>
  );
}

export interface CrumbItem {
  label: string;
  enabled?: boolean;
  mono?: boolean;
  upper?: boolean;
}

export function Crumb({ items, onNav }: { items: CrumbItem[]; onNav?: (i: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {items.map((it, i) => (
        <Fragment key={i}>
          <div
            onClick={() => it.enabled !== false && onNav?.(i)}
            style={{
              fontSize: 12,
              color: i === items.length - 1 ? 'var(--ink-0)' : 'var(--ink-2)',
              cursor: it.enabled !== false && i !== items.length - 1 ? 'pointer' : 'default',
              fontFamily: it.mono ? 'var(--mono)' : 'var(--sans)',
              textTransform: it.upper ? 'uppercase' : 'none',
              letterSpacing: it.upper ? '0.12em' : 0,
            }}
          >
            {it.label}
          </div>
          {i < items.length - 1 && (
            <svg width="10" height="10" viewBox="0 0 10 10" style={{ color: 'var(--ink-3)' }}>
              <path d="M3 2l4 3-4 3" stroke="currentColor" fill="none" strokeWidth="1" />
            </svg>
          )}
        </Fragment>
      ))}
    </div>
  );
}

export function LiveDot() {
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: 8, height: 8 }}>
      <span style={{
        position: 'absolute', inset: 0, borderRadius: 4,
        background: 'var(--neon-ok)',
        animation: 'pulse-dot 2s ease-in-out infinite',
      }} />
    </span>
  );
}

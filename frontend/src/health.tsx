import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchHealth, putLedMode, type LedMode } from './api';
import { Pill } from './atoms';
import type { DeviceHealthPoint, HealthResolution } from './types';

type RangeKey = '1h' | '24h' | '7d' | '30d';

interface RangeSpec {
  key: RangeKey;
  label: string;
  windowS: number;
  res: HealthResolution;
}

const RANGES: readonly RangeSpec[] = [
  { key: '1h',  label: '1 h',  windowS: 3600,         res: 'raw' },
  { key: '24h', label: '24 h', windowS: 24 * 3600,    res: '1m'  },
  { key: '7d',  label: '7 d',  windowS: 7 * 24 * 3600, res: '1h' },
  { key: '30d', label: '30 d', windowS: 30 * 24 * 3600, res: '1h' },
];

type Tone = 'cool' | 'warn' | 'hot' | 'ok';

interface MetricSpec {
  key: keyof Omit<DeviceHealthPoint, 'ts' | 'fw_version' | 'config_version'>;
  label: string;
  unit: string;
  tone: Tone;
  format: (v: number) => string;
  /** Optional y-axis floor (else min of data). */
  yMin?: number;
  /** Optional y-axis ceiling (else max of data). */
  yMax?: number;
  /** Returns 'hot' if the current value should glow red. */
  isHot?: (v: number) => boolean;
  /** Returns 'warn' if the current value should glow amber. */
  isWarn?: (v: number) => boolean;
  note?: string;
}

const fmt1 = (v: number) => v.toFixed(1);
const fmt0 = (v: number) => v.toFixed(0);
const fmtMB = (v: number) =>
  v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${v.toFixed(0)} MB`;

function formatUptime(s: number): string {
  if (!isFinite(s) || s <= 0) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const METRICS: readonly MetricSpec[] = [
  {
    key: 'cpu_pct', label: 'CPU', unit: '%', tone: 'cool',
    format: fmt1, yMin: 0, yMax: 100,
    isHot: (v) => v >= 90, isWarn: (v) => v >= 70,
  },
  {
    key: 'cpu_temp_c', label: 'CPU temp', unit: '°C', tone: 'warn',
    format: fmt1, yMin: 30,
    isHot: (v) => v >= 80, isWarn: (v) => v >= 70,
    note: 'MAX per bucket — worst peak survives downsample.',
  },
  {
    key: 'wifi_rssi_dbm', label: 'Wi-Fi RSSI', unit: 'dBm', tone: 'cool',
    format: fmt0,
    isHot: (v) => v <= -80, isWarn: (v) => v <= -70,
    note: 'MIN per bucket — worst signal survives.',
  },
  {
    key: 'queue_depth', label: 'Queue depth', unit: 'msgs', tone: 'hot',
    format: fmt0, yMin: 0,
    isHot: (v) => v >= 100, isWarn: (v) => v >= 10,
    note: 'MAX per bucket. Sustained non-zero = upload backpressure.',
  },
  {
    key: 'queue_bytes', label: 'Queue bytes', unit: '', tone: 'hot',
    format: fmtMB, yMin: 0,
    note: 'MAX per bucket.',
  },
  {
    key: 'disk_free_mb', label: 'Disk free', unit: '', tone: 'ok',
    format: fmtMB, yMin: 0,
    isHot: (v) => v <= 200, isWarn: (v) => v <= 500,
    note: 'MIN per bucket — lowest headroom survives.',
  },
  {
    key: 'mem_used_mb', label: 'Memory used', unit: '', tone: 'cool',
    format: fmtMB, yMin: 0,
  },
  {
    key: 'ntp_offset_ms', label: 'NTP offset', unit: 'ms', tone: 'warn',
    format: fmt1,
    isHot: (v) => Math.abs(v) >= 1000, isWarn: (v) => Math.abs(v) >= 100,
  },
  {
    key: 'uptime_s', label: 'Uptime', unit: '', tone: 'ok',
    format: (v) => formatUptime(v), yMin: 0,
    note: 'Falls to ~0 at every reboot — drops are visible signal, not noise.',
  },
];

interface HealthViewState {
  range: RangeKey;
  points: DeviceHealthPoint[];
  loading: boolean;
  error: string | null;
}

// Detect timestamps where fw_version or config_version transitions. Returned
// list is sorted and de-duplicated — fed to each chart's overlay so an
// operator can correlate a metric blip with a firmware/config change.
interface VersionChange {
  ts: number;
  field: 'fw_version' | 'config_version';
  from: string;
  to: string;
}
function detectVersionChanges(points: DeviceHealthPoint[]): VersionChange[] {
  const out: VersionChange[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (cur.fw_version !== prev.fw_version) {
      out.push({ ts: cur.ts, field: 'fw_version', from: prev.fw_version, to: cur.fw_version });
    }
    if (cur.config_version !== prev.config_version) {
      out.push({ ts: cur.ts, field: 'config_version', from: prev.config_version, to: cur.config_version });
    }
  }
  return out;
}

interface RealHealthViewProps {
  deviceId: string;
}

export function RealHealthView({ deviceId }: RealHealthViewProps) {
  const [state, setState] = useState<HealthViewState>({
    range: '24h', points: [], loading: true, error: null,
  });

  const load = useCallback(async (range: RangeKey) => {
    const spec = RANGES.find((r) => r.key === range)!;
    const now = Date.now() / 1000;
    setState((s) => ({ ...s, loading: true, error: null, range }));
    try {
      const r = await fetchHealth(deviceId, now - spec.windowS, now, spec.res);
      setState({ range, points: r.points, loading: false, error: null });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, [deviceId]);

  useEffect(() => { load('24h'); }, [load]);

  // Auto-refresh: every 30 s on the 1h/24h ranges where the data is "live
  // enough" to be worth re-pulling. The 7d/30d ranges don't move fast enough
  // to merit polling.
  useEffect(() => {
    if (state.range !== '1h' && state.range !== '24h') return;
    const id = setInterval(() => load(state.range), 30_000);
    return () => clearInterval(id);
  }, [load, state.range]);

  const versionChanges = useMemo(() => detectVersionChanges(state.points), [state.points]);
  const latest = state.points.length ? state.points[state.points.length - 1] : null;
  const lastSampleAge = latest ? Math.max(0, Date.now() / 1000 - latest.ts) : null;
  const fresh = lastSampleAge != null && lastSampleAge < 120;

  const rangeSpec = RANGES.find((r) => r.key === state.range)!;
  const windowFrom = (Date.now() / 1000) - rangeSpec.windowS;
  const windowTo = Date.now() / 1000;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 14, padding: 14,
      height: '100%', overflow: 'auto',
    }}>
      <HealthHeader
        deviceId={deviceId}
        latest={latest}
        lastSampleAge={lastSampleAge}
        fresh={fresh}
      />

      <LedToggle deviceId={deviceId} />

      <RangeBar
        range={state.range}
        onChange={load}
        resolution={rangeSpec.res}
        loading={state.loading}
      />

      {state.error && (
        <div className="mono" style={{ fontSize: 11, color: 'var(--neon-hot)' }}>
          health: {state.error}
        </div>
      )}

      {!state.loading && state.points.length === 0 && !state.error && (
        <div className="mono" style={{
          fontSize: 12, color: 'var(--ink-3)', letterSpacing: '0.1em',
          padding: 30, textAlign: 'center',
          background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8,
        }}>
          NO HEALTH SAMPLES IN THIS RANGE
        </div>
      )}

      {versionChanges.length > 0 && (
        <VersionChangeLog changes={versionChanges} />
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10,
      }}>
        {METRICS.map((m) => (
          <MetricPanel
            key={m.key}
            spec={m}
            points={state.points}
            windowFrom={windowFrom}
            windowTo={windowTo}
            versionChanges={versionChanges}
            latest={latest}
          />
        ))}
      </div>
    </div>
  );
}

function HealthHeader({
  deviceId, latest, lastSampleAge, fresh,
}: {
  deviceId: string;
  latest: DeviceHealthPoint | null;
  lastSampleAge: number | null;
  fresh: boolean;
}) {
  const statusLabel = latest == null
    ? 'WAITING'
    : fresh ? 'RECEIVING HEALTH' : 'STALE';
  const tone: 'ok' | 'hot' | 'default' = latest == null
    ? 'default' : fresh ? 'ok' : 'hot';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 16px',
      background: fresh ? 'var(--bg-1)' : 'oklch(22% 0.06 35)',
      border: `1px solid ${fresh ? 'var(--line)' : 'oklch(50% 0.15 35)'}`,
      borderRadius: 8, gap: 14, flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <Pill tone={tone} icon>{statusLabel}</Pill>
        <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
          ID {deviceId}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
        <HeaderStat label="Uptime" value={latest ? formatUptime(latest.uptime_s) : '—'} />
        <HeaderStat label="Mic gain" value={latest ? `${latest.mic_gain_db.toFixed(1)} dB` : '—'} />
        <HeaderStat label="fw" value={latest?.fw_version ?? '—'} />
        <HeaderStat label="cfg" value={latest?.config_version ?? '—'} />
        <HeaderStat
          label="Last sample"
          value={lastSampleAge == null
            ? '—'
            : lastSampleAge < 90 ? `${Math.round(lastSampleAge)}s ago`
              : `${Math.round(lastSampleAge / 60)}m ago`}
        />
      </div>
    </div>
  );
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span className="mono" style={{
        fontSize: 9, color: 'var(--ink-3)', letterSpacing: '0.14em', textTransform: 'uppercase',
      }}>{label}</span>
      <span className="mono" style={{ fontSize: 12, color: 'var(--ink-0)' }}>{value}</span>
    </div>
  );
}

// The LED is wired to GPIO4 on the sensor. In `auto` mode the Pi drives
// it from the live LAFmax vs. event_threshold_db check (with the detector's
// hysteresis), so the LED is lit exactly while the device is in a breach.
// `on` / `off` latch the LED for bring-up or to highlight a single sensor
// on a bench; sending `auto` again releases the override.
//
// State is intent-only — the backend doesn't persist mode, and the dashboard
// can't see the actual pin level, only what was last pushed.
const LED_MODE_OPTIONS: readonly { mode: LedMode; label: string }[] = [
  { mode: 'auto', label: 'Auto' },
  { mode: 'on',   label: 'On'   },
  { mode: 'off',  label: 'Off'  },
];

function LedToggle({ deviceId }: { deviceId: string }) {
  const [mode, setMode] = useState<LedMode>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = useCallback(async (next: LedMode) => {
    if (busy || next === mode) return;
    setBusy(true);
    setError(null);
    try {
      await putLedMode(deviceId, next);
      setMode(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, deviceId, mode]);

  const dotColor = mode === 'on' ? 'var(--neon-hot)'
    : mode === 'off' ? 'var(--ink-3)'
    : 'var(--neon-cool)';
  const dotGlow = mode === 'on' ? '0 0 6px var(--neon-hot)'
    : mode === 'auto' ? '0 0 4px var(--neon-cool)'
    : 'none';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 14px',
      background: 'var(--bg-1)', border: '1px solid var(--line)',
      borderRadius: 8, flexWrap: 'wrap',
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: 4,
        background: dotColor, boxShadow: dotGlow,
      }} />
      <div className="mono" style={{
        fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.14em', textTransform: 'uppercase',
      }}>
        Breach LED · GPIO4
      </div>
      <div style={{
        display: 'flex', background: 'var(--bg-2)', border: '1px solid var(--line)',
        borderRadius: 6, padding: 2,
      }}>
        {LED_MODE_OPTIONS.map(({ mode: m, label }) => (
          <button
            key={m}
            onClick={() => choose(m)}
            disabled={busy}
            style={{
              padding: '5px 12px',
              fontSize: 11, fontFamily: 'var(--mono)',
              letterSpacing: '0.12em', textTransform: 'uppercase',
              background: mode === m ? 'var(--bg-3)' : 'transparent',
              border: 'none', borderRadius: 4,
              color: mode === m ? 'var(--ink-0)' : 'var(--ink-2)',
              cursor: busy ? 'wait' : 'pointer',
              fontWeight: mode === m ? 600 : 400,
              opacity: busy && mode !== m ? 0.5 : 1,
            }}
          >{label}</button>
        ))}
      </div>
      <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>
        {mode === 'auto'
          ? 'follows LAFmax ≥ threshold'
          : `forced ${mode}`}
      </span>
      {busy && (
        <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.12em' }}>
          SENDING…
        </span>
      )}
      {error && (
        <span className="mono" style={{ fontSize: 10, color: 'var(--neon-hot)', letterSpacing: '0.06em' }}>
          {error}
        </span>
      )}
    </div>
  );
}

function RangeBar({
  range, onChange, resolution, loading,
}: {
  range: RangeKey;
  onChange: (r: RangeKey) => void;
  resolution: HealthResolution;
  loading: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.14em' }}>
        RANGE
      </span>
      <div style={{
        display: 'flex', background: 'var(--bg-2)', border: '1px solid var(--line)',
        borderRadius: 6, padding: 2,
      }}>
        {RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => onChange(r.key)}
            style={{
              padding: '5px 12px',
              fontSize: 11, fontFamily: 'var(--mono)',
              letterSpacing: '0.12em', textTransform: 'uppercase',
              background: range === r.key ? 'var(--bg-3)' : 'transparent',
              border: 'none', borderRadius: 4,
              color: range === r.key ? 'var(--ink-0)' : 'var(--ink-2)',
              cursor: 'pointer',
              fontWeight: range === r.key ? 600 : 400,
            }}
          >{r.label}</button>
        ))}
      </div>
      <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.12em' }}>
        RES <span style={{ color: 'var(--ink-1)' }}>{resolution}</span>
      </span>
      {loading && (
        <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.12em' }}>
          LOADING…
        </span>
      )}
    </div>
  );
}

const TONE_STROKE: Record<Tone, string> = {
  cool: 'oklch(78% 0.14 215)',
  warn: 'oklch(82% 0.16 70)',
  hot:  'oklch(72% 0.2 35)',
  ok:   'oklch(72% 0.14 160)',
};

function MetricPanel({
  spec, points, windowFrom, windowTo, versionChanges, latest,
}: {
  spec: MetricSpec;
  points: DeviceHealthPoint[];
  windowFrom: number;
  windowTo: number;
  versionChanges: VersionChange[];
  latest: DeviceHealthPoint | null;
}) {
  const series = useMemo(
    () => points.map((p) => ({ ts: p.ts, v: p[spec.key] as number })),
    [points, spec.key],
  );
  const currentValue = latest ? (latest[spec.key] as number) : null;
  const valueTone: 'hot' | 'warn' | 'default' =
    currentValue == null ? 'default'
      : spec.isHot?.(currentValue) ? 'hot'
        : spec.isWarn?.(currentValue) ? 'warn'
          : 'default';
  const valueColor =
    valueTone === 'hot' ? 'var(--neon-hot)'
      : valueTone === 'warn' ? 'var(--neon-warn)'
        : 'var(--ink-0)';
  return (
    <div style={{
      background: 'var(--bg-1)', border: '1px solid var(--line)',
      borderRadius: 8, padding: 12,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div className="mono" style={{
          fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.14em', textTransform: 'uppercase',
        }}>{spec.label}</div>
        <div className="mono" style={{ fontSize: 18, color: valueColor }}>
          {currentValue == null ? '—' : spec.format(currentValue)}
          {spec.unit && (
            <span style={{ fontSize: 10, color: 'var(--ink-3)', marginLeft: 4 }}>{spec.unit}</span>
          )}
        </div>
      </div>
      <MetricChart
        series={series}
        spec={spec}
        windowFrom={windowFrom}
        windowTo={windowTo}
        versionChanges={versionChanges}
      />
      {spec.note && (
        <div className="mono" style={{ fontSize: 9, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>
          {spec.note}
        </div>
      )}
    </div>
  );
}

function MetricChart({
  series, spec, windowFrom, windowTo, versionChanges,
}: {
  series: { ts: number; v: number }[];
  spec: MetricSpec;
  windowFrom: number;
  windowTo: number;
  versionChanges: VersionChange[];
}) {
  const W = 600;
  const H = 70;
  const PADDING_Y = 4;

  if (series.length === 0) {
    return (
      <div style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span className="mono" style={{ fontSize: 9, color: 'var(--ink-3)', letterSpacing: '0.14em' }}>
          NO DATA
        </span>
      </div>
    );
  }

  const valsForRange = series.map((p) => p.v).filter((v) => isFinite(v));
  const dataMin = valsForRange.length ? Math.min(...valsForRange) : 0;
  const dataMax = valsForRange.length ? Math.max(...valsForRange) : 1;
  const yMin = spec.yMin ?? dataMin;
  const yMax = spec.yMax ?? Math.max(dataMax, yMin + 1);
  const ySpan = Math.max(1e-9, yMax - yMin);
  const xSpan = Math.max(1, windowTo - windowFrom);

  const xFor = (ts: number) => ((ts - windowFrom) / xSpan) * W;
  const yFor = (v: number) =>
    H - PADDING_Y - ((v - yMin) / ySpan) * (H - PADDING_Y * 2);

  // Break the path on > 3× expected sampling gap so a missed minute doesn't
  // draw a fake trend line across the gap.
  const expectedDt = xSpan / Math.max(1, series.length);
  const gapThreshold = Math.max(expectedDt * 3, 120);
  const buildPath = () => {
    let d = '';
    let last: number | null = null;
    for (const p of series) {
      if (!isFinite(p.v)) { last = null; continue; }
      const cmd = (last == null || p.ts - last > gapThreshold) ? 'M' : 'L';
      d += `${cmd}${xFor(p.ts).toFixed(2)},${yFor(p.v).toFixed(2)}`;
      last = p.ts;
    }
    return d;
  };

  const stroke = TONE_STROKE[spec.tone];
  // 4 horizontal gridlines at quartile y values.
  const gridYs = [0.25, 0.5, 0.75].map((f) => yMin + ySpan * f);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: H, display: 'block', background: 'var(--bg-2)', borderRadius: 4 }}
    >
      {gridYs.map((g, i) => (
        <line key={i}
          x1={0} x2={W} y1={yFor(g)} y2={yFor(g)}
          stroke="rgba(255,255,255,0.05)" strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {versionChanges.map((c, i) => {
        if (c.ts < windowFrom || c.ts > windowTo) return null;
        const x = xFor(c.ts);
        const color = c.field === 'fw_version'
          ? 'oklch(78% 0.16 290)'
          : 'oklch(78% 0.16 150)';
        return (
          <line key={i}
            x1={x} x2={x} y1={0} y2={H}
            stroke={color} strokeWidth={1} strokeDasharray="2 2" opacity={0.7}
            vectorEffect="non-scaling-stroke"
          >
            <title>{c.field} {c.from} → {c.to}</title>
          </line>
        );
      })}
      <path d={buildPath()} stroke={stroke} strokeWidth={1.4}
        fill="none" vectorEffect="non-scaling-stroke"
        strokeLinejoin="round" strokeLinecap="round" />
      {/* axis labels */}
      <text x={3} y={9}
        fill="rgba(255,255,255,0.4)" fontSize={8} fontFamily="var(--mono)">
        {spec.format(yMax)}
      </text>
      <text x={3} y={H - 2}
        fill="rgba(255,255,255,0.4)" fontSize={8} fontFamily="var(--mono)">
        {spec.format(yMin)}
      </text>
    </svg>
  );
}

function VersionChangeLog({ changes }: { changes: VersionChange[] }) {
  return (
    <div style={{
      background: 'var(--bg-1)', border: '1px solid var(--line)',
      borderRadius: 8, padding: 12,
    }}>
      <div className="mono" style={{
        fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.14em', textTransform: 'uppercase',
        marginBottom: 8,
      }}>
        Version changes in window · {changes.length}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {changes.map((c, i) => (
          <div key={i} className="mono" style={{
            display: 'grid', gridTemplateColumns: '140px 80px 1fr',
            fontSize: 11, color: 'var(--ink-1)', gap: 8,
          }}>
            <span style={{ color: 'var(--ink-2)' }}>
              {new Date(c.ts * 1000).toLocaleString(undefined, {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
            </span>
            <span style={{
              color: c.field === 'fw_version' ? 'oklch(78% 0.16 290)' : 'oklch(78% 0.16 150)',
            }}>{c.field === 'fw_version' ? 'fw' : 'cfg'}</span>
            <span>
              <span style={{ color: 'var(--ink-3)' }}>{c.from}</span>
              <span style={{ color: 'var(--ink-3)', margin: '0 6px' }}>→</span>
              <span style={{ color: 'var(--ink-0)' }}>{c.to}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Demo-mode placeholder. The dashboard's synthetic /api/year bundle has no
// per-device health, so without a real device this tab has nothing to show.
export function HealthView() {
  return (
    <div style={{
      padding: 30, display: 'flex', flexDirection: 'column', gap: 10,
      alignItems: 'center', justifyContent: 'center', height: '100%',
      color: 'var(--ink-2)', fontFamily: 'var(--mono)', textAlign: 'center',
    }}>
      <div style={{ fontSize: 12, letterSpacing: '0.14em', color: 'var(--ink-3)' }}>
        DEMO MODE
      </div>
      <div style={{ fontSize: 14, color: 'var(--ink-1)', maxWidth: 460, lineHeight: 1.5 }}>
        Device health metrics require a real sensor. Set
        {' '}<span style={{ color: 'var(--ink-0)' }}>VITE_DEMO_MODE=false</span> and
        {' '}<span style={{ color: 'var(--ink-0)' }}>VITE_DEVICE_ID=&lt;id&gt;</span>
        {' '}to view CPU temp, Wi-Fi RSSI, queue depth, NTP offset, uptime, and the rest.
      </div>
    </div>
  );
}

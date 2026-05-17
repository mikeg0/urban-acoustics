import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAnomaliesRange,
  fetchDailySummary,
  fetchDevice,
  fetchDeviceForecast,
  fetchDeviceSources,
  fetchTelemetry,
  fetchYear,
  liveDeviceSocket,
} from './api';
import { Card, Crumb, LiveDot, Pill, StatBig } from './atoms';
import {
  anomaliesToUi,
  daysToMonths,
  forecastToUi,
  peakHoursFromDays,
  sourcesToUi,
  summaryToDays,
} from './dashboard_adapter';
import { DayView, HourView, MonthView, YearHeatmap, YearView } from './drills';
import { HealthView, RealHealthView } from './health';
import { LiveView, RealLiveView } from './live';
import { PALETTES } from './palettes';
import { AnomaliesFeed, BreachRibbon, ForecastPanel, PeakHoursChart, SourceBreakdown } from './panels';
import { SettingsButton, SettingsDialog } from './settings';
import {
  LiveSpectrogram,
  SpectrogramCanvas,
  TimelineSpectrogram,
  buildSpectrogram,
  useRollingBands,
} from './spectrogram';
import { useTweaks } from './tweaks';
import { hydrateMonths } from './utils';
import type {
  Anomaly, Day, DeviceInfo, DeviceLiveMessage,
  DrillState, ForecastPoint, MonthHydrated, Source, YearBundle,
} from './types';

// Real mode is opt-in: both env flags must be set. When on, the Live tab is
// powered by real-device telemetry from /api/v1; the rest of the dashboard
// (year heatmap, anomalies, forecast, etc.) still renders from the synthetic
// /api/year bundle since no real long-horizon history exists yet.
const VITE_DEVICE_ID = import.meta.env.VITE_DEVICE_ID;
const VITE_DEMO_MODE = import.meta.env.VITE_DEMO_MODE;
const REAL_MODE = VITE_DEMO_MODE === 'false' && !!VITE_DEVICE_ID;

type FlowKey = 'breadcrumb' | 'stacked' | 'zoom';

type PageKey = 'live' | 'dashboard' | 'health';

function TopBar({
  threshold, page, onPageChange, onOpenSettings, sensorPos, sensor,
}: {
  threshold: number;
  page: PageKey;
  onPageChange: (p: PageKey) => void;
  onOpenSettings: () => void;
  sensor: string;
  sensorPos: string;
}) {
  const [t, setT] = useState(() => new Date());
  useEffect(() => {
    const i = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(i);
  }, []);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 22px',
      borderBottom: '1px solid var(--line)',
      background: 'var(--bg-0)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <rect x="2" y="9" width="2" height="4" fill="var(--neon-cool)" />
            <rect x="5" y="6" width="2" height="10" fill="var(--neon-cool)" />
            <rect x="8" y="3" width="2" height="16" fill="var(--neon-hot)" />
            <rect x="11" y="7" width="2" height="8" fill="var(--neon-warn)" />
            <rect x="14" y="5" width="2" height="12" fill="var(--neon-cool)" />
            <rect x="17" y="8" width="2" height="6" fill="var(--neon-cool)" />
          </svg>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>Riverton · Urban Acoustics</div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
              PUBLIC NOISE ATLAS · v0.1
            </div>
          </div>
        </div>
        <div style={{ width: 1, height: 28, background: 'var(--line)', marginLeft: 6 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <LiveDot />
          <div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-1)' }}>{sensor} · {sensorPos}</div>
            <div className="mono" style={{ fontSize: 9, color: 'var(--ink-3)' }}>STREAMING · 48 kHz · A-weighted</div>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 6, padding: 2 }}>
          {(['live', 'dashboard', 'health'] as const).map((k) => (
            <button
              key={k}
              onClick={() => onPageChange(k)}
              style={{
                padding: '5px 12px',
                fontSize: 11,
                fontFamily: 'var(--mono)',
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                background: page === k ? 'var(--bg-3)' : 'transparent',
                border: 'none',
                borderRadius: 4,
                color: page === k ? 'var(--ink-0)' : 'var(--ink-2)',
                cursor: 'pointer',
                fontWeight: page === k ? 600 : 400,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              {k === 'live' && <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--neon-hot)', animation: 'live-pulse 1.4s ease-in-out infinite' }} />}
              {k === 'live' ? 'Live' : k === 'dashboard' ? 'Dashboard' : 'Health'}
            </button>
          ))}
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--ink-2)' }}>
          THRESHOLD <span style={{ color: 'var(--neon-hot)' }}>≥ {threshold} dB</span>
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--ink-1)', padding: '6px 10px', background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 6 }}>
          {t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
        </div>
        <SettingsButton onClick={onOpenSettings} />
      </div>
    </div>
  );
}

function NowCard({ palette }: { palette: keyof typeof PALETTES }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setTick((x) => x + 1), 1500);
    return () => clearInterval(i);
  }, []);
  const data = useMemo(() => buildSpectrogram(77777 + tick, 1.1), [tick]);
  const currentDb = 71.2 + Math.sin(tick * 0.7) * 4;

  return (
    <Card title="LIVE · RIGHT NOW" right={<Pill tone="ok" icon>STREAMING</Pill>} padding={14}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <div>
          <div className="mono" style={{ fontSize: 40, letterSpacing: '-0.03em', color: 'var(--ink-0)', lineHeight: 1 }}>
            {currentDb.toFixed(1)}
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>dB(A) · L<sub>eq,1min</sub></div>
        </div>
        <div style={{ flex: 1, height: 70, borderRadius: 4, overflow: 'hidden' }}>
          <SpectrogramCanvas data={data} palette={palette} height={70} />
        </div>
      </div>
    </Card>
  );
}

const NOW_CARD_WINDOW_S = 15 * 60;
// Compact spectrogram window for the dashboard card. ~20 s at the wire rate
// (~12 Hz) so each column is wide enough to read at the smaller height.
const NOW_CARD_SPECT_FRAMES = 240;

function RealNowCard({ deviceId, threshold }: { deviceId: string; threshold: number }) {
  const { spectroColor } = useTweaks();
  const [lastTick, setLastTick] = useState<{ ts: number; laeq: number } | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const spectRing = useRollingBands(NOW_CARD_SPECT_FRAMES);
  const spectPushRef = useRef(spectRing.push);
  useEffect(() => { spectPushRef.current = spectRing.push; }, [spectRing.push]);

  // Seed lastTick from the REST telemetry endpoint so the number is non-empty
  // on first render even if the WS is still connecting.
  const seed = useCallback(async () => {
    const now = Date.now() / 1000;
    try {
      const r = await fetchTelemetry(deviceId, now - 60, now, 'raw');
      const newest = r.points[r.points.length - 1];
      if (newest) setLastTick({ ts: newest.ts, laeq: newest.laeq });
    } catch { /* fall through to the WS */ }
  }, [deviceId]);

  useEffect(() => {
    seed();
    if (wsConnected) return;
    const id = setInterval(seed, 5000);
    return () => clearInterval(id);
  }, [seed, wsConnected]);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    try { ws = liveDeviceSocket(deviceId); } catch { return; }
    ws.onopen = () => { if (!closed) setWsConnected(true); };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as DeviceLiveMessage;
        if (msg.type === 'tick') {
          setLastTick({ ts: msg.ts, laeq: msg.laeq });
        } else if (msg.type === 'spect') {
          spectPushRef.current(msg.ts, msg.bands);
        }
      } catch { /* ignore */ }
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

  const lastAge = lastTick ? Math.max(0, Date.now() / 1000 - lastTick.ts) : null;
  const fresh = lastAge != null && lastAge < 90;
  const breach = lastTick != null && lastTick.laeq >= threshold;
  const status: { tone: 'ok' | 'hot' | 'default'; label: string } =
    fresh ? { tone: 'ok', label: 'STREAMING' }
      : lastTick == null ? { tone: 'default', label: 'WAITING' }
        : { tone: 'hot', label: 'STALE' };
  const waitingSpect = !spectRing.hasData;

  return (
    <Card title="LIVE · RIGHT NOW" right={<Pill tone={status.tone} icon>{status.label}</Pill>} padding={14}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <div>
          <div className="mono" style={{
            fontSize: 40, letterSpacing: '-0.03em',
            color: breach ? 'var(--neon-hot)' : 'var(--ink-0)',
            lineHeight: 1,
          }}>
            {lastTick ? lastTick.laeq.toFixed(1) : '—'}
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>
            dB(A) · LAeq · {lastAge != null
              ? lastAge < 90 ? `${Math.round(lastAge)}s ago` : `${Math.round(lastAge / 60)}m ago`
              : 'no data'}
          </div>
        </div>
        <div style={{ flex: 1, position: 'relative' }}>
          <LiveSpectrogram
            ring={spectRing}
            palette={spectroColor}
            height={70}
            minDb={20}
            maxDb={110}
          />
          {waitingSpect && (
            <div className="mono" style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9, letterSpacing: '0.12em', color: 'var(--ink-3)',
              background: 'rgba(0,0,0,0.4)', borderRadius: 4, pointerEvents: 'none',
            }}>
              WAITING FOR SPECTROGRAM
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function HeadlineStats({
  year, threshold, sensitivity, anomaliesCount,
}: {
  year: Day[]; threshold: number; sensitivity: number; anomaliesCount: number;
}) {
  const wrap = (children: React.ReactNode) => (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14,
      padding: '16px 0', borderBottom: '1px solid var(--line)',
    }}>{children}</div>
  );

  if (year.length === 0) {
    return wrap(
      <>
        <StatBig label="Year avg" value="—" unit="dB" />
        <StatBig label="Threshold breaches" value="—" unit={`hrs ≥ ${threshold}dB`} tone="hot" />
        <StatBig label="Loudest day" value="—" unit="dB" delta="awaiting data" />
        <StatBig label="Modal peak hour" value="—:—" delta="awaiting data" />
        <StatBig label="Anomalies flagged" value={anomaliesCount} unit={`z≥${sensitivity.toFixed(1)}`} delta="past 365 days" />
      </>,
    );
  }

  const totalBreaches = year.reduce((a, d) => a + d.breaches, 0);
  const loudestDay = year.reduce((a, d) => (d.peak > a.peak ? d : a), year[0]);
  const peakHourCounts = new Array(24).fill(0);
  year.forEach((d) => { peakHourCounts[d.peakHour] += 1; });
  const modalPeak = peakHourCounts.indexOf(Math.max(...peakHourCounts));
  const meanDb = +(year.reduce((a, d) => a + d.mean, 0) / year.length).toFixed(1);
  const loudestDate = new Date(loudestDay.date + 'T00:00:00');

  return wrap(
    <>
      <StatBig label="Year avg"           value={meanDb}                     unit="dB" />
      <StatBig label="Threshold breaches" value={totalBreaches.toLocaleString()} unit={`hrs ≥ ${threshold}dB`} tone="hot" />
      <StatBig label="Loudest day"        value={loudestDay.peak.toFixed(1)} unit="dB"
        delta={loudestDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + (loudestDay.event ? ` · ${loudestDay.event}` : '')} />
      <StatBig label="Modal peak hour"    value={`${String(modalPeak).padStart(2, '0')}:00`} delta="weekday rush + nightlife bleed" />
      <StatBig label="Anomalies flagged"  value={anomaliesCount}             unit={`z≥${sensitivity.toFixed(1)}`} delta="past 365 days" />
    </>,
  );
}

interface DrillProps {
  state: DrillState;
  setState: (s: DrillState) => void;
  threshold: number;
  palette: keyof typeof PALETTES;
  months: MonthHydrated[];
  yearDays: Day[];
  /** Real-mode passes a deviceId so the hour-view spectrogram and the
   *  24-hour timeline render from server-rendered tiles instead of the
   *  synthetic seeded preview. */
  deviceId?: string | null;
}

function DrillFlowBreadcrumb({ state, setState, threshold, palette, months, yearDays, deviceId = null }: DrillProps) {
  const { month, dayKey, hour } = state;
  const monthObj = month != null ? months[month] : null;
  const dayObj = dayKey ? yearDays.find((d) => d.key === dayKey) ?? null : null;

  const crumbs = [
    { label: '2025', upper: true, mono: true },
    { label: monthObj ? monthObj.name : '—', upper: true },
    { label: dayObj ? new Date(dayObj.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—', mono: true },
    { label: hour != null ? `${String(hour).padStart(2, '0')}:00` : '—', mono: true },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Crumb items={crumbs} onNav={(i) => {
          if (i === 0) setState({ month: null, dayKey: null, hour: null });
          else if (i === 1) setState({ ...state, dayKey: null, hour: null });
          else if (i === 2) setState({ ...state, hour: null });
        }} />
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          {month == null ? 'Year' : !dayKey ? 'Month' : hour == null ? 'Day' : 'Hour · Timeline'}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {month == null && (
          <div>
            <YearView months={months} threshold={threshold}
              onPick={(m) => setState({ ...state, month: m })}
              selectedMonth={month} />
            <YearHeatmap days={yearDays} threshold={threshold}
              onPickDay={(d) => setState({ ...state, month: new Date(d.date + 'T00:00:00').getMonth(), dayKey: d.key })} />
          </div>
        )}
        {month != null && !dayKey && monthObj && (
          <MonthView month={monthObj} threshold={threshold}
            onPick={(d) => setState({ ...state, dayKey: d.key })} />
        )}
        {dayObj && hour == null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
              <div>
                <div style={{ fontSize: 16, color: 'var(--ink-0)' }}>
                  {new Date(dayObj.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                </div>
                {dayObj.event && <div className="mono" style={{ fontSize: 11, color: 'var(--neon-focus)', marginTop: 2 }}>◆ {dayObj.event}</div>}
              </div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginLeft: 'auto' }}>
                peak <span style={{ color: 'var(--neon-hot)' }}>{dayObj.peak.toFixed(1)}</span> · avg {dayObj.mean.toFixed(1)} · {dayObj.breaches} breach hrs
              </div>
            </div>
            <DayView day={dayObj} threshold={threshold} onPickHour={(h) => setState({ ...state, hour: h })} />
            <div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em', marginBottom: 6 }}>24-HOUR SPECTROGRAM · CLICK TO DRILL</div>
              <TimelineSpectrogram day={dayObj} palette={palette} threshold={threshold}
                showBars onHourClick={(h) => setState({ ...state, hour: h })} deviceId={deviceId} />
            </div>
          </div>
        )}
        {dayObj && hour != null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div>
                <div style={{ fontSize: 16 }}>
                  {new Date(dayObj.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · {String(hour).padStart(2, '0')}:00
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>60-minute window · 64 freq bins</div>
              </div>
              <div className="mono" style={{ fontSize: 22, color: dayObj.hours[hour] >= threshold ? 'var(--neon-hot)' : 'var(--ink-0)' }}>
                {dayObj.hours[hour].toFixed(1)} <span style={{ fontSize: 10, color: 'var(--ink-3)' }}>dB</span>
              </div>
            </div>
            <HourView day={dayObj} hour={hour} palette={palette} threshold={threshold} deviceId={deviceId} />
            <div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em', marginBottom: 6 }}>FULL DAY · 24h CONTEXT</div>
              <TimelineSpectrogram day={dayObj} palette={palette} threshold={threshold} hourFocus={hour}
                showBars onHourClick={(h) => setState({ ...state, hour: h })} deviceId={deviceId} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DrillFlowStacked(props: DrillProps) {
  const { state, setState, threshold, palette, months, yearDays, deviceId = null } = props;
  const { month, dayKey, hour } = state;
  const monthObj = month != null ? months[month] : null;
  const dayObj = dayKey ? yearDays.find((d) => d.key === dayKey) ?? null : null;

  const Section = ({ title, right, children, depth }: { title: string; right?: React.ReactNode; children?: React.ReactNode; depth: 0 | 1 | 2 | 3 }) => (
    <div style={{
      borderLeft: `2px solid ${depth === 0 ? 'var(--line)' : depth === 1 ? 'oklch(45% 0.04 180)' : depth === 2 ? 'oklch(55% 0.08 200)' : 'var(--neon-focus)'}`,
      paddingLeft: 14,
      marginBottom: 14,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <div className="mono" style={{ fontSize: 10, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--ink-2)' }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <Section title="YEAR · 2025" depth={0}
        right={<span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>pick a month ↓</span>}>
        <YearView months={months} threshold={threshold}
          onPick={(m) => setState({ ...state, month: m, dayKey: null, hour: null })} selectedMonth={month} />
        <YearHeatmap days={yearDays} threshold={threshold} selectedDay={dayKey}
          onPickDay={(d) => setState({ ...state, month: new Date(d.date + 'T00:00:00').getMonth(), dayKey: d.key, hour: null })} />
      </Section>
      {monthObj && (
        <Section title={`MONTH · ${monthObj.name}`} depth={1}
          right={<span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>pick a day ↓</span>}>
          <MonthView month={monthObj} threshold={threshold}
            onPick={(d) => setState({ ...state, dayKey: d.key, hour: null })} selectedDay={dayKey} />
        </Section>
      )}
      {dayObj && (
        <Section title={`DAY · ${new Date(dayObj.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`}
          depth={2}
          right={<span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>pick an hour ↓</span>}>
          <DayView day={dayObj} threshold={threshold}
            onPickHour={(h) => setState({ ...state, hour: h })} selectedHour={hour} />
          <div style={{ marginTop: 12 }}>
            <TimelineSpectrogram day={dayObj} palette={palette} threshold={threshold} hourFocus={hour}
              showBars onHourClick={(h) => setState({ ...state, hour: h })} deviceId={deviceId} />
          </div>
        </Section>
      )}
      {dayObj && hour != null && (
        <Section title={`HOUR · ${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00 · SPECTROGRAM`}
          depth={3}
          right={<span className="mono" style={{ fontSize: 10, color: 'var(--neon-focus)' }}>deepest level</span>}>
          <HourView day={dayObj} hour={hour} palette={palette} threshold={threshold} deviceId={deviceId} />
        </Section>
      )}
    </div>
  );
}

function DrillFlowZoom(props: DrillProps) {
  const { state, setState } = props;
  const { month, dayKey, hour } = state;
  const level = month == null ? 0 : !dayKey ? 1 : hour == null ? 2 : 3;
  const [animKey, setAnimKey] = useState(0);
  useEffect(() => { setAnimKey((k) => k + 1); }, [level]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {(['YEAR', 'MONTH', 'DAY', 'HOUR'] as const).map((lbl, i) => (
          <Fragment key={i}>
            <div
              onClick={() => {
                if (i === 0) setState({ month: null, dayKey: null, hour: null });
                if (i === 1 && month != null) setState({ ...state, dayKey: null, hour: null });
                if (i === 2 && dayKey) setState({ ...state, hour: null });
              }}
              style={{
                padding: '4px 10px',
                borderRadius: 4,
                fontSize: 10,
                letterSpacing: '0.12em',
                fontFamily: 'var(--mono)',
                background: i === level ? 'var(--neon-focus)' : i < level ? 'var(--bg-3)' : 'var(--bg-2)',
                color: i === level ? '#0a0a0a' : i < level ? 'var(--ink-0)' : 'var(--ink-3)',
                cursor: i <= level ? 'pointer' : 'default',
                border: '1px solid var(--line)',
                transition: 'all 200ms',
              }}
            >
              {lbl}
            </div>
            {i < 3 && <div style={{ flex: i < level ? 0.2 : 1, height: 1, background: i < level ? 'var(--neon-focus)' : 'var(--line)', transition: 'all 300ms' }} />}
          </Fragment>
        ))}
      </div>
      <div key={animKey} style={{
        flex: 1, minHeight: 0, overflow: 'auto',
        animation: 'zoom-in 380ms cubic-bezier(.2,.8,.2,1)',
      }}>
        <DrillFlowBreadcrumb {...props} />
      </div>
    </div>
  );
}

export function App() {
  return <DashboardApp deviceId={REAL_MODE ? VITE_DEVICE_ID : null} />;
}

// Rolling year window for the dashboard, in seconds. Capped one second below
// the backend's 366d max to avoid round-trip rounding edge cases.
const YEAR_WINDOW_S = 365 * 24 * 3600 - 1;

const DEFAULT_CITY = {
  name: 'Riverton',
  district: 'Canal / 7th',
  sensor: 'SNS-0412',
  sensorPos: 'Canal / 7th',
  year: new Date().getUTCFullYear(),
};

function DashboardApp({ deviceId }: { deviceId: string | null }) {
  const tweaks = useTweaks();
  const { spectroColor, dbThreshold, anomalySensitivity } = tweaks;

  // Demo bundle (synthetic /api/year) — only loaded when not in real mode.
  const [bundle, setBundle] = useState<YearBundle | null>(null);
  // Real-mode dashboard data, fetched in parallel from the rollup endpoints.
  const [realDays, setRealDays] = useState<Day[] | null>(null);
  const [realAnomalies, setRealAnomalies] = useState<Anomaly[] | null>(null);
  const [realForecast, setRealForecast] = useState<ForecastPoint[] | null>(null);
  const [realSources, setRealSources] = useState<Source[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (deviceId) return;
    fetchYear()
      .then(setBundle)
      .catch((e: Error) => setError(e.message));
  }, [deviceId]);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    const now = Math.floor(Date.now() / 1000);
    const from = now - YEAR_WINDOW_S;
    // Fire all four in parallel. A failure on one panel must not block the
    // others — we keep the unfilled slots as empty arrays so the dashboard
    // still renders.
    fetchDailySummary(deviceId, from, now, dbThreshold)
      .then((r) => { if (!cancelled) setRealDays(summaryToDays(r)); })
      .catch(() => { if (!cancelled) setRealDays([]); });
    fetchAnomaliesRange(deviceId, from, now, anomalySensitivity)
      .then((r) => { if (!cancelled) setRealAnomalies(anomaliesToUi(r)); })
      .catch(() => { if (!cancelled) setRealAnomalies([]); });
    fetchDeviceForecast(deviceId, 7, dbThreshold)
      .then((r) => { if (!cancelled) setRealForecast(forecastToUi(r)); })
      .catch(() => { if (!cancelled) setRealForecast([]); });
    fetchDeviceSources(deviceId, from, now)
      .then((r) => { if (!cancelled) setRealSources(sourcesToUi(r)); })
      .catch(() => { if (!cancelled) setRealSources([]); });
    return () => { cancelled = true; };
    // Refetch when the dB threshold changes — it controls breach counting on
    // the server side. Anomaly sensitivity also changes the z-filter cutoff.
  }, [deviceId, dbThreshold, anomalySensitivity]);

  // When wired to a real device, fetch its metadata so the TopBar and footer
  // show the real sensor name/location instead of the synthetic city defaults.
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  useEffect(() => {
    if (!deviceId) return;
    fetchDevice(deviceId)
      .then(setDevice)
      .catch(() => { /* fall back to synthetic city.sensor */ });
  }, [deviceId]);

  const [drillState, setDrillState] = useState<DrillState>(() => {
    try {
      const saved = localStorage.getItem('drillState');
      return saved ? JSON.parse(saved) : { month: null, dayKey: null, hour: null };
    } catch { return { month: null, dayKey: null, hour: null }; }
  });
  useEffect(() => { try { localStorage.setItem('drillState', JSON.stringify(drillState)); } catch { /* ignore */ } }, [drillState]);

  const [flow, setFlow] = useState<FlowKey>(() => (localStorage.getItem('drillFlow') as FlowKey) || 'breadcrumb');
  useEffect(() => { try { localStorage.setItem('drillFlow', flow); } catch { /* ignore */ } }, [flow]);

  const [page, setPage] = useState<PageKey>(() => {
    const saved = localStorage.getItem('page');
    return saved === 'live' || saved === 'dashboard' || saved === 'health' ? saved : 'dashboard';
  });
  useEffect(() => { try { localStorage.setItem('page', page); } catch { /* ignore */ } }, [page]);

  const [settingsOpen, setSettingsOpen] = useState(false);

  // Demo-mode data, fully derived from the synthetic bundle.
  const demoMonths = useMemo<MonthHydrated[]>(
    () => (bundle ? hydrateMonths(bundle) : []),
    [bundle],
  );
  const demoAnomalies = useMemo<Anomaly[]>(
    () => (bundle ? bundle.anomalies.filter((a) => a.z >= anomalySensitivity) : []),
    [bundle, anomalySensitivity],
  );

  // Real-mode data; the four endpoint adapters are the source of truth.
  const realMonths = useMemo<MonthHydrated[]>(
    () => (realDays ? daysToMonths(realDays) : []),
    [realDays],
  );
  const realPeakHours = useMemo<number[]>(
    () => (realDays ? peakHoursFromDays(realDays) : []),
    [realDays],
  );

  const handleAnomalyClick = useCallback((a: Anomaly) => {
    const d = new Date(a.date + 'T00:00:00');
    setDrillState({ month: d.getMonth(), dayKey: a.key, hour: a.hour });
  }, []);

  // Decide what to render. Real mode waits for the summary (the spine of
  // every panel); the others fall back to empty arrays after their own
  // fetch failure.
  const ready = deviceId ? realDays != null : bundle != null;

  if (error && !deviceId) {
    return (
      <div style={{ padding: 40, color: 'var(--ink-1)', fontFamily: 'var(--mono)' }}>
        Failed to load year data: {error}
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--ink-3)' }}>
          Is the backend running on port 8000? Try `docker compose up`.
        </div>
      </div>
    );
  }
  if (!ready) {
    return (
      <div style={{ padding: 40, color: 'var(--ink-2)', fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: '0.1em' }}>
        LOADING YEAR DATA…
      </div>
    );
  }

  const city = bundle?.city ?? DEFAULT_CITY;
  const days: Day[] = deviceId ? (realDays ?? []) : (bundle?.days ?? []);
  const months: MonthHydrated[] = deviceId ? realMonths : demoMonths;
  const anomalies: Anomaly[] = deviceId
    ? (realAnomalies ?? [])
    : (bundle?.anomalies ?? []);
  const visibleAnomalies = deviceId
    ? anomalies.filter((a) => a.z >= anomalySensitivity)
    : demoAnomalies;
  const forecast: ForecastPoint[] = deviceId
    ? (realForecast ?? [])
    : (bundle?.forecast ?? []);
  const peakHours: number[] = deviceId
    ? realPeakHours
    : (bundle?.peakHours ?? []);
  const sources: Source[] = deviceId
    ? (realSources ?? [])
    : (bundle?.sources ?? []);
  const DrillComp = flow === 'breadcrumb' ? DrillFlowBreadcrumb : flow === 'stacked' ? DrillFlowStacked : DrillFlowZoom;
  const sensor = device?.name ?? city.sensor;
  const sensorPos = device?.location ?? city.sensorPos;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar
        threshold={dbThreshold}
        page={page}
        onPageChange={setPage}
        onOpenSettings={() => setSettingsOpen(true)}
        sensor={sensor}
        sensorPos={sensorPos}
      />

      {page === 'live' ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {deviceId
            ? <RealLiveView deviceId={deviceId} threshold={dbThreshold} />
            : <LiveView threshold={dbThreshold} />}
        </div>
      ) : page === 'health' ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {deviceId ? <RealHealthView deviceId={deviceId} /> : <HealthView />}
        </div>
      ) : (
        <Fragment>
          <div style={{ padding: '0 22px' }}>
            <HeadlineStats year={days} threshold={dbThreshold} sensitivity={anomalySensitivity} anomaliesCount={visibleAnomalies.length} />
          </div>

          <div style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: '380px 1fr 300px',
            gap: 14,
            padding: 14,
            minHeight: 0,
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
              {deviceId
                ? <RealNowCard deviceId={deviceId} threshold={dbThreshold} />
                : <NowCard palette={spectroColor} />}
              <Card
                title="ANOMALIES FEED"
                subtitle={`${visibleAnomalies.length} events · past 365 days`}
                right={<Pill tone="hot" icon>LIVE</Pill>}
                padding={0}
              >
                <div style={{ padding: '0 14px', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <AnomaliesFeed anomalies={visibleAnomalies} sensitivity={anomalySensitivity}
                    onSelect={handleAnomalyClick} focusKey={drillState.dayKey} />
                </div>
              </Card>
            </div>

            <Card
              title="DRILL · YEAR → HOUR → SPECTROGRAM"
              right={
                <div style={{ display: 'flex', gap: 4 }}>
                  {([['breadcrumb', 'Crumbs'], ['stacked', 'Stacked'], ['zoom', 'Zoom']] as const).map(([k, lbl]) => (
                    <div key={k} onClick={() => setFlow(k)} style={{
                      padding: '3px 8px',
                      fontSize: 10,
                      fontFamily: 'var(--mono)',
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                      background: flow === k ? 'var(--bg-3)' : 'var(--bg-2)',
                      border: `1px solid ${flow === k ? 'var(--line-strong)' : 'var(--line)'}`,
                      borderRadius: 4,
                      color: flow === k ? 'var(--ink-0)' : 'var(--ink-2)',
                      cursor: 'pointer',
                    }}>{lbl}</div>
                  ))}
                </div>
              }
            >
              <DrillComp state={drillState} setState={setDrillState} threshold={dbThreshold}
                palette={spectroColor} months={months} yearDays={days} deviceId={deviceId} />
            </Card>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0, overflow: 'auto' }}>
              <Card title="7-DAY FORECAST" padding={14}
                right={<Pill tone="cool" icon>MODEL v3</Pill>}>
                <ForecastPanel forecast={forecast} threshold={dbThreshold} />
                <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 10, lineHeight: 1.5 }}>
                  Weekly seasonality + event calendar. Shaded band = 95% CI.
                </div>
              </Card>

              <Card title="PEAK HOURS" subtitle="mean dB by hour-of-day · 2025" padding={14}>
                <PeakHoursChart hours={peakHours} />
              </Card>

              <Card title="BREACH RIBBON" subtitle="hrs ≥ threshold / day" padding={14}>
                <BreachRibbon days={days} threshold={dbThreshold} />
              </Card>

              <Card title="PROBABLE SOURCES" padding={14}>
                <SourceBreakdown sources={sources} />
              </Card>

              <Card title="LEGEND" padding={14}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div>
                    <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em', marginBottom: 4 }}>SPECTROGRAM · {PALETTES[spectroColor]?.label}</div>
                    <div style={{ height: 10, borderRadius: 2, background: PALETTES[spectroColor]?.css }} />
                    <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--ink-3)', marginTop: 3 }}>
                      <span>quiet</span><span>loud</span>
                    </div>
                  </div>
                  <div>
                    <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em', marginBottom: 4 }}>DB SEVERITY</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <Pill tone="default">&lt; {dbThreshold - 18}</Pill>
                      <Pill>{dbThreshold - 18}–{dbThreshold - 8}</Pill>
                      <Pill tone="warn" icon>{dbThreshold - 8}–{dbThreshold}</Pill>
                      <Pill tone="hot" icon>≥ {dbThreshold}</Pill>
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          </div>

          <div style={{
            padding: '8px 22px',
            borderTop: '1px solid var(--line)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--ink-3)', letterSpacing: '0.1em',
          }}>
            <span>{city.name.toUpperCase()} ACOUSTIC MONITORING · {sensor} · {sensorPos.toUpperCase()}</span>
            <span>DATA: {anomalies.length} anomalies · {forecast.length}-day forecast · ISO 1996-1 METHOD</span>
          </div>
        </Fragment>
      )}

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}


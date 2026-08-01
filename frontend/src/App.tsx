import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAnomaliesRange,
  fetchDailySummary,
  fetchDevice,
  fetchDeviceForecast,
  fetchDeviceSources,
  fetchPreviewAnomalies,
  fetchPreviewDailySummary,
  fetchPreviewForecast,
  fetchPreviewSources,
  fetchRuntimeConfig,
  fetchTelemetry,
  liveDeviceSocket,
  previewLiveSocket,
} from './api';
import { useAuth, useHasPermission } from './auth';
import { Card, Crumb, LiveDot, Pill, StatBig } from './atoms';
import { Clock, UserChip } from './chrome';
import { CameraSnapshot, useNearestCamera } from './cameras';
import { CandidateLabelingDashboard } from './candidate_labeling';
import { LoginPage } from './login_page';
import { PERM, hasPermission } from './permissions';
import {
  anomaliesToUi,
  daysToMonths,
  forecastToUi,
  peakHoursFromDays,
  sourcesToUi,
  summaryToDays,
} from './dashboard_adapter';
import { RealDayView } from './dayview';
import { DayView, HourView, MonthView, YearHeatmap, YearView } from './drills';
import { RealHealthView } from './health';
import { RealLiveView } from './live';
import { PALETTES } from './palettes';
import { AnomaliesFeed, BreachRibbon, ForecastPanel, PeakHoursChart, SourceBreakdown } from './panels';
import { SettingsButton, SettingsDialog } from './settings';
import { StationListView, isDeviceOnline } from './stations';
import {
  LiveSpectrogram,
  TimelineSpectrogram,
  useRollingBands,
} from './spectrogram';
import { useTweaks } from './tweaks';
import { formatHour } from './utils';
import type {
  Anomaly, Day, DeviceInfo, DeviceLiveMessage,
  DrillState, ForecastPoint, MonthHydrated, Source,
} from './types';

// Sentinel device id used to drive the guest preview flow. The backend's
// preview routes don't actually key off this — they emit one synthetic
// device's worth of data — but threading a stable string here lets the
// existing deviceId-keyed effects keep their dependency arrays intact.
const PREVIEW_DEVICE_ID = '00000000-0000-0000-0000-000000000000';

type DataMode = 'preview' | 'real';

type PageKey = 'live' | 'dashboard' | 'health' | 'labeling';

function TopBar({
  threshold, page, onPageChange, onOpenSettings, device, onBack,
}: {
  threshold: number;
  page: PageKey;
  onPageChange: (p: PageKey) => void;
  onOpenSettings: () => void;
  device: DeviceInfo | null;
  onBack?: () => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 22px',
      borderBottom: '1px solid var(--line)',
      background: 'var(--bg-0)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div
          onClick={onBack}
          title={onBack ? 'Back to station map' : undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: onBack ? 'pointer' : 'default',
            padding: '4px 8px',
            margin: '-4px -8px',
            borderRadius: 6,
            transition: 'background 120ms',
          }}
          onMouseEnter={(e) => {
            if (onBack) e.currentTarget.style.background = 'var(--bg-2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <rect x="2" y="9" width="2" height="4" fill="var(--neon-cool)" />
            <rect x="5" y="6" width="2" height="10" fill="var(--neon-cool)" />
            <rect x="8" y="3" width="2" height="16" fill="var(--neon-hot)" />
            <rect x="11" y="7" width="2" height="8" fill="var(--neon-warn)" />
            <rect x="14" y="5" width="2" height="12" fill="var(--neon-cool)" />
            <rect x="17" y="8" width="2" height="6" fill="var(--neon-cool)" />
          </svg>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>{device?.name ?? '—'}</div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
              Urban Acoustics · v0.1
            </div>
          </div>
        </div>
        <div style={{ width: 1, height: 28, background: 'var(--line)', marginLeft: 6 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isDeviceOnline(device) ? (
            <LiveDot />
          ) : (
            <span
              title="Sensor offline · no recent telemetry"
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                background: 'oklch(50% 0.02 60)',
                display: 'inline-block',
              }}
            />
          )}
          <div>
            <div className="mono" style={{ fontSize: 11, color: device?.location ? 'var(--ink-1)' : 'var(--ink-3)' }}>
              {device?.location ?? '— unconfigured —'}
            </div>
            <div className="mono" style={{ fontSize: 9, color: isDeviceOnline(device) ? 'var(--ink-3)' : 'oklch(78% 0.13 50)' }}>
              {isDeviceOnline(device) ? 'STREAMING · 48 kHz · A-weighted' : 'OFFLINE · NO TELEMETRY'}
            </div>
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
        <Clock />
        <SettingsButton onClick={onOpenSettings} />
        <UserChip />
      </div>
    </div>
  );
}

function PreviewNowCard({ onOpenLive }: { onOpenLive: () => void }) {
  // Drives the dashboard "live tile" for guest preview. Connects to the
  // procedural mock WS — same {type:"tick"|"spect"} envelope the real
  // device WS uses, so the spectrogram band-buffer code below is shared.
  const { spectroColor } = useTweaks();
  const spectRing = useRollingBands(240);
  const spectPushRef = useRef(spectRing.push);
  useEffect(() => { spectPushRef.current = spectRing.push; }, [spectRing.push]);
  const [laeq, setLaeq] = useState<number | null>(null);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    try { ws = previewLiveSocket(); } catch { return; }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as DeviceLiveMessage;
        if (msg.type === 'tick') setLaeq(msg.laeq);
        else if (msg.type === 'spect') spectPushRef.current(msg.ts, msg.bands);
      } catch { /* ignore */ }
    };
    ws.onclose = () => { /* preview mode — re-open is handled by remount */ };
    return () => { closed = true; try { ws?.close(); } catch { /* */ } void closed; };
  }, []);

  return (
    <Card title="LIVE · PREVIEW" right={<Pill tone="cool" icon>SIMULATED</Pill>} padding={14}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <div>
          <div className="mono" style={{ fontSize: 40, letterSpacing: '-0.03em', color: 'var(--ink-0)', lineHeight: 1 }}>
            {laeq != null ? laeq.toFixed(1) : '—'}
          </div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>dB(A) · L<sub>eq</sub></div>
        </div>
        <div
          onClick={onOpenLive}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenLive(); } }}
          title="Open Live view"
          style={{ flex: 1, height: 70, borderRadius: 4, overflow: 'hidden', cursor: 'pointer' }}
        >
          <LiveSpectrogram ring={spectRing} palette={spectroColor} height={70} />
        </div>
      </div>
    </Card>
  );
}

function PreviewLiveView({ threshold: _threshold }: { threshold: number }) {
  // Full-width preview of the live spectrogram + dB needle. 90-second
  // procedural loop; same data the dashboard "live tile" gets.
  const { spectroColor } = useTweaks();
  const spectRing = useRollingBands(1200);
  const spectPushRef = useRef(spectRing.push);
  useEffect(() => { spectPushRef.current = spectRing.push; }, [spectRing.push]);
  const [tick, setTick] = useState<{ laeq: number; lafmax: number } | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    try { ws = previewLiveSocket(); } catch { return; }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as DeviceLiveMessage;
        if (msg.type === 'tick') setTick({ laeq: msg.laeq, lafmax: msg.lafmax });
        else if (msg.type === 'spect') spectPushRef.current(msg.ts, msg.bands);
      } catch { /* ignore */ }
    };
    return () => { try { ws?.close(); } catch { /* */ } };
  }, []);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 14, gap: 14 }}>
      <div style={{
        padding: '10px 14px',
        background: 'var(--bg-2)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: 'var(--ink-2)',
        letterSpacing: '0.06em',
      }}>
        PREVIEW MODE · simulated data on a 90-second loop · ask an admin for member access to see real device telemetry
      </div>
      <Card padding={14}>
        <div style={{ display: 'flex', gap: 22, alignItems: 'center', marginBottom: 12 }}>
          <div>
            <div className="mono" style={{ fontSize: 56, letterSpacing: '-0.03em', color: 'var(--ink-0)', lineHeight: 1 }}>
              {tick ? tick.laeq.toFixed(1) : '—'}
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
              dB(A) · L<sub>eq</sub>  ·  peak {tick ? tick.lafmax.toFixed(1) : '—'}
            </div>
          </div>
        </div>
        <div style={{ height: 240, borderRadius: 4, overflow: 'hidden' }}>
          <LiveSpectrogram ring={spectRing} palette={spectroColor} height={240} />
        </div>
      </Card>
    </div>
  );
}

function PreviewHealthPlaceholder() {
  return (
    <div style={{
      flex: 1,
      display: 'grid',
      placeItems: 'center',
      color: 'var(--ink-2)',
      fontFamily: 'var(--mono)',
      fontSize: 12,
      letterSpacing: '0.1em',
      padding: 40,
      textAlign: 'center',
    }}>
      <div>
        DEVICE HEALTH IS HIDDEN IN PREVIEW MODE.
        <div style={{ marginTop: 8, color: 'var(--ink-3)', fontSize: 11 }}>
          Sign in as a member or higher to see real device telemetry.
        </div>
      </div>
    </div>
  );
}

const NOW_CARD_WINDOW_S = 15 * 60;
// Compact spectrogram window for the dashboard card. ~20 s at the wire rate
// (~12 Hz) so each column is wide enough to read at the smaller height.
const NOW_CARD_SPECT_FRAMES = 240;

function RealNowCard({ deviceId, threshold, onOpenLive }: { deviceId: string; threshold: number; onOpenLive: () => void }) {
  const { spectroColor } = useTweaks();
  const { camera: nearbyCamera } = useNearestCamera(deviceId);
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
          <div
            onClick={onOpenLive}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenLive(); } }}
            title="Open Live view"
            style={{ flex: 1, position: 'relative', cursor: 'pointer' }}
          >
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
        {nearbyCamera && (
          <CameraSnapshot camera={nearbyCamera} size="panel" openOnClick />
        )}
      </div>
    </Card>
  );
}

function HeadlineStats({
  year, threshold, sensitivity, anomaliesCount,
}: {
  year: Day[]; threshold: number; sensitivity: number; anomaliesCount: number;
}) {
  const { timeFormat } = useTweaks();
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
      <StatBig label="Modal peak hour"    value={formatHour(modalPeak, timeFormat)} delta="weekday rush + nightlife bleed" />
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

function DrillFlow({ state, setState, threshold, palette, months, yearDays, deviceId = null }: DrillProps) {
  const { timeFormat } = useTweaks();
  const { month, dayKey, hour } = state;
  const monthObj = month != null ? months.find((m) => m.index === month) ?? null : null;
  const dayObj = dayKey ? yearDays.find((d) => d.key === dayKey) ?? null : null;
  const level = month == null ? 0 : !dayKey ? 1 : hour == null ? 2 : 3;
  const [animKey, setAnimKey] = useState(0);
  useEffect(() => { setAnimKey((k) => k + 1); }, [level]);

  const yearLabel = (() => {
    if (monthObj && monthObj.days.length > 0) {
      return monthObj.days[monthObj.days.length - 1].date.slice(0, 4);
    }
    if (yearDays.length === 0) return String(new Date().getFullYear());
    const first = yearDays[0].date.slice(0, 4);
    const last = yearDays[yearDays.length - 1].date.slice(0, 4);
    return first === last ? first : `${first}/${last.slice(2)}`;
  })();

  const crumbs = [
    { label: yearLabel, upper: true, mono: true },
    { label: monthObj ? monthObj.name : '—', upper: true },
    { label: dayObj ? new Date(dayObj.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—', mono: true },
    { label: hour != null ? formatHour(hour, timeFormat) : '—', mono: true },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {(['YEAR', 'MONTH', 'DAY'] as const).map((lbl, i) => {
          const chipLevel = Math.min(level, 2);
          return (
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
                background: i === chipLevel ? 'var(--neon-focus)' : i < chipLevel ? 'var(--bg-3)' : 'var(--bg-2)',
                color: i === chipLevel ? '#0a0a0a' : i < chipLevel ? 'var(--ink-0)' : 'var(--ink-3)',
                cursor: i <= chipLevel ? 'pointer' : 'default',
                border: '1px solid var(--line)',
                transition: 'all 200ms',
              }}
            >
              {lbl}
            </div>
            {i < 2 && <div style={{ flex: i < chipLevel ? 0.2 : 1, height: 1, background: i < chipLevel ? 'var(--neon-focus)' : 'var(--line)', transition: 'all 300ms' }} />}
          </Fragment>
          );
        })}
      </div>
      <div key={animKey} style={{
        flex: 1, minHeight: 0, overflow: 'auto',
        animation: 'zoom-in 380ms cubic-bezier(.2,.8,.2,1)',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
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
          <MonthView month={monthObj} months={months} threshold={threshold}
            onPick={(d) => setState({ ...state, dayKey: d.key })}
            onPickMonth={(m) => setState({ ...state, month: m, dayKey: null, hour: null })} />
        )}
        {dayObj && hour == null && (
          deviceId ? (
            <RealDayView
              day={dayObj}
              deviceId={deviceId}
              threshold={threshold}
              palette={palette}
            />
          ) : (
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
          )
        )}
        {dayObj && hour != null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div>
                <div style={{ fontSize: 16 }}>
                  {new Date(dayObj.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · {formatHour(hour, timeFormat)}
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

// The station map is the entry point: a user lands on the pilot-corridor
// map and selects which station's dashboard to drill into. Demo mode (no
// real backend devices) bypasses the map and renders the synthetic
// /api/year dashboard directly — there's nothing to pick when the only
// "device" is the bundle.

// Browser navigation is hand-rolled (no router dep). The URL is the source
// of truth for which station / page / drill the user is on, so the back
// and forward buttons "just work" and links are shareable. localStorage
// mirrors it so a bare-URL visit restores the last view.
const DEFAULT_DRILL: DrillState = { month: null, dayKey: null, hour: null };
const NAV_KEY = 'navState';

type NavState = {
  deviceId: string | null;
  page: PageKey;
  drill: DrillState;
};

function isPageKey(p: unknown): p is PageKey {
  return p === 'live' || p === 'dashboard' || p === 'health' || p === 'labeling';
}

function navFromUrl(): NavState {
  const p = new URLSearchParams(window.location.search);
  const month = p.get('month');
  const hour = p.get('hour');
  const pageParam = p.get('page');
  return {
    deviceId: p.get('device') || null,
    page: isPageKey(pageParam) ? pageParam : 'dashboard',
    drill: {
      month: month != null && month !== '' ? Number(month) : null,
      dayKey: p.get('day') || null,
      hour: hour != null && hour !== '' ? Number(hour) : null,
    },
  };
}

function navToSearch(s: NavState): string {
  const p = new URLSearchParams();
  if (s.deviceId) p.set('device', s.deviceId);
  if (s.page !== 'dashboard') p.set('page', s.page);
  if (s.drill.month != null) p.set('month', String(s.drill.month));
  if (s.drill.dayKey) p.set('day', s.drill.dayKey);
  if (s.drill.hour != null) p.set('hour', String(s.drill.hour));
  return p.toString();
}

function isEmptyNav(s: NavState): boolean {
  return !s.deviceId && s.page === 'dashboard'
    && s.drill.month == null && !s.drill.dayKey && s.drill.hour == null;
}

function sameNav(a: NavState, b: NavState): boolean {
  return a.deviceId === b.deviceId && a.page === b.page
    && a.drill.month === b.drill.month
    && a.drill.dayKey === b.drill.dayKey
    && a.drill.hour === b.drill.hour;
}

function loadStoredNav(): NavState | null {
  try {
    const raw = localStorage.getItem(NAV_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    return {
      deviceId: typeof j.deviceId === 'string' ? j.deviceId : null,
      page: isPageKey(j.page) ? j.page : 'dashboard',
      drill: {
        month: typeof j?.drill?.month === 'number' ? j.drill.month : null,
        dayKey: typeof j?.drill?.dayKey === 'string' ? j.drill.dayKey : null,
        hour: typeof j?.drill?.hour === 'number' ? j.drill.hour : null,
      },
    };
  } catch { return null; }
}

function applyToUrl(s: NavState, mode: 'push' | 'replace') {
  const search = navToSearch(s);
  const url = search ? `?${search}` : window.location.pathname;
  if (mode === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

function persistNav(s: NavState) {
  try { localStorage.setItem(NAV_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

function useNavState(): [NavState, (next: Partial<NavState>) => void] {
  const [state, setState] = useState<NavState>(() => {
    const fromUrl = navFromUrl();
    // Bare URL → restore from localStorage and rewrite (replace, not push,
    // so the back button doesn't land on a stale empty entry).
    if (isEmptyNav(fromUrl)) {
      const stored = loadStoredNav();
      if (stored && !isEmptyNav(stored)) {
        applyToUrl(stored, 'replace');
        return stored;
      }
    }
    return fromUrl;
  });

  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  useEffect(() => {
    const onPop = () => {
      const next = navFromUrl();
      setState(next);
      persistNav(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next: Partial<NavState>) => {
    const cur = stateRef.current;
    const merged: NavState = {
      deviceId: next.deviceId !== undefined ? next.deviceId : cur.deviceId,
      page: next.page !== undefined ? next.page : cur.page,
      drill: next.drill !== undefined ? next.drill : cur.drill,
    };
    if (sameNav(merged, cur)) return;
    setState(merged);
    persistNav(merged);
    applyToUrl(merged, 'push');
  }, []);

  return [state, navigate];
}

export function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: '0.1em' }}>
        LOADING…
      </div>
    );
  }
  if (!user) return <LoginPage />;

  const role = user.role;
  const isGuest = role === 'guest';
  const canViewReal = hasPermission(role, PERM.DASHBOARD_VIEW);

  return <AuthedApp mode={isGuest ? 'preview' : (canViewReal ? 'real' : 'preview')} />;
}

function AuthedApp({ mode }: { mode: DataMode }) {
  const [nav, navigate] = useNavState();
  const canManageCandidates = useHasPermission(PERM.EVENT_CANDIDATE_MANAGE);

  const onPageChange = useCallback((p: PageKey) => navigate({ page: p }), [navigate]);
  const onDrillStateChange = useCallback((d: DrillState) => navigate({ drill: d }), [navigate]);

  if (nav.page === 'labeling' && canManageCandidates) {
    return (
      <CandidateLabelingDashboard
        onBack={() => navigate({ deviceId: null, page: 'dashboard', drill: DEFAULT_DRILL })}
      />
    );
  }

  // Guest preview always renders a single synthetic "device" with no
  // station picker. Member+ goes through the station list to pick a real
  // device before the dashboard mounts.
  if (mode === 'preview') {
    return (
      <DashboardApp
        deviceId={PREVIEW_DEVICE_ID}
        mode="preview"
        page={nav.page}
        onPageChange={onPageChange}
        drillState={nav.drill}
        onDrillStateChange={onDrillStateChange}
      />
    );
  }

  if (nav.deviceId == null) {
    return (
      <StationListView
        onPick={(d) => navigate({ deviceId: d.device_id, page: 'dashboard', drill: DEFAULT_DRILL })}
        onPickLive={(d) => navigate({ deviceId: d.device_id, page: 'live', drill: DEFAULT_DRILL })}
        onOpenLabeling={canManageCandidates
          ? () => navigate({ deviceId: null, page: 'labeling', drill: DEFAULT_DRILL })
          : undefined}
      />
    );
  }

  return (
    <DashboardApp
      deviceId={nav.deviceId}
      mode="real"
      onBack={() => navigate({ deviceId: null, page: 'dashboard', drill: DEFAULT_DRILL })}
      page={nav.page}
      onPageChange={onPageChange}
      drillState={nav.drill}
      onDrillStateChange={onDrillStateChange}
    />
  );
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

// Bootstrap default — matches raspberry-pi-zero-2w/urban_acoustics/config.py
// (event_threshold_db: 80.0). The dashboard reads the device's actual value
// from the runtime-config endpoint and overwrites this; this constant just
// avoids a 0-dB flash on initial render.
const DEFAULT_DB_THRESHOLD = 80;

function DashboardApp({
  deviceId,
  mode,
  onBack,
  page,
  onPageChange,
  drillState,
  onDrillStateChange,
}: {
  deviceId: string | null;
  mode: DataMode;
  onBack?: () => void;
  page: PageKey;
  onPageChange: (p: PageKey) => void;
  drillState: DrillState;
  onDrillStateChange: (d: DrillState) => void;
}) {
  const isPreview = mode === 'preview';
  const tweaks = useTweaks();
  const { spectroColor, anomalySensitivity } = tweaks;

  // The threshold is per-device, persisted server-side, and pushed to the
  // Pi over MQTT — see frontend/src/settings.tsx for the slider that PUTs
  // to /api/v1/devices/{id}/runtime-config. We keep the variable name
  // ``dbThreshold`` so the ~20 consumers below stay untouched.
  const [dbThreshold, setDbThreshold] = useState<number>(DEFAULT_DB_THRESHOLD);
  const [devicePaused, setDevicePaused] = useState<boolean>(false);
  const [appliedConfigVersion, setAppliedConfigVersion] = useState<string | null>(null);
  useEffect(() => {
    // Preview mode has no real device, so no runtime config to fetch.
    if (!deviceId || isPreview) return;
    let cancelled = false;
    fetchRuntimeConfig(deviceId)
      .then((r) => {
        if (cancelled) return;
        if (r.event_threshold_db !== null) setDbThreshold(r.event_threshold_db);
        setDevicePaused(r.paused);
        setAppliedConfigVersion(r.applied_config_version);
      })
      .catch(() => { /* keep default; UI still renders */ });
    return () => { cancelled = true; };
  }, [deviceId, isPreview]);

  // Dashboard data — the four rollup endpoints, fetched in parallel. In
  // preview mode they come from /api/v1/preview/* (procedural mock with a
  // fixed seed); in real mode from /api/v1/devices/{id}/* (the device).
  const [realDays, setRealDays] = useState<Day[] | null>(null);
  const [realAnomalies, setRealAnomalies] = useState<Anomaly[] | null>(null);
  const [realForecast, setRealForecast] = useState<ForecastPoint[] | null>(null);
  const [realSources, setRealSources] = useState<Source[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    const now = Math.floor(Date.now() / 1000);
    const from = now - YEAR_WINDOW_S;
    // Fire all four in parallel. A failure on one panel must not block the
    // others — we keep the unfilled slots as empty arrays so the dashboard
    // still renders.
    const summaryP = isPreview
      ? fetchPreviewDailySummary()
      : fetchDailySummary(deviceId, from, now, dbThreshold);
    const anomaliesP = isPreview
      ? fetchPreviewAnomalies()
      : fetchAnomaliesRange(deviceId, from, now, anomalySensitivity);
    const forecastP = isPreview
      ? fetchPreviewForecast()
      : fetchDeviceForecast(deviceId, 7, dbThreshold);
    const sourcesP = isPreview
      ? fetchPreviewSources()
      : fetchDeviceSources(deviceId, from, now);

    summaryP
      .then((r) => { if (!cancelled) setRealDays(summaryToDays(r)); })
      .catch(() => { if (!cancelled) setRealDays([]); });
    anomaliesP
      .then((r) => { if (!cancelled) setRealAnomalies(anomaliesToUi(r)); })
      .catch(() => { if (!cancelled) setRealAnomalies([]); });
    forecastP
      .then((r) => { if (!cancelled) setRealForecast(forecastToUi(r)); })
      .catch(() => { if (!cancelled) setRealForecast([]); });
    sourcesP
      .then((r) => { if (!cancelled) setRealSources(sourcesToUi(r)); })
      .catch(() => { if (!cancelled) setRealSources([]); });
    return () => { cancelled = true; };
    // Refetch when the dB threshold changes — it controls breach counting on
    // the server side. Anomaly sensitivity also changes the z-filter cutoff.
  }, [deviceId, dbThreshold, anomalySensitivity, isPreview]);

  // When wired to a real device, fetch its metadata so the TopBar and footer
  // show the real sensor name/location instead of the synthetic city defaults.
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  useEffect(() => {
    if (!deviceId || isPreview) return;
    // Refetch on an interval so the online badge tracks last_seen as it ages.
    const load = () => {
      fetchDevice(deviceId)
        .then(setDevice)
        .catch(() => { /* fall back to synthetic city.sensor */ });
    };
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [deviceId, isPreview]);

  useEffect(() => {
    const name = device?.name ?? (isPreview ? 'Preview Mode' : DEFAULT_CITY.name);
    document.title = `Urban Acoustics · ${name}`;
  }, [device?.name, isPreview]);

  const [settingsOpen, setSettingsOpen] = useState(false);

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
    onDrillStateChange({ month: d.getMonth(), dayKey: a.key, hour: a.hour });
  }, [onDrillStateChange]);

  // Decide what to render. Real mode waits for the summary (the spine of
  // every panel); the others fall back to empty arrays after their own
  // fetch failure.
  const ready = realDays != null;

  if (!ready) {
    return (
      <div style={{ padding: 40, color: 'var(--ink-2)', fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: '0.1em' }}>
        LOADING YEAR DATA…
      </div>
    );
  }

  const city = DEFAULT_CITY;
  const days: Day[] = realDays ?? [];
  const months: MonthHydrated[] = realMonths;
  const anomalies: Anomaly[] = realAnomalies ?? [];
  const visibleAnomalies = anomalies.filter((a) => a.z >= anomalySensitivity);
  const forecast: ForecastPoint[] = realForecast ?? [];
  const peakHours: number[] = realPeakHours;
  const sources: Source[] = realSources ?? [];

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar
        threshold={dbThreshold}
        page={page}
        onPageChange={onPageChange}
        onOpenSettings={() => setSettingsOpen(true)}
        device={device}
        onBack={onBack}
      />

      {page === 'live' ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {isPreview
            ? <PreviewLiveView threshold={dbThreshold} />
            : <RealLiveView deviceId={deviceId!} threshold={dbThreshold} />}
        </div>
      ) : page === 'health' ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {isPreview ? <PreviewHealthPlaceholder /> : <RealHealthView deviceId={deviceId!} />}
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
              {isPreview
                ? <PreviewNowCard onOpenLive={() => onPageChange('live')} />
                : <RealNowCard deviceId={deviceId!} threshold={dbThreshold} onOpenLive={() => onPageChange('live')} />}
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

            <Card>
              <DrillFlow state={drillState} setState={onDrillStateChange} threshold={dbThreshold}
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

              <Card title="PEAK HOURS" subtitle="mean dB by hour-of-day · past 365 days" padding={14}>
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
            <span>{city.name.toUpperCase()} ACOUSTIC MONITORING · {device?.name ?? '—'} · {(device?.location ?? '—').toUpperCase()}</span>
            <span>DATA: {anomalies.length} anomalies · {forecast.length}-day forecast · ISO 1996-1 METHOD</span>
          </div>
        </Fragment>
      )}

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        deviceId={deviceId}
        deviceThreshold={dbThreshold}
        onDeviceThresholdChange={setDbThreshold}
        devicePaused={devicePaused}
        onDevicePausedChange={setDevicePaused}
        appliedConfigVersion={appliedConfigVersion}
      />
    </div>
  );
}

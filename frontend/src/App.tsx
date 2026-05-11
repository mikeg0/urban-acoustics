import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { fetchYear } from './api';
import { Card, Crumb, LiveDot, Pill, StatBig } from './atoms';
import { DayView, HourView, MonthView, YearHeatmap, YearView } from './drills';
import { LiveView } from './live';
import { PALETTES } from './palettes';
import { AnomaliesFeed, BreachRibbon, ForecastPanel, PeakHoursChart, SourceBreakdown } from './panels';
import { SettingsButton, SettingsDialog } from './settings';
import { buildSpectrogram, SpectrogramCanvas, TimelineSpectrogram } from './spectrogram';
import { useTweaks } from './tweaks';
import { hydrateMonths } from './utils';
import type { Anomaly, Day, DrillState, MonthHydrated, YearBundle } from './types';

type FlowKey = 'breadcrumb' | 'stacked' | 'zoom';

function TopBar({
  threshold, page, onPageChange, onOpenSettings, sensorPos, sensor,
}: {
  threshold: number;
  page: 'dashboard' | 'live';
  onPageChange: (p: 'dashboard' | 'live') => void;
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
          {(['dashboard', 'live'] as const).map((k) => (
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
              {k === 'live' ? 'Live' : 'Dashboard'}
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

function HeadlineStats({
  year, threshold, sensitivity, anomaliesCount,
}: {
  year: Day[]; threshold: number; sensitivity: number; anomaliesCount: number;
}) {
  const totalBreaches = year.reduce((a, d) => a + d.breaches, 0);
  const loudestDay = year.reduce((a, d) => (d.peak > a.peak ? d : a), year[0]);
  const peakHourCounts = new Array(24).fill(0);
  year.forEach((d) => { peakHourCounts[d.peakHour] += 1; });
  const modalPeak = peakHourCounts.indexOf(Math.max(...peakHourCounts));
  const meanDb = +(year.reduce((a, d) => a + d.mean, 0) / year.length).toFixed(1);
  const loudestDate = new Date(loudestDay.date + 'T00:00:00');

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14,
      padding: '16px 0', borderBottom: '1px solid var(--line)',
    }}>
      <StatBig label="Year avg"           value={meanDb}                     unit="dB" />
      <StatBig label="Threshold breaches" value={totalBreaches.toLocaleString()} unit={`hrs ≥ ${threshold}dB`} tone="hot" />
      <StatBig label="Loudest day"        value={loudestDay.peak.toFixed(1)} unit="dB"
        delta={loudestDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + (loudestDay.event ? ` · ${loudestDay.event}` : '')} />
      <StatBig label="Modal peak hour"    value={`${String(modalPeak).padStart(2, '0')}:00`} delta="weekday rush + nightlife bleed" />
      <StatBig label="Anomalies flagged"  value={anomaliesCount}             unit={`z≥${sensitivity.toFixed(1)}`} delta="past 365 days" />
    </div>
  );
}

interface DrillProps {
  state: DrillState;
  setState: (s: DrillState) => void;
  threshold: number;
  palette: keyof typeof PALETTES;
  months: MonthHydrated[];
  yearDays: Day[];
}

function DrillFlowBreadcrumb({ state, setState, threshold, palette, months, yearDays }: DrillProps) {
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
                showBars onHourClick={(h) => setState({ ...state, hour: h })} />
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
            <HourView day={dayObj} hour={hour} palette={palette} threshold={threshold} />
            <div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em', marginBottom: 6 }}>FULL DAY · 24h CONTEXT</div>
              <TimelineSpectrogram day={dayObj} palette={palette} threshold={threshold} hourFocus={hour}
                showBars onHourClick={(h) => setState({ ...state, hour: h })} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DrillFlowStacked(props: DrillProps) {
  const { state, setState, threshold, palette, months, yearDays } = props;
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
              showBars onHourClick={(h) => setState({ ...state, hour: h })} />
          </div>
        </Section>
      )}
      {dayObj && hour != null && (
        <Section title={`HOUR · ${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00 · SPECTROGRAM`}
          depth={3}
          right={<span className="mono" style={{ fontSize: 10, color: 'var(--neon-focus)' }}>deepest level</span>}>
          <HourView day={dayObj} hour={hour} palette={palette} threshold={threshold} />
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
  const tweaks = useTweaks();
  const { spectroColor, dbThreshold, anomalySensitivity } = tweaks;

  const [bundle, setBundle] = useState<YearBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchYear()
      .then(setBundle)
      .catch((e: Error) => setError(e.message));
  }, []);

  const [drillState, setDrillState] = useState<DrillState>(() => {
    try {
      const saved = localStorage.getItem('drillState');
      return saved ? JSON.parse(saved) : { month: null, dayKey: null, hour: null };
    } catch { return { month: null, dayKey: null, hour: null }; }
  });
  useEffect(() => { try { localStorage.setItem('drillState', JSON.stringify(drillState)); } catch { /* ignore */ } }, [drillState]);

  const [flow, setFlow] = useState<FlowKey>(() => (localStorage.getItem('drillFlow') as FlowKey) || 'breadcrumb');
  useEffect(() => { try { localStorage.setItem('drillFlow', flow); } catch { /* ignore */ } }, [flow]);

  const [page, setPage] = useState<'dashboard' | 'live'>(() => (localStorage.getItem('page') as 'dashboard' | 'live') || 'dashboard');
  useEffect(() => { try { localStorage.setItem('page', page); } catch { /* ignore */ } }, [page]);

  const [settingsOpen, setSettingsOpen] = useState(false);

  const months = useMemo<MonthHydrated[]>(() => bundle ? hydrateMonths(bundle) : [], [bundle]);
  const visibleAnomalies = useMemo<Anomaly[]>(
    () => bundle ? bundle.anomalies.filter((a) => a.z >= anomalySensitivity) : [],
    [bundle, anomalySensitivity],
  );

  const handleAnomalyClick = useCallback((a: Anomaly) => {
    const d = new Date(a.date + 'T00:00:00');
    setDrillState({ month: d.getMonth(), dayKey: a.key, hour: a.hour });
  }, []);

  if (error) {
    return (
      <div style={{ padding: 40, color: 'var(--ink-1)', fontFamily: 'var(--mono)' }}>
        Failed to load year data: {error}
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--ink-3)' }}>
          Is the backend running on port 8000? Try `docker compose up`.
        </div>
      </div>
    );
  }
  if (!bundle) {
    return (
      <div style={{ padding: 40, color: 'var(--ink-2)', fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: '0.1em' }}>
        LOADING YEAR DATA…
      </div>
    );
  }

  const { city, days, anomalies, forecast, peakHours, sources } = bundle;
  const DrillComp = flow === 'breadcrumb' ? DrillFlowBreadcrumb : flow === 'stacked' ? DrillFlowStacked : DrillFlowZoom;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar
        threshold={dbThreshold}
        page={page}
        onPageChange={setPage}
        onOpenSettings={() => setSettingsOpen(true)}
        sensor={city.sensor}
        sensorPos={city.sensorPos}
      />

      {page === 'live' ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <LiveView threshold={dbThreshold} />
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
              <NowCard palette={spectroColor} />
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
                palette={spectroColor} months={months} yearDays={days} />
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
            <span>{city.name.toUpperCase()} ACOUSTIC MONITORING · {city.sensor} · {city.sensorPos.toUpperCase()}</span>
            <span>DATA: {anomalies.length} anomalies · {forecast.length}-day forecast · ISO 1996-1 METHOD</span>
          </div>
        </Fragment>
      )}

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

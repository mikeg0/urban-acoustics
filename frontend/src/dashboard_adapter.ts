// Adapts the real-device rollup endpoints (DailySummary / Anomalies /
// Forecast / Sources) into the same UI shapes the synthetic /api/year
// bundle produces, so every existing dashboard component (YearView,
// MonthView, AnomaliesFeed, ForecastPanel, etc.) keeps working unchanged.

import type {
  AnomaliesResponse,
  Anomaly,
  DailySummaryResponse,
  Day,
  ForecastPoint,
  ForecastResponse,
  MonthHydrated,
  Source,
  SourcesResponse,
} from './types';

// Backend dow is 0=Mon..6=Sun (Python weekday()). Frontend Day.dow is the
// JS Date.getDay() convention: 0=Sun..6=Sat.
function pyDowToJs(pyDow: number): number {
  return (pyDow + 1) % 7;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const MONTH_SHORTS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
] as const;

// Fixed palette for source-classification slices — the design uses a
// hand-tuned set of oklch values; we mirror those and round-robin if more
// classes appear than colours.
const SOURCE_COLORS: readonly string[] = [
  'oklch(78% 0.18 35)',   // motorcycles / hot
  'oklch(70% 0.12 230)',  // cars / cool
  'oklch(75% 0.14 60)',   // construction / warn
  'oklch(78% 0.16 310)',  // sirens / focus
  'oklch(60% 0.04 180)',  // weather / neutral
  'oklch(70% 0.14 130)',  // dog / fresh
  'oklch(72% 0.13 280)',  // voice / violet
  'oklch(74% 0.10 90)',   // airplane / lime
  'oklch(66% 0.08 200)',  // helicopter / steel
  'oklch(60% 0.02 60)',   // other / mute
];

const SOURCE_LABELS: Record<string, string> = {
  motorcycle: 'Motorcycles',
  car: 'Cars',
  truck: 'Trucks',
  construction: 'Construction',
  helicopter: 'Helicopters',
  airplane: 'Airplanes',
  siren: 'Sirens',
  horn: 'Horns',
  dog: 'Dog',
  voice: 'Voice',
  'trash pickup': 'Trash pickup',
  wind: 'Wind',
  rain: 'Rain',
  thunder: 'Thunder',
  other: 'Other',
};

export function summaryToDays(resp: DailySummaryResponse): Day[] {
  return resp.days.map((d) => {
    // Fill `null` hours with the day mean so the existing UI (which expects
    // a fixed-length number[24]) renders the gap as a flat midline rather
    // than crashing. The `peak_hour` and `breaches` already come from real
    // data, so the visual fidelity is preserved where the data exists.
    const meanHours = d.hours.map((h) => (h == null ? d.mean : h));
    const dow = pyDowToJs(d.dow);
    return {
      key: d.date,
      date: d.date,
      dow,
      isWeekend: dow === 0 || dow === 6,
      hours: meanHours,
      peak: d.peak,
      peakHour: d.peak_hour,
      mean: d.mean,
      breaches: d.breaches,
      event: d.event ? (SOURCE_LABELS[d.event] ?? d.event) : null,
    };
  });
}

export function daysToMonths(days: Day[]): MonthHydrated[] {
  const byMonth = new Map<number, Day[]>();
  for (const d of days) {
    // dayKey is YYYY-MM-DD; parse the month directly to stay in UTC.
    const m = Number(d.date.slice(5, 7)) - 1;
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(d);
  }
  const months: MonthHydrated[] = [];
  for (let i = 0; i < 12; i += 1) {
    const ds = byMonth.get(i) ?? [];
    if (ds.length === 0) continue;
    const mean = ds.reduce((a, d) => a + d.mean, 0) / ds.length;
    const peak = ds.reduce((a, d) => Math.max(a, d.peak), 0);
    const breaches = ds.reduce((a, d) => a + d.breaches, 0);
    months.push({
      index: i,
      name: MONTH_NAMES[i],
      short: MONTH_SHORTS[i],
      mean,
      peak,
      breaches,
      days: ds,
    });
  }
  return months;
}

export function anomaliesToUi(resp: AnomaliesResponse): Anomaly[] {
  return resp.points.map((p) => ({
    key: p.event_id,
    date: p.day_key,
    hour: p.hour,
    db: p.peak_db,
    baselineDb: p.baseline_mean_db,
    deltaDb: p.delta_db,
    baselineN: p.baseline_n,
    z: p.z,
    rankScore: p.rank_score,
    event: p.classification
      ? (SOURCE_LABELS[p.classification] ?? p.classification)
      : null,
  }));
}

export function forecastToUi(resp: ForecastResponse): ForecastPoint[] {
  return resp.points.map((p) => ({
    date: p.date,
    dow: pyDowToJs(p.dow),
    mean: p.mean,
    peak: p.peak,
    low: p.low,
    high: p.high,
    peakHour: p.peak_hour,
  }));
}

export function sourcesToUi(resp: SourcesResponse): Source[] {
  return resp.sources.map((s, i) => ({
    name: SOURCE_LABELS[s.name] ?? s.name,
    pct: s.pct,
    color: SOURCE_COLORS[i % SOURCE_COLORS.length],
  }));
}

// Mean dB by hour-of-day across the full year, used by PeakHoursChart. Missing
// hour cells (sparse history) are skipped from the average rather than zeroed
// out so a low-data day doesn't drag the line to the floor.
export function peakHoursFromDays(days: Day[]): number[] {
  const sums = new Array<number>(24).fill(0);
  const counts = new Array<number>(24).fill(0);
  // We trust `hours` is length 24 (DailySummaryPoint enforces that
  // server-side). Days that came from the synthetic bundle also satisfy it.
  for (const d of days) {
    for (let h = 0; h < 24; h += 1) {
      const v = d.hours[h];
      if (v != null && Number.isFinite(v)) {
        sums[h] += v;
        counts[h] += 1;
      }
    }
  }
  return sums.map((s, h) => (counts[h] > 0 ? s / counts[h] : 0));
}

/** Mulberry32 PRNG — same algorithm as the Python backend, same seeds → same numbers. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normalize dB into [0, 1] over the typical 34..108 sensor range. */
export function normDb(db: number): number {
  return Math.max(0, Math.min(1, (db - 34) / (108 - 34)));
}

/** Re-hydrate the bulk year payload: months reference day-keys; turn them back into Day objects. */
import type { Day, Month, MonthHydrated, Tweaks, YearBundle } from './types';

export type TimeFormat = Tweaks['timeFormat'];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Format a unix-seconds timestamp as a clock string honoring the user's
 *  time-format preference. With `withDate`, prefixes "Mon d, ". */
export function formatClock(
  unixSec: number,
  format: TimeFormat,
  opts: { withSeconds?: boolean; withDate?: boolean } = {},
): string {
  const { withSeconds = false, withDate = false } = opts;
  const d = new Date(unixSec * 1000);
  const datePart = withDate
    ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', '
    : '';
  const sec = withSeconds ? `:${pad2(d.getSeconds())}` : '';
  if (format === '12h') {
    const h = d.getHours();
    const hh = h % 12 === 0 ? 12 : h % 12;
    const ap = h < 12 ? 'AM' : 'PM';
    return `${datePart}${hh}:${pad2(d.getMinutes())}${sec} ${ap}`;
  }
  return `${datePart}${pad2(d.getHours())}:${pad2(d.getMinutes())}${sec}`;
}

/** Format an hour-of-day integer (0..23) as a label.
 *  24h: "14:00" (or "14" when withMinutes=false).
 *  12h: "2:00 PM" (or "2 PM" when withMinutes=false). */
export function formatHour(
  h: number,
  format: TimeFormat,
  opts: { withMinutes?: boolean } = {},
): string {
  const { withMinutes = true } = opts;
  if (format === '12h') {
    const hh = h % 12 === 0 ? 12 : h % 12;
    const ap = h < 12 ? 'AM' : 'PM';
    return withMinutes ? `${hh}:00 ${ap}` : `${hh} ${ap}`;
  }
  return withMinutes ? `${pad2(h)}:00` : pad2(h);
}

/** Compact hour tick used on dense axes — "18" in 24h, "6pm" in 12h. */
export function formatHourTick(h: number, format: TimeFormat): string {
  if (format === '12h') {
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${hh}${h < 12 ? 'am' : 'pm'}`;
  }
  return pad2(h);
}

/** Hour-of-day range label: "14:00–15:00" in 24h, "2:00 PM–3:00 PM" in 12h. */
export function formatHourRange(h: number, format: TimeFormat): string {
  const next = (h + 1) % 24;
  return `${formatHour(h, format)}–${formatHour(next, format)}`;
}

export function hydrateMonths(bundle: YearBundle): MonthHydrated[] {
  const byKey = new Map<string, Day>(bundle.days.map((d) => [d.key, d]));
  return bundle.months.map((m: Month) => ({
    ...m,
    days: m.days.map((k) => byKey.get(k)).filter((d): d is Day => d != null),
  }));
}

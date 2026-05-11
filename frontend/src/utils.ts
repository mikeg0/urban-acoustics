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
import type { Day, Month, MonthHydrated, YearBundle } from './types';

export function hydrateMonths(bundle: YearBundle): MonthHydrated[] {
  const byKey = new Map<string, Day>(bundle.days.map((d) => [d.key, d]));
  return bundle.months.map((m: Month) => ({
    ...m,
    days: m.days.map((k) => byKey.get(k)).filter((d): d is Day => d != null),
  }));
}

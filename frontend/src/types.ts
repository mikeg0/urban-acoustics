export interface Day {
  key: string;
  date: string;
  dow: number;             // 0=Sun..6=Sat
  isWeekend: boolean;
  hours: number[];         // 24 dB readings
  peak: number;
  peakHour: number;
  mean: number;
  breaches: number;
  event: string | null;
}

export interface Month {
  index: number;
  name: string;
  short: string;
  days: string[];          // day keys (the bulk payload re-hydrates these)
  mean: number;
  peak: number;
  breaches: number;
}

/** Month with the day objects re-hydrated. Used by the UI. */
export interface MonthHydrated extends Omit<Month, 'days'> {
  days: Day[];
}

export interface Anomaly {
  key: string;
  date: string;
  hour: number;
  db: number;
  z: number;
  event: string | null;
}

export interface ForecastPoint {
  date: string;
  dow: number;
  mean: number;
  peak: number;
  low: number;
  high: number;
  peakHour: number;
}

export interface Source {
  name: string;
  pct: number;
  color: string;
}

export interface City {
  name: string;
  district: string;
  sensor: string;
  sensorPos: string;
  year: number;
}

export interface YearBundle {
  city: City;
  days: Day[];
  months: Month[];
  anomalies: Anomaly[];
  forecast: ForecastPoint[];
  peakHours: number[];
  sources: Source[];
}

export interface Gap {
  start: number;
  end: number;
  reason: string;
}

export type LiveMessage =
  | { type: 'snapshot'; date: string; now_min: number; minutes: (number | null)[]; gaps: Gap[]; tick_seconds: number }
  | { type: 'tick'; now_min: number; db: number | null };

export type DrillState = {
  month: number | null;
  dayKey: string | null;
  hour: number | null;
};

export type Tweaks = {
  spectroColor: 'heat' | 'ice' | 'mono' | 'neon';
  dbThreshold: number;
  anomalySensitivity: number;
};

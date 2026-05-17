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

// --- Phase 1 real-device contracts (mirror backend/app/contracts.py) ---------

export interface DeviceInfo {
  device_id: string;
  name: string | null;
  location: string | null;
  created_at: number;
  last_seen: number | null;
}

export type TelemetryResolution = 'raw' | '1m' | '1h';

export interface DeviceTelemetryPoint {
  ts: number;
  laeq: number;
  lafmax: number;
  lcpeak: number;
}

export interface TelemetryReadResponse {
  device_id: string;
  resolution: TelemetryResolution;
  from_ts: number;
  to_ts: number;
  points: DeviceTelemetryPoint[];
}

export interface SpectrogramFrameOut {
  ts: number;
  bands: number[];
}

export interface SpectrogramReadResponse {
  device_id: string;
  from_ts: number;
  to_ts: number;
  frames: SpectrogramFrameOut[];
}

export type DeviceEventStatus =
  | 'announced'
  | 'upload_intent_created'
  | 'uploaded'
  | 'available'
  | 'failed';

export type EventLabel =
  | 'motorcycle'
  | 'car'
  | 'construction'
  | 'helicopter'
  | 'airplane'
  | 'siren'
  | 'dog'
  | 'voice'
  | 'other';

export const EVENT_LABELS: readonly EventLabel[] = [
  'motorcycle',
  'car',
  'construction',
  'helicopter',
  'airplane',
  'siren',
  'dog',
  'voice',
  'other',
];

export interface DeviceEvent {
  event_id: string;
  device_id: string;
  ts: number;
  duration_s: number;
  peak_db: number;
  sha256: string;
  size: number;
  status: DeviceEventStatus;
  classification: string | null;
  confidence: number | null;
  model_version: string | null;
  playback_url: string | null;
  playback_url_expires_at: number | null;
}

export interface PlaybackUrl {
  event_id: string;
  url: string;
  expires_at: number;
}

export interface LabelSubmission {
  event_id: string;
  label: EventLabel;
  created_at: number;
}

export type DeviceLiveMessage =
  | {
      type: 'tick';
      ts: number;
      laeq: number;
      lafmax: number;
      lcpeak: number;
    }
  | {
      type: 'spect';
      ts: number;
      bands: number[];
    }
  | {
      type: 'ping';
      ts: number;
    };

// 1/3-octave ISO 266 nominal centre frequencies the firmware emits on
// dev/{id}/spect. Mirrors raspberry-pi-zero-2w/urban_acoustics/dsp.py::
// ISO_THIRD_OCTAVE_HZ and backend/app/contracts.py::SPECTROGRAM_N_BANDS.
export const BAND_CENTERS_HZ: readonly number[] = [
  20, 25, 31.5, 40, 50, 63, 80, 100,
  125, 160, 200, 250, 315, 400, 500, 630,
  800, 1000, 1250, 1600, 2000, 2500, 3150, 4000,
  5000, 6300, 8000, 10000, 12500, 16000,
];

export const SPECTROGRAM_N_BANDS = BAND_CENTERS_HZ.length;

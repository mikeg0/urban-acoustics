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
  anomalySensitivity: number;
  clipAutoPlay: boolean;
  timeFormat: '24h' | '12h';
};

// Per-device tunables fetched from /api/v1/devices/{id}/runtime-config.
// `event_threshold_db` is null when no override has been set yet (the
// device runs on its bootstrap default). `applied_config_version` is the
// hash from the device's most recent Health message — if it differs from
// what the UI just PUT, the change is in-flight.
export interface DeviceRuntimeConfig {
  device_id: string;
  event_threshold_db: number | null;
  // `paused` suspends event recording + upload on the device while keeping
  // spectrogram + telemetry live. Defaults to false when no override set.
  paused: boolean;
  applied_config_version: string | null;
}

// Backend requires at least one field set; both are optional so partial
// PUTs (toggle just `paused`, or just `event_threshold_db`) round-trip
// cleanly.
export interface DeviceRuntimeConfigUpdate {
  event_threshold_db?: number;
  paused?: boolean;
}

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

export interface SpectrogramTileRef {
  hour: number;       // UTC hour boundary, unix seconds
  tile_url: string;   // same-origin path; fetch as image/png
}

export interface SpectrogramHistoryResponse {
  device_id: string;
  generated_at: number;
  tile_db_min: number;
  tile_db_max: number;
  tile_rows: number;
  tile_cols: number;
  hours: SpectrogramTileRef[]; // ascending; last entry is current (in-progress) hour
}

export type HealthResolution = 'raw' | '1m' | '1h';

export interface DeviceHealthPoint {
  ts: number;
  uptime_s: number;
  cpu_pct: number;
  cpu_temp_c: number;
  mem_used_mb: number;
  disk_free_mb: number;
  wifi_rssi_dbm: number;
  queue_depth: number;
  queue_bytes: number;
  mic_gain_db: number;
  ntp_offset_ms: number;
  fw_version: string;
  config_version: string;
}

export interface HealthReadResponse {
  device_id: string;
  resolution: HealthResolution;
  from_ts: number;
  to_ts: number;
  points: DeviceHealthPoint[];
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
  | 'truck'
  | 'construction'
  | 'helicopter'
  | 'airplane'
  | 'siren'
  | 'horn'
  | 'dog'
  | 'voice'
  | 'trash pickup'
  | 'wind'
  | 'rain'
  | 'thunder'
  | 'other';

export const EVENT_LABELS: readonly EventLabel[] = [
  'motorcycle',
  'car',
  'truck',
  'construction',
  'helicopter',
  'airplane',
  'siren',
  'horn',
  'dog',
  'voice',
  'trash pickup',
  'wind',
  'rain',
  'thunder',
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
  label: EventLabel | null;
  playback_url: string | null;
  playback_url_expires_at: number | null;
}

export interface PlaybackUrl {
  event_id: string;
  url: string;
  expires_at: number;
}

export interface EventIndexEntry {
  ts: number;
  duration_s: number;
  labeled: boolean;
}

export interface EventIndexResponse {
  device_id: string | null;
  from_ts: number | null;
  to_ts: number | null;
  events: EventIndexEntry[];
}

export interface LabelSubmission {
  event_id: string;
  label: EventLabel;
  created_at: number;
}

// User-drawn time-range annotations from the live spectrogram. Persisted
// separately from `events` — they have no audio backing, only a label and
// a [ts_start, ts_end) interval.
export interface SpectrogramAnnotation {
  id: number;
  device_id: string;
  ts_start: number;
  ts_end: number;
  label: EventLabel;
  created_at: number;
}

// Recent events listing is a merged feed of audio-backed events and
// user-drawn annotations. The kind discriminator lets the row renderer
// branch without conflating the two concepts.
export type RecentEntry =
  | { kind: 'event'; event: DeviceEvent }
  | { kind: 'annotation'; annotation: SpectrogramAnnotation };

// --- Dashboard rollup endpoints (real-device mode) --------------------------

// dow is 0=Mon..6=Sun on the wire (Python `weekday()`); the Day adapter
// converts to the frontend's 0=Sun..6=Sat convention.
export interface DailySummaryDay {
  date: string;
  dow: number;
  mean: number;
  peak: number;
  breaches: number;
  peak_hour: number;
  hours: (number | null)[];
  event: string | null;
}

export interface DailySummaryResponse {
  device_id: string;
  from_ts: number;
  to_ts: number;
  threshold: number;
  days: DailySummaryDay[];
}

export interface AnomalyWire {
  event_id: string;
  ts: number;
  day_key: string;
  hour: number;
  peak_db: number;
  hour_mean_db: number;
  z: number;
  classification: string | null;
}

export interface AnomaliesResponse {
  device_id: string;
  from_ts: number;
  to_ts: number;
  points: AnomalyWire[];
}

export interface ForecastWirePoint {
  date: string;
  dow: number;
  mean: number;
  peak: number;
  low: number;
  high: number;
  peak_hour: number;
}

export interface ForecastResponse {
  device_id: string;
  generated_at: number;
  threshold: number;
  points: ForecastWirePoint[];
}

export interface SourceCount {
  name: string;
  pct: number;
  count: number;
}

export interface SourcesResponse {
  device_id: string;
  from_ts: number;
  to_ts: number;
  total: number;
  sources: SourceCount[];
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

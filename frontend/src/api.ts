import type {
  AnomaliesResponse,
  DailySummaryResponse,
  Day,
  DeviceEvent,
  DeviceInfo,
  DeviceRuntimeConfig,
  DeviceRuntimeConfigUpdate,
  EventIndexResponse,
  EventLabel,
  ForecastResponse,
  HealthReadResponse,
  HealthResolution,
  LabelSubmission,
  PlaybackUrl,
  SourcesResponse,
  SpectrogramAnnotation,
  SpectrogramHistoryResponse,
  SpectrogramReadResponse,
  TelemetryReadResponse,
  TelemetryResolution,
  YearBundle,
} from './types';

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

// --- demo (legacy /api routes, only present when DEMO_MODE=1 on the server) -

export const fetchYear = (): Promise<YearBundle> => getJson<YearBundle>('/api/year');

export const fetchDay = (key: string): Promise<Day> => getJson<Day>(`/api/day/${key}`);

export const liveSocket = (): WebSocket => {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${proto}//${window.location.host}/ws/live`);
};

// --- real device API (/api/v1) ---------------------------------------------

export const fetchDevice = (deviceId: string): Promise<DeviceInfo> =>
  getJson<DeviceInfo>(`/api/v1/devices/${deviceId}`);

// Per-device runtime tunables. Pushed live to the Pi over MQTT by the
// backend on PUT; the GET surfaces whatever the device currently has so
// the UI's slider opens at the right position.
export const fetchRuntimeConfig = (
  deviceId: string,
): Promise<DeviceRuntimeConfig> =>
  getJson<DeviceRuntimeConfig>(`/api/v1/devices/${deviceId}/runtime-config`);

export const putRuntimeConfig = (
  deviceId: string,
  body: DeviceRuntimeConfigUpdate,
): Promise<DeviceRuntimeConfig> =>
  putJson<DeviceRuntimeConfig>(
    `/api/v1/devices/${deviceId}/runtime-config`,
    body,
  );

// Switch the device LED between `auto` (follows breach), `on`, or `off`.
// The backend doesn't persist this — the dashboard tracks the intended
// mode locally. On a Pi restart the mode defaults to `auto`.
export type LedMode = 'auto' | 'on' | 'off';

export const putLedMode = (
  deviceId: string,
  mode: LedMode,
): Promise<{ device_id: string; mode: LedMode }> =>
  putJson<{ device_id: string; mode: LedMode }>(
    `/api/v1/devices/${deviceId}/led`,
    { mode },
  );

export const fetchTelemetry = (
  deviceId: string,
  fromTs: number,
  toTs: number,
  res: TelemetryResolution = '1m',
): Promise<TelemetryReadResponse> =>
  getJson<TelemetryReadResponse>(
    `/api/v1/devices/${deviceId}/telemetry?from=${fromTs}&to=${toTs}&res=${res}`,
  );

export const fetchSpectrogramHistory = (
  deviceId: string,
  fromTs: number,
  toTs: number,
): Promise<SpectrogramReadResponse> =>
  getJson<SpectrogramReadResponse>(
    `/api/v1/devices/${deviceId}/spectrogram?from=${fromTs}&to=${toTs}`,
  );

export const fetchSpectrogramHistory24h = (
  deviceId: string,
): Promise<SpectrogramHistoryResponse> =>
  getJson<SpectrogramHistoryResponse>(
    `/api/v1/devices/${deviceId}/spectrogram/history`,
  );

export const fetchSpectrogramTile = async (url: string): Promise<ImageBitmap> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  const blob = await r.blob();
  return createImageBitmap(blob);
};

export const fetchHealth = (
  deviceId: string,
  fromTs: number,
  toTs: number,
  res: HealthResolution = '1m',
): Promise<HealthReadResponse> =>
  getJson<HealthReadResponse>(
    `/api/v1/devices/${deviceId}/health?from=${fromTs}&to=${toTs}&res=${res}`,
  );

export const fetchEventsInRange = (
  deviceId: string,
  fromTs: number,
  toTs: number,
  limit = 500,
): Promise<DeviceEvent[]> =>
  getJson<DeviceEvent[]>(
    `/api/v1/events?device_id=${deviceId}&limit=${limit}` +
      `&from=${fromTs}&to=${toTs}`,
  );

// Lightweight `(ts, duration_s)` listing for visual indicators (e.g. event
// bands on the 24h ribbon). Strips labels / playback URLs / UUIDs so the
// limit can safely go much higher than fetchEventsInRange.
export const fetchEventIndex = (
  deviceId: string,
  fromTs: number,
  toTs: number,
  limit = 5000,
): Promise<EventIndexResponse> =>
  getJson<EventIndexResponse>(
    `/api/v1/events/index?device_id=${deviceId}&limit=${limit}` +
      `&from=${fromTs}&to=${toTs}`,
  );

export const fetchEventPlaybackUrl = (eventId: string): Promise<PlaybackUrl> =>
  getJson<PlaybackUrl>(`/api/v1/events/${eventId}/playback-url`);

export const deleteEvent = async (eventId: string): Promise<void> => {
  const url = `/api/v1/events/${eventId}`;
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
};

export const submitEventLabel = (
  eventId: string,
  label: EventLabel,
): Promise<LabelSubmission> =>
  postJson<LabelSubmission>(`/api/v1/events/${eventId}/labels`, { label });

// --- Spectrogram annotations -----------------------------------------------

// Raised by `submitAnnotation` so the caller can surface the backend's
// 400/409 messages inline rather than as a generic network error. The
// regular `Error` thrown by `postJson` loses the response body, which is
// where the conflict info lives.
export class AnnotationApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown, message: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export const submitAnnotation = async (
  deviceId: string,
  body: { ts_start: number; ts_end: number; label: EventLabel },
): Promise<SpectrogramAnnotation> => {
  const url = `/api/v1/devices/${deviceId}/annotations`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail: unknown = null;
    try {
      const j = await r.json();
      detail = j?.detail ?? j;
    } catch {
      // ignore body-parse failure; detail stays null
    }
    const msg =
      typeof detail === 'string'
        ? detail
        : detail && typeof detail === 'object' && 'message' in detail
          ? String((detail as { message: unknown }).message)
          : `${url} → ${r.status}`;
    throw new AnnotationApiError(r.status, detail, msg);
  }
  return r.json();
};

export const listAnnotations = (
  deviceId: string,
  fromTs: number,
  toTs: number,
  limit = 500,
): Promise<SpectrogramAnnotation[]> =>
  getJson<SpectrogramAnnotation[]>(
    `/api/v1/devices/${deviceId}/annotations` +
      `?from=${fromTs}&to=${toTs}&limit=${limit}`,
  );

export const deleteAnnotation = async (annotationId: number): Promise<void> => {
  const url = `/api/v1/annotations/${annotationId}`;
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
};

// --- dashboard rollup endpoints --------------------------------------------

export const fetchDailySummary = (
  deviceId: string,
  fromTs: number,
  toTs: number,
  threshold: number,
): Promise<DailySummaryResponse> =>
  getJson<DailySummaryResponse>(
    `/api/v1/devices/${deviceId}/summary/daily` +
      `?from=${fromTs}&to=${toTs}&threshold=${threshold}`,
  );

export const fetchAnomaliesRange = (
  deviceId: string,
  fromTs: number,
  toTs: number,
  z: number,
  limit = 500,
): Promise<AnomaliesResponse> =>
  getJson<AnomaliesResponse>(
    `/api/v1/devices/${deviceId}/anomalies` +
      `?from=${fromTs}&to=${toTs}&z=${z}&limit=${limit}`,
  );

export const fetchDeviceForecast = (
  deviceId: string,
  days = 7,
  threshold = 85,
): Promise<ForecastResponse> =>
  getJson<ForecastResponse>(
    `/api/v1/devices/${deviceId}/forecast?days=${days}&threshold=${threshold}`,
  );

export const fetchDeviceSources = (
  deviceId: string,
  fromTs: number,
  toTs: number,
): Promise<SourcesResponse> =>
  getJson<SourcesResponse>(
    `/api/v1/devices/${deviceId}/sources?from=${fromTs}&to=${toTs}`,
  );

export const spectrogramTileUrl = (deviceId: string, hourEpoch: number): string =>
  `/api/v1/devices/${deviceId}/spectrogram/tile?hour=${hourEpoch}`;

// Forward-compatible: backend route lands with the ingest websocket bridge.
// Callers must tolerate immediate close / error and fall back to REST polling.
export const liveDeviceSocket = (deviceId: string): WebSocket => {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${proto}//${window.location.host}/api/v1/devices/${deviceId}/live`);
};

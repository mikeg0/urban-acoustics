import type {
  Day,
  DeviceEvent,
  DeviceInfo,
  EventLabel,
  LabelSubmission,
  PlaybackUrl,
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

export const fetchEvents = (deviceId: string, limit = 50): Promise<DeviceEvent[]> =>
  getJson<DeviceEvent[]>(`/api/v1/events?device_id=${deviceId}&limit=${limit}`);

export const fetchEventPlaybackUrl = (eventId: string): Promise<PlaybackUrl> =>
  getJson<PlaybackUrl>(`/api/v1/events/${eventId}/playback-url`);

export const submitEventLabel = (
  eventId: string,
  label: EventLabel,
): Promise<LabelSubmission> =>
  postJson<LabelSubmission>(`/api/v1/events/${eventId}/labels`, { label });

// Forward-compatible: backend route lands with the ingest websocket bridge.
// Callers must tolerate immediate close / error and fall back to REST polling.
export const liveDeviceSocket = (deviceId: string): WebSocket => {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${proto}//${window.location.host}/api/v1/devices/${deviceId}/live`);
};

import type { Day, YearBundle } from './types';

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

export const fetchYear = (): Promise<YearBundle> => getJson<YearBundle>('/api/year');

export const fetchDay = (key: string): Promise<Day> => getJson<Day>(`/api/day/${key}`);

export const liveSocket = (): WebSocket => {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${proto}//${window.location.host}/ws/live`);
};

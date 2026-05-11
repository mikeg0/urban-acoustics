import { useEffect, useState } from 'react';
import type { Tweaks } from './types';

const STORAGE_KEY = 'urban-acoustics:tweaks';

const DEFAULTS: Tweaks = {
  spectroColor: 'ice',
  dbThreshold: 86,
  anomalySensitivity: 2.9,
};

function load(): Tweaks {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

const listeners = new Set<(t: Tweaks) => void>();
let current: Tweaks = load();

export function getTweaks(): Tweaks { return current; }
export function getDefaults(): Tweaks { return { ...DEFAULTS }; }

export function applyTweaks(partial: Partial<Tweaks>): void {
  current = { ...current, ...partial };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* ignore */ }
  listeners.forEach((fn) => fn(current));
}

export function useTweaks(): Tweaks {
  const [t, setT] = useState<Tweaks>(current);
  useEffect(() => {
    const fn = (next: Tweaks) => setT({ ...next });
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return t;
}

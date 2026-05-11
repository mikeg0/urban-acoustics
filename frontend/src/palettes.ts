import type { Tweaks } from './types';

type RGB = [number, number, number];
type Stop = [number, RGB];
type Ramp = (v: number) => string;

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function lerpColor(c1: RGB, c2: RGB, t: number): RGB {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

function rampFromStops(stops: Stop[]): Ramp {
  return (v) => {
    v = Math.max(0, Math.min(1, v));
    for (let i = 0; i < stops.length - 1; i++) {
      const [t1, c1] = stops[i];
      const [t2, c2] = stops[i + 1];
      if (v >= t1 && v <= t2) {
        const local = (v - t1) / (t2 - t1 || 1);
        const [r, g, b] = lerpColor(c1, c2, local);
        return `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
      }
    }
    const [, c] = stops[stops.length - 1];
    return `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;
  };
}

export type PaletteKey = Tweaks['spectroColor'];

export interface Palette {
  label: string;
  fn: Ramp;
  css: string;
}

export const PALETTES: Record<PaletteKey, Palette> = {
  heat: {
    label: 'Heat',
    fn: rampFromStops([
      [0.0, [8, 6, 14]],
      [0.2, [48, 12, 82]],
      [0.45, [156, 30, 78]],
      [0.7, [234, 62, 40]],
      [0.88, [252, 176, 48]],
      [1.0, [254, 240, 120]],
    ]),
    css: 'linear-gradient(90deg, rgb(8,6,14) 0%, rgb(48,12,82) 20%, rgb(156,30,78) 45%, rgb(234,62,40) 70%, rgb(252,176,48) 88%, rgb(254,240,120) 100%)',
  },
  ice: {
    label: 'Ice',
    fn: rampFromStops([
      [0.0, [6, 8, 14]],
      [0.3, [14, 48, 96]],
      [0.6, [16, 164, 220]],
      [0.85, [164, 232, 220]],
      [1.0, [240, 252, 240]],
    ]),
    css: 'linear-gradient(90deg, rgb(6,8,14) 0%, rgb(14,48,96) 30%, rgb(16,164,220) 60%, rgb(164,232,220) 85%, rgb(240,252,240) 100%)',
  },
  mono: {
    label: 'Mono',
    fn: rampFromStops([
      [0.0, [10, 10, 10]],
      [0.5, [120, 120, 120]],
      [1.0, [250, 250, 246]],
    ]),
    css: 'linear-gradient(90deg, rgb(10,10,10), rgb(120,120,120), rgb(250,250,246))',
  },
  neon: {
    label: 'Neon',
    fn: rampFromStops([
      [0.0, [10, 6, 24]],
      [0.35, [50, 18, 120]],
      [0.6, [220, 40, 160]],
      [0.85, [252, 220, 80]],
      [1.0, [245, 245, 220]],
    ]),
    css: 'linear-gradient(90deg, rgb(10,6,24), rgb(50,18,120), rgb(220,40,160), rgb(252,220,80), rgb(245,245,220))',
  },
};

export function dbColor(db: number, threshold = 85): string {
  if (db >= threshold + 8) return 'oklch(72% 0.2 25)';
  if (db >= threshold) return 'oklch(78% 0.18 45)';
  if (db >= threshold - 8) return 'oklch(82% 0.14 80)';
  if (db >= threshold - 18) return 'oklch(70% 0.08 120)';
  return 'oklch(48% 0.04 180)';
}

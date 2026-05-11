import { useEffect, useRef, useState } from 'react';
import { mulberry32, normDb } from './utils';
import { PALETTES, type PaletteKey } from './palettes';
import type { Day } from './types';

/** Build a fake spectrogram matrix [freqBins][timeSlices], values 0..1. */
export function buildSpectrogram(seed: number, intensity = 1): number[][] {
  const rng = mulberry32(seed);
  const FREQ = 64;
  const TIME = 240;
  const data: number[][] = Array.from({ length: FREQ }, () => new Array(TIME));

  const bands = [
    { center: 6, width: 4, power: 0.9 },
    { center: 18, width: 6, power: 0.7 },
    { center: 32, width: 8, power: 0.55 },
    { center: 48, width: 10, power: 0.35 },
  ];

  const transients: { t: number; width: number; freqCenter: number; freqWidth: number; amp: number }[] = [];
  const nT = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < nT; i++) {
    transients.push({
      t: Math.floor(rng() * TIME),
      width: 3 + rng() * 8,
      freqCenter: 10 + rng() * 45,
      freqWidth: 8 + rng() * 16,
      amp: 0.7 + rng() * 0.4,
    });
  }

  for (let f = 0; f < FREQ; f++) {
    for (let t = 0; t < TIME; t++) {
      let v = 0.12 + rng() * 0.08;
      bands.forEach((b) => {
        const df = (f - b.center) / b.width;
        v += b.power * Math.exp(-df * df) * (0.6 + 0.4 * Math.sin(t * 0.03 + f * 0.1));
      });
      transients.forEach((tr) => {
        const dt = (t - tr.t) / tr.width;
        const df = (f - tr.freqCenter) / tr.freqWidth;
        v += tr.amp * Math.exp(-dt * dt - df * df);
      });
      v *= intensity;
      data[f][t] = Math.max(0, Math.min(1, v));
    }
  }
  return data;
}

interface SpectrogramCanvasProps {
  data: number[][];
  palette?: PaletteKey;
  height?: number;
  intensity?: number;
  showGrid?: boolean;
}

export function SpectrogramCanvas({
  data,
  palette = 'heat',
  height = 180,
  intensity = 1,
  showGrid = false,
}: SpectrogramCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const F = data.length;
    const T = data[0].length;
    canvas.width = T;
    canvas.height = F;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(T, F);
    const pal = PALETTES[palette]?.fn ?? PALETTES.heat.fn;

    for (let f = 0; f < F; f++) {
      for (let t = 0; t < T; t++) {
        const v = Math.min(1, data[F - 1 - f][t] * intensity);
        const col = pal(v);
        const m = col.match(/\d+/g)!;
        const idx = (f * T + t) * 4;
        img.data[idx] = +m[0];
        img.data[idx + 1] = +m[1];
        img.data[idx + 2] = +m[2];
        img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [data, palette, intensity]);

  return (
    <div style={{ position: 'relative', width: '100%', height }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', imageRendering: 'auto', borderRadius: 4 }}
      />
      {showGrid && (
        <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {[0, 0.25, 0.5, 0.75].map((p) => (
            <line key={p} x1={`${p * 100}%`} x2={`${p * 100}%`} y1="0" y2="100%" stroke="rgba(255,255,255,0.08)" />
          ))}
        </svg>
      )}
    </div>
  );
}

interface TimelineSpectrogramProps {
  day: Day;
  palette?: PaletteKey;
  threshold?: number;
  hourFocus?: number | null;
  onHourHover?: (h: number | null) => void;
  onHourClick?: (h: number) => void;
  showBars?: boolean;
}

export function TimelineSpectrogram({
  day,
  palette = 'heat',
  threshold = 85,
  hourFocus = null,
  onHourHover,
  onHourClick,
  showBars = false,
}: TimelineSpectrogramProps) {
  const height = 200;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const F = 64;
    const PER_HOUR = 60;
    const TOTAL_T = PER_HOUR * 24;
    canvas.width = TOTAL_T;
    canvas.height = F;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(TOTAL_T, F);
    const pal = PALETTES[palette]?.fn ?? PALETTES.heat.fn;

    for (let h = 0; h < 24; h++) {
      const seed = (day.key.charCodeAt(4) * 31 + h * 2731 + day.hours[h] * 100) | 0;
      const intensity = normDb(day.hours[h]);
      const hrData = buildSpectrogram(seed, 0.6 + intensity * 1.2);
      const srcT = hrData[0].length;
      for (let f = 0; f < F; f++) {
        for (let t = 0; t < PER_HOUR; t++) {
          const st = Math.floor((t / PER_HOUR) * srcT);
          const v = Math.min(1, hrData[F - 1 - f][st]);
          const col = pal(v);
          const m = col.match(/\d+/g)!;
          const x = h * PER_HOUR + t;
          const idx = (f * TOTAL_T + x) * 4;
          img.data[idx] = +m[0];
          img.data[idx + 1] = +m[1];
          img.data[idx + 2] = +m[2];
          img.data[idx + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [day, palette]);

  const handleMove = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const h = Math.max(0, Math.min(23, Math.floor(x * 24)));
    setHover(h);
    onHourHover?.(h);
  };

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <div
        style={{ position: 'relative', width: '100%', height, borderRadius: 4, overflow: 'hidden', cursor: 'crosshair' }}
        onMouseMove={handleMove}
        onMouseLeave={() => { setHover(null); onHourHover?.(null); }}
        onClick={() => hover != null && onHourClick?.(hover)}
      >
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        {showBars && (
          <svg
            width="100%" height="100%"
            viewBox="0 0 24 100"
            preserveAspectRatio="none"
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          >
            {day.hours.map((db, h) => {
              const pct = Math.max(0, Math.min(1, (db - 30) / 75));
              const barH = pct * 100;
              const y = 100 - barH;
              const isBreach = db >= threshold;
              const isWarn = db >= threshold - 8;
              const fill = isBreach ? 'oklch(78% 0.2 35)' : isWarn ? 'oklch(85% 0.18 70)' : 'oklch(98% 0.006 85)';
              return (
                <g key={h}>
                  <rect x={h + 0.1} y={y} width={0.8} height={barH} fill={fill}
                    opacity={isBreach ? 0.85 : isWarn ? 0.6 : 0.45} />
                  <rect x={h + 0.1} y={y} width={0.8} height={0.8} fill={fill} opacity={1} />
                </g>
              );
            })}
          </svg>
        )}
        <svg width="100%" height="100%" viewBox="0 0 24 1" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {day.hours.map((db, h) =>
            db >= threshold ? (
              <rect key={h} x={h} y={0} width={1} height={0.04} fill="oklch(78% 0.18 35)" />
            ) : null,
          )}
        </svg>
        {hover != null && (
          <div style={{
            position: 'absolute',
            left: `${(hover / 24) * 100}%`,
            top: 0, bottom: 0,
            width: `${100 / 24}%`,
            background: 'rgba(255,255,255,0.08)',
            borderLeft: '1px solid rgba(255,255,255,0.35)',
            borderRight: '1px solid rgba(255,255,255,0.35)',
            pointerEvents: 'none',
          }} />
        )}
        {hourFocus != null && (
          <div style={{
            position: 'absolute',
            left: `${(hourFocus / 24) * 100}%`,
            top: 0, bottom: 0,
            width: `${100 / 24}%`,
            outline: '1.5px solid oklch(82% 0.18 310)',
            pointerEvents: 'none',
          }} />
        )}
      </div>
      <div className="mono" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(24, 1fr)',
        fontSize: 10,
        color: 'var(--ink-3)',
        marginTop: 6,
      }}>
        {Array.from({ length: 24 }).map((_, h) => (
          <div key={h} style={{ textAlign: 'center', opacity: h % 3 === 0 ? 1 : 0.4 }}>
            {String(h).padStart(2, '0')}
          </div>
        ))}
      </div>
    </div>
  );
}

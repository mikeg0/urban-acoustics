import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FFT from 'fft.js';
import { mulberry32, normDb } from './utils';
import { PALETTES, type PaletteKey } from './palettes';
import { BAND_CENTERS_HZ, SPECTROGRAM_N_BANDS } from './types';
import type { Day, SpectrogramHistoryResponse } from './types';
import {
  fetchSpectrogramHistory24h,
  fetchSpectrogramTile,
  spectrogramTileUrl,
} from './api';

// Tile contract constants — must match backend/app/spectrogram_tiles.py.
// The 24h-history manifest carries equivalent values; these duplicates exist
// for the historical-tile components below that don't go through a manifest.
const TILE_DB_MIN_DEFAULT = 20;
const TILE_DB_MAX_DEFAULT = 110;
const TILE_COLS_DEFAULT = 3600;
const TILE_ROWS_DEFAULT = SPECTROGRAM_N_BANDS;

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
  /** Real-device mode: render the day's 24 historical tiles instead of the
   *  synthetic per-hour spectrograms. When unset, falls back to the seeded
   *  buildSpectrogram path (demo-mode behaviour). */
  deviceId?: string | null;
}

export function TimelineSpectrogram({
  day,
  palette = 'heat',
  threshold = 85,
  hourFocus = null,
  onHourHover,
  onHourClick,
  showBars = false,
  deviceId = null,
}: TimelineSpectrogramProps) {
  const height = 200;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (deviceId) return;  // Real-mode path uses RealDayStrip — no synth.
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
  }, [day, palette, deviceId]);

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
        {deviceId ? (
          <RealDayStrip
            deviceId={deviceId}
            dayKey={day.key}
            palette={palette}
            height={height}
          />
        ) : (
          <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        )}
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

// ---------------------------------------------------------------------------
// Live spectrogram — rolling buffer of real ⅓-octave band frames from the Pi.
// ---------------------------------------------------------------------------

const SPECTROGRAM_FLOOR_DB = -20;
const LUT_SIZE = 256;
// One canvas column represents this much wall-clock time. Locked to the
// Pi's emit cadence: STFT hop_size (2048) × decimate (2) / sample_rate
// (48 kHz) = 85.33 ms. If the Pi config changes either knob, update here.
export const SPECTROGRAM_COLUMN_MS = (2 * 2048 / 48000) * 1000;
// Playback delay floor — how far the right edge of the canvas lags real-
// time when conditions are good. Big enough to absorb the Pi's per-second
// burst pattern plus typical network jitter, but small enough that the
// user-perceived latency is acceptable. Under worse conditions the buffer
// grows adaptively (see ``useRollingBands``).
const SPECTROGRAM_BUFFER_MS = 1500;
// Hard cap on the adaptive buffer. If lag exceeds this we'd rather show a
// visible gap than push latency past a couple of seconds.
const SPECTROGRAM_MAX_BUFFER_MS = 5000;
// Headroom added above the highest observed lag. Absorbs sub-frame jitter
// without re-triggering buffer growth on every push.
const SPECTROGRAM_LAG_HEADROOM_MS = 300;
// How fast the buffer relaxes back toward its floor once lag improves.
// Must be *slower* than the per-second buffer regrowth that the Pi's
// burst pattern causes: each burst's earliest frame re-sets ``needBuffer``
// to roughly ``block_duration + network_lag + headroom``. If decay
// outpaces that, every burst triggers a small regrowth — and a regrowth
// is a brief scroll stall (the monotonic guard refuses to rewind), which
// looks like once-per-second judder. At 0.1 ms/tick (~6 ms/s) the decay
// is well under the regrowth, so the buffer settles at the steady-state
// worst-case lag. Recovery from a 5 s spike back to the 1.5 s floor still
// finishes in ~10 min, which is fine.
const SPECTROGRAM_BUFFER_DECAY_MS_PER_TICK = 0.1;
// Tick interval. ~60 Hz keeps the canvas redraw smooth without doing more
// work than necessary — most ticks advance 0 columns.
const SPECTROGRAM_TICK_MS = 16;

interface RollingBands {
  /** Map of global column index → band vector. Columns without data are
   *  simply absent from the map and render as the palette's floor color. */
  frames: Map<number, number[]>;
  /** Right-edge column index — `Date.now() - SPECTROGRAM_BUFFER_MS`
   *  converted to a column index. Increments monotonically with wall
   *  clock; the canvas always shows columns
   *  ``[currentCol - maxFrames + 1, currentCol]``. */
  currentCol: number;
  /** Re-renders bump this on every tick that moves ``currentCol``. */
  version: number;
  maxFrames: number;
  nBands: number;
  /** Has at least one frame been received since the hook mounted? Used
   *  by the UI to hide its waiting overlay. */
  hasData: boolean;
  push: (ts: number, bands: number[] | Float32Array) => void;
}

function colForTs(ts: number): number {
  return Math.floor((ts * 1000) / SPECTROGRAM_COLUMN_MS);
}

/** Time-anchored rolling spectrogram buffer.
 *
 *  The canvas window is driven by wall-clock time, not by data arrival —
 *  ``currentCol`` advances at a steady rate set by ``Date.now()`` lagged
 *  by an *adaptive* buffer. Incoming frames are filed in a map keyed by
 *  their own timestamp's column index. When the canvas reaches a column,
 *  whichever frame matches that slot is rendered; if none arrived in time,
 *  the slot renders as a blank (palette floor color).
 *
 *  Result: the scroll cadence is independent of the Pi's bursty emit
 *  pattern. Glitches become small visible gaps instead of jitter.
 *
 *  Adaptive buffer: starts at ``SPECTROGRAM_BUFFER_MS``. If a frame arrives
 *  with lag exceeding the current buffer (it would land left of the right
 *  edge), the buffer ratchets up to ``lag + headroom`` so the *next* frame
 *  at that lag lands at the right edge. The buffer decays slowly back
 *  toward the floor once lag improves. This trades a bit of user-perceived
 *  latency for keeping the right edge filled when the WS pipeline is slow
 *  (busy CPU, slow network, etc.). */
export function useRollingBands(
  maxFrames: number,
  nBands: number = SPECTROGRAM_N_BANDS,
): RollingBands {
  const framesRef = useRef<Map<number, number[]>>(new Map());
  const bufferMsRef = useRef<number>(SPECTROGRAM_BUFFER_MS);
  const currentColRef = useRef<number>(
    colForTs((Date.now() - bufferMsRef.current) / 1000),
  );
  const hasDataRef = useRef(false);
  const [version, setVersion] = useState(0);

  // Reset map if the consuming component remounts with a different shape.
  if (framesRef.current === null) framesRef.current = new Map();

  // Advance currentCol toward the wall-clock target each tick. Most ticks
  // are no-ops; once per column interval (~85 ms) currentCol moves by 1
  // and we re-render. Prunes map entries that have scrolled off-canvas.
  useEffect(() => {
    const id = setInterval(() => {
      // Relax buffer toward the floor. ``push`` ratchets it back up on the
      // next high-lag frame, so this never undershoots actual lag for
      // long. Skip the math when already at the floor.
      if (bufferMsRef.current > SPECTROGRAM_BUFFER_MS) {
        bufferMsRef.current = Math.max(
          SPECTROGRAM_BUFFER_MS,
          bufferMsRef.current - SPECTROGRAM_BUFFER_DECAY_MS_PER_TICK,
        );
      }
      const playbackMs = Date.now() - bufferMsRef.current;
      const targetCol = Math.floor(playbackMs / SPECTROGRAM_COLUMN_MS);
      // Monotonic: never let the right edge slide backward, even if the
      // buffer just grew enough to drop ``targetCol`` below ``currentCol``.
      // Pausing for a beat is fine; rewinding is jarring.
      if (targetCol <= currentColRef.current) return;
      currentColRef.current = targetCol;
      const leftEdge = targetCol - maxFrames + 1;
      const frames = framesRef.current;
      for (const k of frames.keys()) {
        if (k < leftEdge) frames.delete(k);
      }
      setVersion((v) => v + 1);
    }, SPECTROGRAM_TICK_MS);
    return () => clearInterval(id);
  }, [maxFrames]);

  const push = useCallback((ts: number, bands: number[] | Float32Array) => {
    if (bands.length !== nBands) return;
    const col = colForTs(ts);
    const cur = currentColRef.current;
    if (col <= cur - maxFrames) return;       // already scrolled past
    // If this frame's end-to-end lag exceeds the current buffer, future
    // frames at the same lag would land left of the right edge — that's
    // the persistent-right-edge-gap symptom. Grow the buffer so the next
    // frame at this lag arrives at the right edge instead.
    const lagMs = Date.now() - ts * 1000;
    const needBuffer = lagMs + SPECTROGRAM_LAG_HEADROOM_MS;
    if (needBuffer > bufferMsRef.current) {
      bufferMsRef.current = Math.min(SPECTROGRAM_MAX_BUFFER_MS, needBuffer);
    }
    const copy = bands instanceof Float32Array
      ? Array.from(bands)
      : bands.slice();
    framesRef.current.set(col, copy);
    hasDataRef.current = true;
  }, [nBands, maxFrames]);

  return {
    frames: framesRef.current,
    currentCol: currentColRef.current,
    version,
    maxFrames,
    nBands,
    hasData: hasDataRef.current,
    push,
  };
}

// ---------------------------------------------------------------------------
// History ribbon — bucketed band frames covering a longer window (default 1h).
// Backfilled from /api/v1/devices/{id}/spectrogram on mount, then kept
// current by pushing each live WS frame as it arrives.
// ---------------------------------------------------------------------------

interface HistoryRibbon {
  /** Packed ``displayCols × nBands`` band-dB matrix. NaN means "no frame
   *  landed in this column yet" — rendered as the palette floor. */
  bands: Float32Array;
  /** Wall-clock right-edge column index. */
  currentCol: number;
  version: number;
  displayCols: number;
  nBands: number;
  bucketMs: number;
  /** Has any frame (historical or live) been folded in yet? */
  hasData: boolean;
  push: (ts: number, bands: number[] | Float32Array) => void;
}

/** Time-anchored bucketed buffer for the history ribbon.
 *
 *  Same wall-clock-driven scrolling as ``useRollingBands`` but with a
 *  configurable bucket width (``windowSeconds / displayCols``). Multiple
 *  frames landing in the same bucket are **max-merged** band-wise, since
 *  the question the ribbon answers is "was anything loud here?" — averages
 *  hide spikes that the user cares about. */
export function useHistoryRibbon(
  windowSeconds: number,
  displayCols: number,
  nBands: number = SPECTROGRAM_N_BANDS,
): HistoryRibbon {
  const bucketMs = (windowSeconds * 1000) / displayCols;
  const bandsRef = useRef<Float32Array>(new Float32Array(displayCols * nBands));
  // Initialised on first mount only. Subsequent re-renders preserve the
  // accumulated history.
  const initialisedRef = useRef(false);
  if (!initialisedRef.current) {
    bandsRef.current.fill(NaN);
    initialisedRef.current = true;
  }
  const currentColRef = useRef<number>(Math.floor(Date.now() / bucketMs));
  const hasDataRef = useRef(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      const targetCol = Math.floor(Date.now() / bucketMs);
      if (targetCol === currentColRef.current) return;
      // Number of columns to scroll off the left edge.
      const delta = targetCol - currentColRef.current;
      const bands = bandsRef.current;
      if (delta >= displayCols) {
        bands.fill(NaN);
      } else if (delta > 0) {
        // Shift left by `delta` columns. Each column is `nBands` floats.
        bands.copyWithin(0, delta * nBands);
        bands.fill(NaN, (displayCols - delta) * nBands);
      }
      currentColRef.current = targetCol;
      setVersion((v) => v + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [bucketMs, displayCols, nBands]);

  const push = useCallback((ts: number, frame: number[] | Float32Array) => {
    if (frame.length !== nBands) return;
    const col = Math.floor((ts * 1000) / bucketMs);
    const cur = currentColRef.current;
    // Frame falls outside the visible window — drop it.
    const slot = col - cur + displayCols - 1;
    if (slot < 0 || slot >= displayCols) return;
    const bands = bandsRef.current;
    const base = slot * nBands;
    // Max-merge into the existing bucket. NaN-initialised slots accept the
    // first frame as-is.
    for (let b = 0; b < nBands; b++) {
      const cur_v = bands[base + b];
      const new_v = frame[b];
      if (Number.isNaN(cur_v) || new_v > cur_v) bands[base + b] = new_v;
    }
    hasDataRef.current = true;
  }, [bucketMs, displayCols, nBands]);

  return {
    bands: bandsRef.current,
    currentCol: currentColRef.current,
    version,
    displayCols,
    nBands,
    bucketMs,
    hasData: hasDataRef.current,
    push,
  };
}

interface HistorySpectrogramProps {
  ribbon: HistoryRibbon;
  palette?: PaletteKey;
  height?: number;
  minDb?: number;
  maxDb?: number;
}

/** Renders the bucketed history ribbon. Mirrors LiveSpectrogram's
 *  LUT-based pixel loop; differs only in that columns are NaN-when-empty
 *  rather than absent-from-map. */
export function HistorySpectrogram({
  ribbon,
  palette = 'heat',
  height = 64,
  minDb = 20,
  maxDb = 110,
}: HistorySpectrogramProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lut = useMemo(() => paletteLut(palette), [palette]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const F = ribbon.nBands;
    const T = ribbon.displayCols;
    canvas.width = T;
    canvas.height = F;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(T, F);

    const range = Math.max(1, maxDb - minDb);
    const invRange = (LUT_SIZE - 1) / range;
    let floorClamp = (SPECTROGRAM_FLOOR_DB - minDb) * invRange;
    if (floorClamp < 0) floorClamp = 0;
    else if (floorClamp > LUT_SIZE - 1) floorClamp = LUT_SIZE - 1;
    const floorLutBase = (floorClamp | 0) * 3;
    const bands = ribbon.bands;

    for (let c = 0; c < T; c++) {
      for (let f = 0; f < F; f++) {
        const srcBand = F - 1 - f;
        const idx = (f * T + c) * 4;
        const v_db = bands[c * F + srcBand];
        if (Number.isNaN(v_db)) {
          img.data[idx] = lut[floorLutBase];
          img.data[idx + 1] = lut[floorLutBase + 1];
          img.data[idx + 2] = lut[floorLutBase + 2];
          img.data[idx + 3] = 255;
        } else {
          let v = (v_db - minDb) * invRange;
          if (v < 0) v = 0;
          else if (v > LUT_SIZE - 1) v = LUT_SIZE - 1;
          const lutBase = (v | 0) * 3;
          img.data[idx] = lut[lutBase];
          img.data[idx + 1] = lut[lutBase + 1];
          img.data[idx + 2] = lut[lutBase + 2];
          img.data[idx + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [ribbon.bands, ribbon.version, ribbon.displayCols, ribbon.nBands, lut, minDb, maxDb]);

  return (
    <div style={{ position: 'relative', width: '100%', height }}>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%', height: '100%', display: 'block',
          imageRendering: 'auto', borderRadius: 4, background: 'var(--bg-2)',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 24-hour historical ribbon — composed of 24 server-rendered PNG tiles (one
// per device-hour). Closed tiles are immutable + browser-cached; only the
// current (in-progress) hour refreshes. The palette is applied client-side
// so it stays in lockstep with the live spectrogram under any palette swap.
// ---------------------------------------------------------------------------

const HISTORY_24H_MANIFEST_REFRESH_MS = 5 * 60 * 1000;
const HISTORY_24H_CURRENT_HOUR_REFRESH_MS = 30 * 1000;

interface HistoryRibbon24hProps {
  deviceId: string;
  palette?: PaletteKey;
  height?: number;
  selectedHourTs?: number | null;
  onHourClick?: (hourTs: number) => void;
}

export function HistoryRibbon24h({
  deviceId,
  palette = 'heat',
  height = 64,
  selectedHourTs = null,
  onHourClick,
}: HistoryRibbon24hProps) {
  const [manifest, setManifest] = useState<SpectrogramHistoryResponse | null>(null);
  const [currentTick, setCurrentTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const m = await fetchSpectrogramHistory24h(deviceId);
        if (alive) setManifest(m);
      } catch {
        // Backend may be unreachable or the device may have no tiles yet;
        // silently leave the placeholder up. The live ribbon still works.
      }
    };
    load();
    const manifestId = window.setInterval(load, HISTORY_24H_MANIFEST_REFRESH_MS);
    const currentId = window.setInterval(
      () => setCurrentTick((t) => t + 1),
      HISTORY_24H_CURRENT_HOUR_REFRESH_MS,
    );
    return () => {
      alive = false;
      window.clearInterval(manifestId);
      window.clearInterval(currentId);
    };
  }, [deviceId]);

  const placeholder = (
    <div
      style={{
        width: '100%',
        height,
        borderRadius: 4,
        background: 'var(--bg-2)',
      }}
    />
  );
  if (!manifest) return placeholder;

  const lastIdx = manifest.hours.length - 1;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        width: '100%',
        height,
        gap: 1,
        background: 'var(--bg-2)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      {manifest.hours.map((ref, i) => {
        const isSelected = selectedHourTs === ref.hour;
        const hourLabel = new Date(ref.hour * 1000).toLocaleString('en-US', {
          hour: '2-digit', minute: '2-digit', hour12: false,
        });
        return (
          <button
            key={ref.hour}
            type="button"
            className={`history-tile-button${isSelected ? ' selected' : ''}`}
            title={`${hourLabel} — click to open hour playback`}
            onClick={() => onHourClick?.(ref.hour)}
          >
            <HistoryTile
              url={ref.tile_url}
              palette={palette}
              minDb={manifest.tile_db_min}
              maxDb={manifest.tile_db_max}
              rows={manifest.tile_rows}
              cols={manifest.tile_cols}
              // Bump the cache-buster only for the current (in-progress) hour.
              // Closed-hour tiles are immutable so their key never changes and
              // their `useEffect` doesn't re-run — they stay rendered.
              refreshKey={i === lastIdx ? currentTick : 0}
            />
          </button>
        );
      })}
    </div>
  );
}

interface HistoryTileProps {
  url: string;
  palette: PaletteKey;
  minDb: number;
  maxDb: number;
  rows: number;
  cols: number;
  refreshKey: number;
}

// Compute the UTC hour-boundary epoch for a given dayKey (YYYY-MM-DD UTC)
// and hour-of-day [0..23]. Dashboard summary days are UTC-anchored, so the
// tile URL it generates aligns 1:1 with the backend's tile contract.
function dayHourToEpoch(dayKey: string, hour: number): number {
  const ts = Date.parse(`${dayKey}T00:00:00Z`);
  return Math.floor(ts / 1000) + hour * 3600;
}

interface RealHourTileProps {
  deviceId: string;
  dayKey: string;
  hour: number;
  palette?: PaletteKey;
  height?: number;
  borderRadius?: number;
}

/** Single-hour historical spectrogram tile, palette-mapped on the client.
 *
 *  Used in the dashboard's HourView when wired to a real device. Falls back
 *  silently (renders the empty-tile floor colour) if the hour is older than
 *  the spectrogram_frames retention window. */
export function RealHourTile({
  deviceId,
  dayKey,
  hour,
  palette = 'heat',
  height = 220,
  borderRadius = 4,
}: RealHourTileProps) {
  const epoch = dayHourToEpoch(dayKey, hour);
  const url = spectrogramTileUrl(deviceId, epoch);
  // Closed historical hours are immutable on the backend, so the browser
  // cache keys on URL alone — `refreshKey=0` keeps the cache hit.
  return (
    <div style={{
      width: '100%',
      height,
      borderRadius,
      overflow: 'hidden',
      background: 'var(--bg-2)',
      display: 'flex',
    }}>
      <HistoryTile
        url={url}
        palette={palette}
        minDb={TILE_DB_MIN_DEFAULT}
        maxDb={TILE_DB_MAX_DEFAULT}
        rows={TILE_ROWS_DEFAULT}
        cols={TILE_COLS_DEFAULT}
        refreshKey={0}
      />
    </div>
  );
}

interface RealDayStripProps {
  deviceId: string;
  dayKey: string;
  palette?: PaletteKey;
  height?: number;
}

/** 24-hour spectrogram strip for a historical day, stitched from 24 tiles.
 *
 *  The dashboard's TimelineSpectrogram swaps in this component when in real
 *  mode. The dB-bar overlay on top of the strip continues to come from
 *  Day.hours[24] (real values from the summary endpoint), so empty hours
 *  render as the palette floor with no bar above them. */
export function RealDayStrip({
  deviceId,
  dayKey,
  palette = 'heat',
  height = 200,
}: RealDayStripProps) {
  return (
    <div style={{
      display: 'flex',
      width: '100%',
      height,
      gap: 1,
      borderRadius: 4,
      overflow: 'hidden',
      background: 'var(--bg-2)',
    }}>
      {Array.from({ length: 24 }, (_, h) => {
        const epoch = dayHourToEpoch(dayKey, h);
        return (
          <HistoryTile
            key={h}
            url={spectrogramTileUrl(deviceId, epoch)}
            palette={palette}
            minDb={TILE_DB_MIN_DEFAULT}
            maxDb={TILE_DB_MAX_DEFAULT}
            rows={TILE_ROWS_DEFAULT}
            cols={TILE_COLS_DEFAULT}
            refreshKey={0}
          />
        );
      })}
    </div>
  );
}

export function HistoryTile({
  url,
  palette,
  minDb,
  maxDb,
  rows,
  cols,
  refreshKey,
}: HistoryTileProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lut = useMemo(() => paletteLut(palette), [palette]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    const draw = async () => {
      // Cache-buster only fires for the current-hour tile (refreshKey > 0);
      // closed hours hit browser cache.
      const fetchUrl = refreshKey > 0 ? `${url}&t=${refreshKey}` : url;
      let bitmap: ImageBitmap;
      try {
        bitmap = await fetchSpectrogramTile(fetchUrl);
      } catch {
        return;
      }
      if (cancelled) {
        bitmap.close();
        return;
      }

      canvas.width = cols;
      canvas.height = rows;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        bitmap.close();
        return;
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      const img = ctx.getImageData(0, 0, cols, rows);
      const data = img.data;
      const range = Math.max(1, maxDb - minDb);
      const invRange = (LUT_SIZE - 1) / range;
      let floorClamp = (SPECTROGRAM_FLOOR_DB - minDb) * invRange;
      if (floorClamp < 0) floorClamp = 0;
      else if (floorClamp > LUT_SIZE - 1) floorClamp = LUT_SIZE - 1;
      const floorLutBase = (floorClamp | 0) * 3;

      // PNG is grayscale so R=G=B=pixel value. Value 0 means "no data" —
      // render at the palette floor color (matches the live ribbon's NaN
      // handling). Values 1..255 are the quantised dB level; pixel-1 maps
      // to LUT index 0..254 so the bottom of the range lines up exactly
      // with what LiveSpectrogram/HistorySpectrogram show at minDb.
      for (let p = 0; p < data.length; p += 4) {
        const v = data[p];
        if (v === 0) {
          data[p] = lut[floorLutBase];
          data[p + 1] = lut[floorLutBase + 1];
          data[p + 2] = lut[floorLutBase + 2];
        } else {
          const lutBase = (v - 1) * 3;
          data[p] = lut[lutBase];
          data[p + 1] = lut[lutBase + 1];
          data[p + 2] = lut[lutBase + 2];
        }
      }
      ctx.putImageData(img, 0, 0);
    };
    draw();
    return () => {
      cancelled = true;
    };
  }, [url, lut, minDb, maxDb, rows, cols, refreshKey]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        flex: '1 1 0',
        minWidth: 0,
        height: '100%',
        display: 'block',
        imageRendering: 'auto',
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Per-event STFT — browser-side spectrogram from a decoded audio clip.
// Mirrors the Pi-side 1/3-octave binning in
// raspberry-pi-zero-2w/urban_acoustics/dsp.py::STFTBander so live and
// recorded spectrograms share the same frequency axis.
// ---------------------------------------------------------------------------

const STFT_WINDOW = 4096;
const STFT_HOP = 2048;

function buildBandSlices(sampleRate: number): Array<[number, number]> {
  const binWidth = sampleRate / STFT_WINDOW;
  const nyquist = sampleRate / 2;
  const maxBin = STFT_WINDOW / 2;
  const slices: Array<[number, number]> = [];
  for (const fc of BAND_CENTERS_HZ) {
    const lo = fc * Math.pow(2, -1 / 6);
    let hi = fc * Math.pow(2, 1 / 6);
    if (hi > nyquist) hi = nyquist;
    let kLo = Math.max(1, Math.ceil(lo / binWidth));
    let kHi = Math.min(maxBin, Math.floor(hi / binWidth));
    if (kHi < kLo) {
      // Band narrower than the FFT bin — snap to the nearest single bin.
      const snap = Math.max(1, Math.min(maxBin, Math.round(fc / binWidth)));
      kLo = kHi = snap;
    }
    slices.push([kLo, kHi]);
  }
  return slices;
}

function buildHann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return w;
}

/** Decoded audio → ``[nBands][nFrames]`` matrix normalised to 0..1 for
 *  rendering with :func:`SpectrogramCanvas`. The Pi calibration offset is
 *  intentionally omitted (we don't have it in the browser); levels are
 *  min/max-normalised across the clip so the spectral pattern is what
 *  matters visually. */
export function computeEventSpectrogram(
  samples: Float32Array,
  sampleRate: number,
): number[][] {
  if (samples.length < STFT_WINDOW) {
    // Clip is shorter than one window. Show a single-column "spectrum"
    // by zero-padding the input — better than rendering an empty canvas.
    const padded = new Float32Array(STFT_WINDOW);
    padded.set(samples);
    return computeEventSpectrogram(padded, sampleRate);
  }
  const win = buildHann(STFT_WINDOW);
  const slices = buildBandSlices(sampleRate);
  const fft = new FFT(STFT_WINDOW);
  // fft.js exposes its scratch buffers as plain Arrays; cast for typed access.
  const out = fft.createComplexArray() as unknown as number[];
  const frame = new Float64Array(STFT_WINDOW);

  const nFrames = Math.floor((samples.length - STFT_WINDOW) / STFT_HOP) + 1;
  const rows: Float32Array[] = Array.from(
    { length: SPECTROGRAM_N_BANDS },
    () => new Float32Array(nFrames),
  );

  for (let f = 0; f < nFrames; f++) {
    const start = f * STFT_HOP;
    for (let i = 0; i < STFT_WINDOW; i++) {
      frame[i] = samples[start + i] * win[i];
    }
    fft.realTransform(out, frame as unknown as number[]);
    for (let b = 0; b < SPECTROGRAM_N_BANDS; b++) {
      const [kLo, kHi] = slices[b];
      let pow = 0;
      for (let k = kLo; k <= kHi; k++) {
        const re = out[2 * k];
        const im = out[2 * k + 1];
        pow += re * re + im * im;
      }
      // Skip the calibration offset — relative dB is fine for visual.
      rows[b][f] = 10 * Math.log10(Math.max(pow, 1e-30));
    }
  }

  // Min-max normalize. Floor at -80 dB below peak to keep noise from
  // washing the whole canvas grey when the loudest cell is also quiet.
  let maxDb = -Infinity;
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      if (row[i] > maxDb) maxDb = row[i];
    }
  }
  const minDb = maxDb - 80;
  const range = 80;

  const normalized: number[][] = [];
  for (let b = 0; b < SPECTROGRAM_N_BANDS; b++) {
    const row = rows[b];
    const norm = new Array<number>(row.length);
    for (let i = 0; i < row.length; i++) {
      let v = (row[i] - minDb) / range;
      if (v < 0) v = 0;
      else if (v > 1) v = 1;
      norm[i] = v;
    }
    normalized.push(norm);
  }
  return normalized;
}

/** Pre-bake a palette into a packed RGB lookup table so the per-pixel render
 *  loop avoids string parsing. */
function paletteLut(palette: PaletteKey): Uint8ClampedArray {
  const pal = PALETTES[palette]?.fn ?? PALETTES.heat.fn;
  const lut = new Uint8ClampedArray(LUT_SIZE * 3);
  const rgbRe = /(\d+)/g;
  for (let i = 0; i < LUT_SIZE; i++) {
    const m = pal(i / (LUT_SIZE - 1)).match(rgbRe);
    if (!m) continue;
    lut[i * 3] = +m[0];
    lut[i * 3 + 1] = +m[1];
    lut[i * 3 + 2] = +m[2];
  }
  return lut;
}

interface LiveSpectrogramProps {
  ring: RollingBands;
  palette?: PaletteKey;
  height?: number;
  minDb?: number;
  maxDb?: number;
  /** Show frequency labels along the right edge. */
  showFreqAxis?: boolean;
  /** A small grid overlay (matches the demo TimelineSpectrogram look). */
  showGrid?: boolean;
}

/** Renders a rolling spectrogram canvas from the buffer in ``ring``. Scrolls
 *  left-to-right with the newest frame at the right edge. */
export function LiveSpectrogram({
  ring,
  palette = 'heat',
  height = 180,
  minDb = 20,
  maxDb = 110,
  showFreqAxis = false,
  showGrid = false,
}: LiveSpectrogramProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lut = useMemo(() => paletteLut(palette), [palette]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const F = ring.nBands;
    const T = ring.maxFrames;
    canvas.width = T;
    canvas.height = F;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(T, F);

    const range = Math.max(1, maxDb - minDb);
    const invRange = (LUT_SIZE - 1) / range;
    const frames = ring.frames;
    const leftCol = ring.currentCol - T + 1;
    // Pre-build the floor pixel so columns without data render cheaply.
    let floorClamp = (SPECTROGRAM_FLOOR_DB - minDb) * invRange;
    if (floorClamp < 0) floorClamp = 0;
    else if (floorClamp > LUT_SIZE - 1) floorClamp = LUT_SIZE - 1;
    const floorLutBase = (floorClamp | 0) * 3;

    for (let c = 0; c < T; c++) {
      const bands = frames.get(leftCol + c);
      for (let f = 0; f < F; f++) {
        const srcBand = F - 1 - f;            // flip so high freq sits at top
        const dstBase = f * T * 4;
        const idx = dstBase + c * 4;
        if (bands === undefined) {
          img.data[idx] = lut[floorLutBase];
          img.data[idx + 1] = lut[floorLutBase + 1];
          img.data[idx + 2] = lut[floorLutBase + 2];
          img.data[idx + 3] = 255;
        } else {
          let v = (bands[srcBand] - minDb) * invRange;
          if (v < 0) v = 0;
          else if (v > LUT_SIZE - 1) v = LUT_SIZE - 1;
          const lutBase = (v | 0) * 3;
          img.data[idx] = lut[lutBase];
          img.data[idx + 1] = lut[lutBase + 1];
          img.data[idx + 2] = lut[lutBase + 2];
          img.data[idx + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [ring.frames, ring.version, ring.currentCol, ring.nBands, ring.maxFrames, lut, minDb, maxDb]);

  // Decorative dB tick labels along the left edge for the freq axis.
  const labelHzs = useMemo(
    () => [100, 1000, 10000].filter((hz) => BAND_CENTERS_HZ.includes(hz)),
    [],
  );

  return (
    <div style={{ position: 'relative', width: '100%', height }}>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%', height: '100%', display: 'block',
          imageRendering: 'auto', borderRadius: 4, background: 'var(--bg-2)',
        }}
      />
      {showGrid && (
        <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {[0.25, 0.5, 0.75].map((p) => (
            <line key={p} x1={`${p * 100}%`} x2={`${p * 100}%`} y1="0" y2="100%" stroke="rgba(255,255,255,0.06)" />
          ))}
        </svg>
      )}
      {showFreqAxis && (
        <div style={{
          position: 'absolute', right: 4, top: 0, bottom: 0,
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
          fontFamily: 'var(--mono)', fontSize: 9, color: 'rgba(255,255,255,0.7)',
          pointerEvents: 'none',
        }}>
          {labelHzs.slice().reverse().map((hz) => (
            <span key={hz} style={{
              textShadow: '0 0 4px rgba(0,0,0,0.85)', padding: '0 2px',
            }}>
              {hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

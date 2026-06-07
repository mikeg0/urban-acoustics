import type { Map as MaplibreMap } from 'maplibre-gl';

// Shared "bloom" map layers — the Strava-style heatmap glow + mic glyphs first
// designed for the login backdrop, factored out so the dashboard's Station
// Network map renders an identical effect. Both call addBloomLayers() against a
// geojson source whose point features carry `weight` (drives the heat),
// `has_camera` (selects the glyph) and `online` (dims offline stations).

// Inline microphone glyph — white line-art so it reads against the dark-matter
// basemap and the bloom underneath.
const MIC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`;

// Combined camera+mic glyph for sites with a co-located UDOT camera. Same mic in
// the same 24×24 frame (so both glyphs render at one scale) plus a small camera
// badge on a dark backing in the top-right corner so it stays legible over the
// bright bloom.
const CAM_MIC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/><rect x="13.5" y="0.5" width="10" height="7.5" rx="1.6" fill="#0a0a0a" stroke="#ffffff" stroke-width="1"/><path d="M15.4 2.7 L18.9 2.7 L18.9 5.8 L15.4 5.8 Z M18.9 3.6 L21.7 2.3 L21.7 6.2 L18.9 4.9 Z" fill="#ffffff" stroke="none"/></svg>`;

function addSvgIcon(map: MaplibreMap, id: string, svg: string): void {
  if (map.hasImage(id)) return;
  const img = new Image(40, 40);
  img.onload = () => {
    if (!map.hasImage(id)) map.addImage(id, img, { pixelRatio: 2 });
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Register both station glyphs. Idempotent — safe to call on every map load.
export function loadBloomIcons(map: MaplibreMap): void {
  addSvgIcon(map, 'mic-icon', MIC_SVG);
  addSvgIcon(map, 'cammic-icon', CAM_MIC_SVG);
}

// Map a live LAeq reading onto the heatmap's 0..1 weight. Calibrated to the
// weight↔dB relation baked into sensor-locations.geojson (55.8 dB→0.30,
// 64.1→0.62, 73.5→0.98) so a live-weighted bloom matches the login page's
// intensity. Quiet/idle/offline stations pass weight 0 and don't bloom.
export function dbToHeatWeight(db: number): number {
  return Math.max(0, Math.min(1, (db - 48) / 26));
}

// Add the heat ramp + glyph symbol layers on top of an existing geojson source.
// Expressions are kept inline (vs. extracted consts) so they pick up maplibre's
// contextual typing inside addLayer and stay tsc-clean.
export function addBloomLayers(map: MaplibreMap, sourceId: string): void {
  // Strava-style heat ramp: transparent → purple → magenta → orange →
  // yellow-white at the hot core. Tuned for the dark-matter basemap.
  map.addLayer({
    id: `${sourceId}-heat`,
    type: 'heatmap',
    source: sourceId,
    paint: {
      'heatmap-weight': ['get', 'weight'],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 16, 1.6],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 11, 30, 13, 55, 16, 90],
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(0,0,0,0)',
        0.2, 'rgba(98, 0, 234, 0.55)',
        0.4, 'rgba(255, 0, 122, 0.72)',
        0.6, 'rgba(255, 80, 0, 0.82)',
        0.8, 'rgba(255, 180, 0, 0.88)',
        1.0, 'rgba(255, 240, 200, 0.92)',
      ],
      'heatmap-opacity': 0.85,
    },
  });

  map.addLayer({
    id: `${sourceId}-mics`,
    type: 'symbol',
    source: sourceId,
    layout: {
      // cam+mic glyph where a camera is co-located, plain mic otherwise.
      'icon-image': ['case', ['to-boolean', ['get', 'has_camera']], 'cammic-icon', 'mic-icon'],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.35, 13, 0.5, 16, 0.85],
    },
    paint: {
      // Slightly dim explicitly-offline stations, but keep them clearly white;
      // features without an `online` property (e.g. the login backdrop) stay at
      // full opacity.
      'icon-opacity': ['case', ['==', ['get', 'online'], false], 0.8, 1],
    },
  });
}

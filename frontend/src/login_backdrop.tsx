import { useRef } from 'react';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { Map as MapLibreMap, type MapRef } from 'react-map-gl/maplibre';
import {
  CORRIDOR_BOUNDS,
  CORRIDOR_CENTER,
  CORRIDOR_INITIAL_ZOOM,
  CORRIDOR_MAX_ZOOM,
  CORRIDOR_MIN_ZOOM,
  MAP_STYLE,
} from './mapConfig';

// Inline microphone glyph. White-on-transparent so it reads against the
// dark-matter basemap and the orange heatmap underneath.
const MIC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`;

function loadMicIcon(map: MaplibreMap): void {
  if (map.hasImage('mic-icon')) return;
  const img = new Image(40, 40);
  img.onload = () => {
    if (!map.hasImage('mic-icon')) {
      map.addImage('mic-icon', img, { pixelRatio: 2 });
    }
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(MIC_SVG)}`;
}

function installHeatmapLayers(map: MaplibreMap): void {
  if (map.getSource('uqi-stations')) return;

  map.addSource('uqi-stations', {
    type: 'geojson',
    data: '/sensor-locations.geojson',
  });

  // Strava-style heat ramp: transparent → purple → magenta → orange →
  // yellow-white at the hot core. Tuned for the dark-matter basemap.
  map.addLayer({
    id: 'uqi-heat',
    type: 'heatmap',
    source: 'uqi-stations',
    paint: {
      'heatmap-weight': ['get', 'weight'],
      'heatmap-intensity': [
        'interpolate', ['linear'], ['zoom'],
        11, 0.6,
        16, 1.6,
      ],
      'heatmap-radius': [
        'interpolate', ['linear'], ['zoom'],
        11, 30,
        13, 55,
        16, 90,
      ],
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0,   'rgba(0,0,0,0)',
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
    id: 'uqi-mics',
    type: 'symbol',
    source: 'uqi-stations',
    layout: {
      'icon-image': 'mic-icon',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-size': [
        'interpolate', ['linear'], ['zoom'],
        11, 0.35,
        13, 0.5,
        16, 0.85,
      ],
    },
  });
}

export function LoginBackdrop() {
  const mapRef = useRef<MapRef | null>(null);

  const onLoad = () => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    loadMicIcon(map);
    installHeatmapLayers(map);
    // Static decoration — stop the render loop once tiles settle to spare
    // CPU on the login screen.
    map.once('idle', () => map.stop());
  };

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
      }}
    >
      <MapLibreMap
        ref={mapRef}
        initialViewState={{
          longitude: CORRIDOR_CENTER[0],
          latitude: CORRIDOR_CENTER[1],
          zoom: CORRIDOR_INITIAL_ZOOM,
        }}
        maxBounds={CORRIDOR_BOUNDS}
        minZoom={CORRIDOR_MIN_ZOOM}
        maxZoom={CORRIDOR_MAX_ZOOM}
        mapStyle={MAP_STYLE}
        interactive={false}
        attributionControl={true}
        onLoad={onLoad}
      />
    </div>
  );
}

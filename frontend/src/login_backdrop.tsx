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
import { addBloomLayers, loadBloomIcons } from './uqiHeatmap';

function installHeatmapLayers(map: MaplibreMap): void {
  if (map.getSource('uqi-stations')) return;
  map.addSource('uqi-stations', {
    type: 'geojson',
    data: '/sensor-locations.geojson',
  });
  addBloomLayers(map, 'uqi-stations');
}

export function LoginBackdrop() {
  const mapRef = useRef<MapRef | null>(null);

  const onLoad = () => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    loadBloomIcons(map);
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

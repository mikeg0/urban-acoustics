// Shared map framing for the Urban Quiet Initiative pilot corridor.
// Imported by stations.tsx (live map) and login_backdrop.tsx (decorative
// heatmap behind the login form) so both views frame the corridor identically.

export const CORRIDOR_BOUNDS: [[number, number], [number, number]] = [
  [-111.9300, 40.7400],
  [-111.8500, 40.7850],
];

export const CORRIDOR_CENTER: [number, number] = [-111.8881, 40.7616];
export const CORRIDOR_INITIAL_ZOOM = 12.8;
export const CORRIDOR_MIN_ZOOM = 12;
export const CORRIDOR_MAX_ZOOM = 18;

export const MAP_STYLE =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

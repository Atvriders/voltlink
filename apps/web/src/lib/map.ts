// MapLibre map with a self-hostable style and an offline fictional demo map
// (deterministic street grid + venues) so demo mode needs no external tiles
// or tokens.

import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

export type MapPoint = {
  lat: number;
  lon: number;
  label?: string;
  kind?: 'vehicle' | 'place' | 'charger' | 'geofence' | 'privacy' | 'start' | 'end' | 'route';
};

/** Deterministic fictional city: grid of streets around the demo coordinates. */
export function fictionalCityGeoJson(): { type: 'FeatureCollection'; features: unknown[] } {
  const features: unknown[] = [];
  const center = { lat: 39.0734, lon: -104.6211 };
  const span = 0.11;
  const step = 0.008;
  // Street grid (index-based centre lines so float drift can't hide arterials).
  let latIdx = 0;
  for (let lat = center.lat - span; lat <= center.lat + span; lat += step, latIdx++) {
    const latCenterIdx = Math.round(span / step);
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [center.lon - span * 1.4, lat],
          [center.lon + span * 1.4, lat],
        ],
      },
      properties: { kind: latIdx === latCenterIdx ? 'arterial' : 'street' },
    });
  }
  let lonIdx = 0;
  for (let lon = center.lon - span * 1.4; lon <= center.lon + span * 1.4; lon += step, lonIdx++) {
    const lonCenterIdx = Math.round((span * 1.4) / step);
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [lon, center.lat - span],
          [lon, center.lat + span],
        ],
      },
      properties: { kind: lonIdx === lonCenterIdx ? 'arterial' : 'street' },
    });
  }
  // Lake in the northeast
  features.push({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [center.lon + 0.03, center.lat + 0.055],
          [center.lon + 0.055, center.lat + 0.07],
          [center.lon + 0.04, center.lat + 0.095],
          [center.lon + 0.012, center.lat + 0.08],
          [center.lon + 0.03, center.lat + 0.055],
        ],
      ],
    },
    properties: { kind: 'water' },
  });
  // Parks
  features.push({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [center.lon - 0.055, center.lat - 0.04],
          [center.lon - 0.03, center.lat - 0.04],
          [center.lon - 0.03, center.lat - 0.075],
          [center.lon - 0.055, center.lat - 0.075],
          [center.lon - 0.055, center.lat - 0.04],
        ],
      ],
    },
    properties: { kind: 'park' },
  });
  return { type: 'FeatureCollection', features };
}

export function buildStyle(): {
  version: number;
  sources: Record<string, unknown>;
  layers: unknown[];
} {
  return {
    version: 8,
    sources: {
      city: { type: 'geojson', data: fictionalCityGeoJson() },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#0d1419' } },
      {
        id: 'water',
        type: 'fill',
        source: 'city',
        filter: ['==', ['get', 'kind'], 'water'],
        paint: { 'fill-color': '#1b3a4f', 'fill-opacity': 0.9 },
      },
      {
        id: 'park',
        type: 'fill',
        source: 'city',
        filter: ['==', ['get', 'kind'], 'park'],
        paint: { 'fill-color': '#173020', 'fill-opacity': 0.9 },
      },
      {
        id: 'streets',
        type: 'line',
        source: 'city',
        filter: ['==', ['get', 'kind'], 'street'],
        paint: { 'line-color': '#2b3947', 'line-width': 1.4 },
      },
      {
        id: 'arterials',
        type: 'line',
        source: 'city',
        filter: ['==', ['get', 'kind'], 'arterial'],
        paint: { 'line-color': '#3d5266', 'line-width': 2.6 },
      },
    ],
  };
}

export function createMap(container: HTMLElement, interactive = true): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    style: buildStyle() as never,
    center: [-104.6211, 39.0734],
    zoom: 12.2,
    interactive,
    attributionControl: false,
  });
  return map;
}

/** GeoJSON for drive routes (trimmed for long routes). */
export function routeGeoJson(points: { lat: number; lon: number }[]): {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: number[][] };
} {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: points.map((p) => [p.lon, p.lat]) },
  };
}

/** Circle polygon helper for geofences/privacy zones. */
export function circleGeoJson(
  lat: number,
  lon: number,
  radiusM: number,
): { type: 'Feature'; geometry: { type: 'Polygon'; coordinates: number[][][] } } {
  const pts: number[][] = [];
  const R = 6378137;
  for (let a = 0; a <= 64; a++) {
    const ang = (a / 64) * Math.PI * 2;
    const dLat = (radiusM * Math.cos(ang)) / R;
    const dLon = (radiusM * Math.sin(ang)) / (R * Math.cos((lat * Math.PI) / 180));
    pts.push([lon + (dLon * 180) / Math.PI, lat + (dLat * 180) / Math.PI]);
  }
  pts.push(pts[0]!);
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] } };
}

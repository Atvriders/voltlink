// Reusable MapLibre component: fictional demo map with vehicles, places,
// geofences, privacy zones, and route replay. No external tile service.

import { useEffect, useRef, useState } from 'react';
import type * as maplibregl from 'maplibre-gl';
import { circleGeoJson, createMap, routeGeoJson } from '../lib/map';
import { hasWebGL2 } from '../lib/webgl';
import type { MapStyleRef } from './map/useMapStyle';

export interface MapLayer {
  id: string;
  kind: 'route' | 'vehicle' | 'place' | 'charger' | 'geofence' | 'privacy' | 'marker' | 'replay';
  feature: unknown;
  color?: string;
  label?: string;
}

export default function MapView({
  layers,
  onReady,
  onPointPick,
  height = 420,
  className = '',
  mapStyle,
}: {
  layers?: MapLayer[];
  onReady?: (map: maplibregl.Map) => void;
  onPointPick?: (lat: number, lon: number) => void;
  height?: number;
  className?: string;
  mapStyle?: MapStyleRef | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onPointPickRef = useRef(onPointPick);
  onPointPickRef.current = onPointPick;
  const mapStyleRef = useRef(mapStyle);
  mapStyleRef.current = mapStyle;
  const [unavailable, setUnavailable] = useState(false);

  // F-MAPLOOP: this effect depends on nothing — callbacks live in refs, so the
  // map is created exactly once per mount and never torn down on re-render.
  useEffect(() => {
    if (!container.current) return;
    if (!hasWebGL2()) {
      setUnavailable(true);
      return;
    }
    let map: maplibregl.Map;
    try {
      map = createMap(container.current, true, mapStyleRef.current?.style);
    } catch (err) {
      // F-WEBGLBLANK: GPUInitializationError / context loss never blanks the
      // app — show the fallback card and keep the page usable.
      console.error('[voltlink] map unavailable:', err);
      setUnavailable(true);
      return;
    }
    mapRef.current = map;
    map.on('click', (e) => {
      onPointPickRef.current?.(e.lngLat.lat, e.lngLat.lng);
    });
    onReadyRef.current?.(map);

    const draw = () => {
      const ls = layersRef.current ?? [];
      const known = new Set<string>();
      for (const l of ls) {
        known.add(l.id);
        const sourceId = `src-${l.id}`;
        if (!map.getSource(sourceId)) {
          map.addSource(sourceId, { type: 'geojson', data: l.feature as never });
        } else {
          (map.getSource(sourceId) as maplibregl.GeoJSONSource).setData(l.feature as never);
        }
        if (!map.getLayer(`lyr-${l.id}`)) {
          map.addLayer(buildLayer(l, sourceId));
        }
      }
      // remove stale
      const srcs = map.getStyle().layers?.filter((ly) => ly.id.startsWith('lyr-'));
      for (const ly of srcs ?? []) {
        if (!known.has(ly.id.replace('lyr-', ''))) {
          map.removeLayer(ly.id);
          if (map.getSource(`src-${ly.id.replace('lyr-', '')}`))
            map.removeSource(`src-${ly.id.replace('lyr-', '')}`);
        }
      }
    };
    // The style loads asynchronously; addSource/addLayer throw until then.
    if (map.loaded()) {
      draw();
    } else {
      map.once('load', draw);
    }
    const timer = setInterval(() => {
      if (map.loaded()) draw();
    }, 4000);
    return () => {
      clearInterval(timer);
      try {
        map.remove();
      } catch {
        // style never finished loading
      }
      mapRef.current = null;
    };
  }, []);

  if (unavailable) {
    return (
      <div
        role="note"
        className={`flex items-center justify-center rounded-xl border border-line bg-panel2 ${className}`}
        style={{ height }}
      >
        <p className="text-sm text-subtle">Map unavailable on this device</p>
      </div>
    );
  }
  return (
    <div
      ref={container}
      className={`rounded-xl border border-line ${className}`}
      style={{ height }}
      aria-label="Map"
    />
  );
}

function buildLayer(l: MapLayer, sourceId: string): maplibregl.LayerSpecification {
  const color = l.color ?? '#0ea5e9';
  switch (l.kind) {
    case 'route':
    case 'replay':
      return {
        id: `lyr-${l.id}`,
        type: 'line',
        source: sourceId,
        paint: {
          'line-color': l.kind === 'replay' ? '#fbbf24' : color,
          'line-width': l.kind === 'replay' ? 4 : 3,
          'line-opacity': 0.9,
        },
      };
    case 'geofence':
    case 'privacy':
      return {
        id: `lyr-${l.id}`,
        type: 'fill',
        source: sourceId,
        paint: {
          'fill-color': l.kind === 'geofence' ? '#0ea5e9' : '#8b5cf6',
          'fill-opacity': l.kind === 'geofence' ? 0.08 : 0.12,
        },
      };
    case 'vehicle':
      return {
        id: `lyr-${l.id}`,
        type: 'circle',
        source: sourceId,
        paint: {
          'circle-color': color,
          'circle-radius': 8,
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      };
    case 'place':
      return {
        id: `lyr-${l.id}`,
        type: 'circle',
        source: sourceId,
        paint: {
          'circle-color': color,
          'circle-radius': 6,
          'circle-stroke-color': '#0b1017',
          'circle-stroke-width': 1.5,
        },
      };
    case 'charger':
      return {
        id: `lyr-${l.id}`,
        type: 'circle',
        source: sourceId,
        paint: {
          'circle-color': '#4ade80',
          'circle-radius': 7,
          'circle-stroke-color': '#0b1017',
          'circle-stroke-width': 2,
        },
      };
    default:
      return {
        id: `lyr-${l.id}`,
        type: 'circle',
        source: sourceId,
        paint: { 'circle-color': color, 'circle-radius': 5 },
      };
  }
}

export { circleGeoJson, routeGeoJson };

// F-MAPGRID: resolve the basemap from the server's instance configuration.
// demo → fictional grid (air-gapped safe); pmtiles → self-hosted Protomaps
// served from the app's /tiles mount; style → operator-supplied style URL.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { buildStyle as buildDemoStyle } from '../../lib/map';

export interface ClientConfig {
  map: {
    mode: 'demo' | 'pmtiles' | 'style';
    styleUrl?: string;
    pmtilesUrl?: string;
    assetsUrl: string;
    attribution?: string;
  };
  geocoder: { enabled: boolean; autocomplete: boolean };
}

export interface MapStyleRef {
  key: string;
  style: unknown; // StyleSpecification | string
  mode: 'demo' | 'pmtiles' | 'style';
}

export function useClientConfig() {
  return useQuery({
    queryKey: ['client-config'],
    queryFn: () => api<ClientConfig>('/api/v1/config/client'),
    staleTime: Infinity,
  });
}

export function useMapStyle(): MapStyleRef | null {
  const { data } = useClientConfig();
  const theme = document.documentElement.getAttribute('data-theme') ?? 'voltlink-dark';
  return useMemo(() => {
    if (!data) return null;
    const m = data.map;
    const dark = !['voltlink-light', 'colorblind-safe'].includes(theme);
    const abs = (p: string) => new URL(p, window.location.origin).href;
    if (m.mode === 'style' && m.styleUrl) {
      return { key: `style:${m.styleUrl}`, style: m.styleUrl, mode: m.mode };
    }
    if (m.mode === 'pmtiles' && m.pmtilesUrl) {
      return {
        key: `pmtiles:${m.pmtilesUrl}:${dark ? 'dark' : 'light'}`,
        mode: m.mode,
        style: {
          version: 8,
          name: 'VoltLink PMTiles',
          glyphs: `${abs(m.assetsUrl)}/fonts/{fontstack}/{range}.pbf`,
          sprite: `${abs(m.assetsUrl)}/sprites/v4/${dark ? 'dark' : 'light'}`,
          sources: {
            protomaps: {
              type: 'vector',
              url: `pmtiles://${abs(m.pmtilesUrl)}`,
              attribution: m.attribution ?? '© OpenStreetMap',
            },
          },
          layers: protomapsLayers(dark),
        },
      };
    }
    return { key: `demo:${theme}`, style: buildDemoStyle(), mode: 'demo' };
  }, [data, theme]);
}

// A compact Protomaps layer stack (protomaps/basemaps v4 layer ids). Road,
// water, landcover and label layers use the v4 `kind`/`pmap:kind` fields.
function protomapsLayers(dark: boolean): Record<string, unknown>[] {
  const bg = dark ? '#15181d' : '#f7f6f2';
  const water = dark ? '#1f2937' : '#aad3df';
  const park = dark ? '#1c2a24' : '#c8e6c9';
  const roadMinor = dark ? '#3a4453' : '#ffffff';
  const roadMajor = dark ? '#4b5869' : '#f5e9d8';
  const label = dark ? '#cbd5e1' : '#3a3a3a';
  const fill = (source: string, color: string, filter?: unknown[]) => ({
    type: 'fill',
    source,
    ...(filter ? { filter } : {}),
    paint: { 'fill-color': color, 'fill-opacity': 0.9 },
  });
  const line = (source: string, color: string, width: number, filter?: unknown[]) => ({
    type: 'line',
    source,
    ...(filter ? { filter } : {}),
    paint: { 'line-color': color, 'line-width': width },
  });
  const symbol = (source: string, color: string, size: number, filter?: unknown[]) => ({
    type: 'symbol',
    source,
    ...(filter ? { filter } : {}),
    layout: {
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-size': size,
      'symbol-placement': 'point',
    },
    paint: { 'text-color': color, 'text-halo-color': bg, 'text-halo-width': 1.2 },
  });
  return [
    { id: 'background', type: 'background', paint: { 'background-color': bg } },
    fill('protomaps', water, ['==', ['get', 'pmap:kind'], 'water']),
    fill('protomaps', park, [
      'in',
      ['get', 'pmap:kind'],
      ['literal', ['park', 'forest', 'wood', 'nature_reserve']],
    ]),
    line('protomaps', roadMinor, 0.8, ['==', ['get', 'pmap:kind'], 'minor_road']),
    line('protomaps', roadMajor, 1.6, ['==', ['get', 'pmap:kind'], 'major_road']),
    line('protomaps', roadMajor, 2.4, ['==', ['get', 'pmap:kind'], 'highway']),
    symbol('protomaps', label, 10, ['==', ['get', 'pmap:kind'], 'locality']),
    symbol('protomaps', label, 9, ['==', ['get', 'pmap:kind'], 'neighbourhood']),
  ];
}

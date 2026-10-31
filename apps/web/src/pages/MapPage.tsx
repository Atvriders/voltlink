// Map page: live locations, saved places, geofences, privacy zones, and
// location search on the fictional demo map.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Crosshair, MapPin, Plus, Shield } from 'lucide-react';
import type * as maplibregl from 'maplibre-gl';
import { api } from '../api/client';
import { useAnnounce } from '../lib/announcer';
import { ErrorState } from '../components/QueryState';
import MapView, { circleGeoJson } from '../components/MapView';
import { Badge, Button, Card, Field, Input, Modal, Select } from '../components/ui';
import type { Geofence, Place, PrivacyZone, VehicleWithState } from '@voltlink/shared';

export default function MapPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string>('all');
  const [addPlace, setAddPlace] = useState(false);
  const [pick, setPick] = useState<{ lat: number; lon: number } | null>(null);
  // Esc cancels place picking (guide 07 §1.5).
  useEffect(() => {
    if (!addPlace) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAddPlace(false);
        setPick(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addPlace]);
  const [placeName, setPlaceName] = useState('');
  const [placeType, setPlaceType] = useState('custom');
  const [map, setMap] = useState<maplibregl.Map | null>(null);

  const {
    data: vehicles,
    isError: vehiclesError,
    error: vehiclesErr,
    refetch: refetchVehicles,
  } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => api<VehicleWithState[]>('/api/v1/vehicles'),
    refetchInterval: 15000,
  });
  const {
    data: places,
    isError: placesError,
    error: placesErr,
  } = useQuery({
    queryKey: ['places'],
    queryFn: () => api<Place[]>('/api/v1/vehicles/places/all'),
  });
  const {
    data: fences,
    isError: fencesError,
    error: fencesErr,
  } = useQuery({
    queryKey: ['geofences'],
    queryFn: () => api<Geofence[]>('/api/v1/vehicles/geofences/all'),
  });
  const {
    data: zones,
    isError: zonesError,
    error: zonesErr,
  } = useQuery({
    queryKey: ['privacy'],
    queryFn: () => api<PrivacyZone[]>('/api/v1/vehicles/privacy-zones'),
  });

  const layerError =
    vehiclesError || placesError || fencesError || zonesError
      ? (vehiclesErr ?? placesErr ?? fencesErr ?? zonesErr)
      : null;

  const layers = useMemo(() => {
    const out: {
      id: string;
      kind: 'vehicle' | 'place' | 'charger' | 'geofence' | 'privacy';
      feature: unknown;
      color?: string;
    }[] = [];
    for (const v of vehicles ?? []) {
      if (selected !== 'all' && v.id !== selected) continue;
      const s = v.state;
      if (s?.lat === undefined || s?.lon === undefined) continue;
      out.push({
        id: `vehicle-${v.id}`,
        kind: 'vehicle',
        color: v.exteriorColor ?? '#0ea5e9',
        feature: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
          properties: { name: v.displayName, address: s.address ?? '' },
        },
      });
    }
    for (const p of places ?? []) {
      out.push({
        id: `place-${p.id}`,
        kind: p.type === 'charger' ? 'charger' : 'place',
        color: p.type === 'home' ? '#f472b6' : p.type === 'work' ? '#38bdf8' : '#94a3b8',
        feature: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          properties: { name: p.name },
        },
      });
    }
    for (const f of (fences ?? []).filter((f) => f.enabled)) {
      out.push({
        id: `fence-${f.id}`,
        kind: 'geofence',
        feature: circleGeoJson(f.lat, f.lon, f.radiusM),
      });
    }
    for (const z of (zones ?? []).filter((z) => z.enabled)) {
      out.push({
        id: `zone-${z.id}`,
        kind: 'privacy',
        feature: circleGeoJson(z.lat, z.lon, z.radiusM),
      });
    }
    return out;
  }, [vehicles, places, fences, zones, selected]);

  const flyTo = (lat: number, lon: number) => {
    map?.flyTo({ center: [lon, lat], zoom: 14, duration: 1200 });
  };

  const announce = useAnnounce();
  const savePlace = async () => {
    if (!pick || !placeName) return;
    await api('/api/v1/vehicles/places/all', {
      method: 'POST',
      body: { name: placeName, type: placeType, lat: pick.lat, lon: pick.lon, radiusM: 150 },
    });
    announce(`Place saved: ${placeName}`);
    setAddPlace(false);
    setPick(null);
    setPlaceName('');
    await qc.invalidateQueries({ queryKey: ['places'] });
  };

  return (
    <div className="space-y-4">
      {layerError && (
        <ErrorState
          title="Couldn’t load map data"
          error={layerError}
          onRetry={() => void refetchVehicles()}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-extrabold">Map</h1>
        <span className="text-xs text-faint">
          Fictional demo region — configure real tiles in production
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Select
            aria-label="Vehicle filter"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="text-xs"
          >
            <option value="all">All vehicles</option>
            {(vehicles ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.displayName}
              </option>
            ))}
          </Select>
          <Button
            onClick={() => {
              setAddPlace(true);
              setPick(null);
            }}
          >
            <Plus size={14} /> Save place
          </Button>
        </div>
      </div>

      {addPlace && !pick && (
        <div
          role="status"
          className="mb-2 flex items-center justify-between rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm"
        >
          <span>Click the map to place it, or use the map centre. Esc cancels.</span>
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            onClick={() => {
              const c = map?.getCenter();
              if (c) setPick({ lat: c.lat, lon: c.lng });
            }}
          >
            Use map centre
          </Button>
        </div>
      )}
      <MapView
        layers={layers}
        onReady={setMap}
        onPointPick={(lat, lon) => addPlace && setPick({ lat, lon })}
        height={520}
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card
          title="Saved places"
          actions={
            <Link className="text-xs text-accent hover:underline" to="/settings/privacy">
              Manage in settings
            </Link>
          }
        >
          <ul className="space-y-1">
            {(places ?? []).map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => flyTo(p.lat, p.lon)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-panel2"
                >
                  <MapPin
                    size={13}
                    className={p.type === 'charger' ? 'text-charging' : 'text-subtle'}
                  />
                  {p.name}
                  <span className="ml-auto text-xs capitalize text-faint">{p.type}</span>
                </button>
              </li>
            ))}
            {(places ?? []).length === 0 && (
              <p className="py-2 text-sm text-faint">No places saved.</p>
            )}
          </ul>
        </Card>
        <Card title="Geofences">
          <ul className="space-y-1">
            {(fences ?? []).map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm"
              >
                <button
                  onClick={() => flyTo(f.lat, f.lon)}
                  className="flex items-center gap-2 hover:text-accent"
                >
                  <Crosshair size={13} className="text-accent" /> {f.name}
                </button>
                {!f.enabled && <Badge tone="neutral">off</Badge>}
              </li>
            ))}
            {(fences ?? []).length === 0 && (
              <p className="py-2 text-sm text-faint">No geofences.</p>
            )}
          </ul>
        </Card>
        <Card title="Privacy zones">
          <ul className="space-y-1">
            {(zones ?? []).map((z) => (
              <li
                key={z.id}
                className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm"
              >
                <button
                  onClick={() => flyTo(z.lat, z.lon)}
                  className="flex items-center gap-2 hover:text-accent"
                >
                  <Shield size={13} className="text-info" /> {z.name}
                </button>
                <span className="text-xs text-faint">{(z.radiusM / 1000).toFixed(1)} km</span>
              </li>
            ))}
            {(zones ?? []).length === 0 && (
              <p className="py-2 text-sm text-faint">No privacy zones.</p>
            )}
          </ul>
        </Card>
      </div>

      {addPlace && (
        <form
          className="card mb-4 space-y-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (pick && placeName) savePlace();
          }}
        >
          <p className="text-sm text-subtle">
            {pick
              ? `Selected: ${pick.lat.toFixed(4)}, ${pick.lon.toFixed(4)}`
              : 'Click the map to choose a location, then name it.'}
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name">
              <Input value={placeName} onChange={(e) => setPlaceName(e.target.value)} />
            </Field>
            <Field label="Type">
              <Select value={placeType} onChange={(e) => setPlaceType(e.target.value)}>
                <option value="custom">Custom</option>
                <option value="home">Home</option>
                <option value="work">Work</option>
                <option value="charger">Charger</option>
              </Select>
            </Field>
            <div className="flex items-end gap-2">
              <Button variant="ghost" onClick={() => setAddPlace(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!pick || !placeName}>
                Save place
              </Button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

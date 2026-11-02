// Map page: basemap from instance config (F-MAPGRID), pick-mode place /
// geofence / privacy-zone creation (NEW-12) and a collapsible side panel that
// mirrors every map fact as accessible list text with named actions (F-NOUI).

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Pencil, Plus, Trash2 } from 'lucide-react';
import type * as maplibregl from 'maplibre-gl';
import { api } from '../api/client';
import { useAnnounce } from '../lib/announcer';
import { ErrorState } from '../components/QueryState';
import MapView, { circleGeoJson, routeGeoJson } from '../components/MapView';
import GeocodeSearch from '../components/map/GeocodeSearch';
import { useMapStyle } from '../components/map/useMapStyle';
import { useSelectedVehicle } from '../lib/vehicleSelection';
import { Button, Field, Input, Select } from '../components/ui';
import type {
  ChargeSession,
  Geofence,
  Place,
  PrivacyZone,
  VehicleWithState,
} from '@voltlink/shared';

type Draft = { kind: 'place' | 'geofence' | 'privacy'; point?: { lat: number; lon: number } };

type EditState =
  | { kind: 'place'; id: string; name: string; type: string; radiusM: number }
  | { kind: 'geofence'; id: string; name: string; radiusM: number; enabled: boolean }
  | { kind: 'privacy'; id: string; name: string; radiusM: number };

export default function MapPage() {
  const qc = useQueryClient();
  const { selectedId, setVehicle } = useSelectedVehicle();
  // §2.8: the URL (?vehicle=) or recent pick is the initial filter.
  const [selected, setSelected] = useState<string>(selectedId ?? 'all');
  const [draft, setDraft] = useState<Draft | null>(null);
  const picking = !!draft && !draft.point;
  // Esc cancels pick mode (guide 07 §1.5).
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDraft(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking]);
  const [placeName, setPlaceName] = useState('');
  const [placeType, setPlaceType] = useState('custom');
  const [zoneName, setZoneName] = useState('');
  const [zoneRadius, setZoneRadius] = useState(500);
  const [alertOn, setAlertOn] = useState('both');
  const [edit, setEdit] = useState<EditState | null>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const announce = useAnnounce();

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
  const { data: charges } = useQuery({
    queryKey: ['map-charging'],
    queryFn: () =>
      api<{ items: ChargeSession[] }>('/api/v1/charging?pageSize=50').then((d) => d.items),
  });
  const { data: drivesForMap } = useQuery({
    queryKey: ['map-drives', selected],
    queryFn: () => {
      const qs = new URLSearchParams({ pageSize: '1' });
      if (selected !== 'all') qs.set('vehicleId', selected);
      return api<{ items: { id: string }[] }>(`/api/v1/drives?${qs.toString()}`);
    },
  });
  const driveId = drivesForMap?.items?.[0]?.id;
  const { data: latestRoute } = useQuery({
    queryKey: ['map-route', driveId],
    enabled: !!driveId,
    queryFn: () =>
      api<{ data: { route?: { lat: number; lon: number }[] } }>(
        `/api/v1/drives/${driveId}?route=true`,
      ).then((d) => d.data.route),
  });

  const layerError =
    vehiclesError || placesError || fencesError || zonesError
      ? (vehiclesErr ?? placesErr ?? fencesErr ?? zonesErr)
      : null;

  // F-MAPGRID: the basemap comes from the instance configuration.
  const mapStyle = useMapStyle();

  const layers = useMemo(() => {
    const out: {
      id: string;
      kind: 'vehicle' | 'heading' | 'route' | 'place' | 'charger' | 'geofence' | 'privacy';
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
      // L813: heading indicator — a short line drawn from the vehicle marker.
      if (typeof s.headingDeg === 'number') {
        const rad = (s.headingDeg * Math.PI) / 180;
        const d = 0.0009; // ~100 m
        out.push({
          id: `heading-${v.id}`,
          kind: 'heading',
          color: v.exteriorColor ?? '#0ea5e9',
          feature: {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [s.lon, s.lat],
                [s.lon + d * Math.sin(rad), s.lat + d * Math.cos(rad)],
              ],
            },
            properties: { name: v.displayName },
          },
        });
      }
    }
    for (const c of charges ?? []) {
      if (c.lat === undefined || c.lon === undefined) continue;
      out.push({
        id: `charge-session-${c.id}`,
        kind: 'charger',
        feature: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
          properties: { name: c.locationName ?? c.vehicleName },
        },
      });
    }
    if (latestRoute && latestRoute.length > 1) {
      out.push({
        id: 'latest-route',
        kind: 'route',
        feature: routeGeoJson(latestRoute.map((p) => ({ lat: p.lat, lon: p.lon }))),
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
  }, [vehicles, places, fences, zones, selected, charges, latestRoute]);

  const flyTo = (lat: number, lon: number) => {
    map?.flyTo({ center: [lon, lat], zoom: 14, duration: 1200 });
  };

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ['places'] });
    await qc.invalidateQueries({ queryKey: ['geofences'] });
    await qc.invalidateQueries({ queryKey: ['privacy'] });
  };

  const startDraft = (kind: Draft['kind']) => {
    setDraft({ kind });
    setEdit(null);
  };

  const saveDraft = async () => {
    if (!draft?.point) return;
    try {
      if (draft.kind === 'place' && placeName.trim()) {
        await api('/api/v1/vehicles/places/all', {
          method: 'POST',
          body: {
            name: placeName.trim(),
            type: placeType,
            lat: draft.point.lat,
            lon: draft.point.lon,
            radiusM: 150,
          },
        });
        announce(`Place saved: ${placeName.trim()}`);
        setPlaceName('');
      } else if (draft.kind === 'geofence' && zoneName.trim()) {
        await api('/api/v1/vehicles/geofences/all', {
          method: 'POST',
          body: {
            name: zoneName.trim(),
            lat: draft.point.lat,
            lon: draft.point.lon,
            radiusM: zoneRadius,
            enabled: true,
            alertOn,
          },
        });
        announce(`Geofence saved: ${zoneName.trim()}`);
        setZoneName('');
      } else if (draft.kind === 'privacy' && zoneName.trim()) {
        await api('/api/v1/vehicles/privacy-zones', {
          method: 'POST',
          body: {
            name: zoneName.trim(),
            lat: draft.point.lat,
            lon: draft.point.lon,
            radiusM: zoneRadius,
          },
        });
        announce(`Privacy zone saved: ${zoneName.trim()}`);
        setZoneName('');
      }
      setDraft(null);
      await invalidate();
    } catch {
      announce('Save failed');
    }
  };

  const saveEdit = async () => {
    if (!edit) return;
    try {
      if (edit.kind === 'place') {
        await api(`/api/v1/vehicles/places/all/${edit.id}`, {
          method: 'PATCH',
          body: { name: edit.name, type: edit.type, radiusM: edit.radiusM },
        });
      } else if (edit.kind === 'geofence') {
        await api(`/api/v1/vehicles/geofences/all/${edit.id}`, {
          method: 'PATCH',
          body: { name: edit.name, radiusM: edit.radiusM, enabled: edit.enabled },
        });
      } else {
        await api(`/api/v1/vehicles/privacy-zones/${edit.id}`, {
          method: 'PATCH',
          body: { name: edit.name, radiusM: edit.radiusM },
        });
      }
      announce('Saved');
      setEdit(null);
      await invalidate();
    } catch {
      announce('Save failed');
    }
  };

  const deleteItem = async (e: EditState['kind'], id: string, name: string) => {
    try {
      const path =
        e === 'place'
          ? `/api/v1/vehicles/places/all/${id}`
          : e === 'geofence'
            ? `/api/v1/vehicles/geofences/all/${id}`
            : `/api/v1/vehicles/privacy-zones/${id}`;
      await api(path, { method: 'DELETE' });
      announce(`Deleted ${e} ${name}`);
      if (edit?.id === id) setEdit(null);
      await invalidate();
    } catch {
      announce('Delete failed');
    }
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
          {mapStyle?.mode === 'demo'
            ? 'Fictional demo map — configure real tiles via VL_MAP_MODE'
            : mapStyle?.mode === 'pmtiles'
              ? 'Self-hosted tiles (PMTiles)'
              : 'Operator map style'}
        </span>
        {mapStyle?.mode === 'demo' && (vehicles ?? []).length > 0 && (
          <span className="text-xs text-warn">
            Demo basemap — VL_MAP_MODE=demo shows real vehicles on fictional tiles
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <GeocodeSearch
            onChoose={(r) => {
              flyTo(r.lat, r.lon);
              setPlaceName(r.label);
              if (r.kind === 'charger') setPlaceType('charger');
              setDraft({ kind: 'place', point: { lat: r.lat, lon: r.lon } });
            }}
          />
          <Select
            aria-label="Vehicle filter"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              if (e.target.value !== 'all') setVehicle(e.target.value);
            }}
            className="text-xs"
          >
            <option value="all">All vehicles</option>
            {(vehicles ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.displayName}
              </option>
            ))}
          </Select>
          <Button onClick={() => startDraft('place')}>
            <Plus size={14} /> Add place
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-3">
          {picking && (
            <div
              role="status"
              className="flex items-center justify-between rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm"
            >
              <span>
                Click the map to place the {draft!.kind}, or use the map centre. Esc cancels.
              </span>
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs"
                onClick={() => {
                  const c = map?.getCenter();
                  if (c) setDraft((d) => (d ? { ...d, point: { lat: c.lat, lon: c.lng } } : d));
                }}
              >
                Use map centre
              </Button>
            </div>
          )}
          <MapView
            layers={layers}
            onReady={setMap}
            onPointPick={(lat, lon) =>
              setDraft((d) => {
                if (!d || d.point) return d;
                return { ...d, point: { lat, lon } };
              })
            }
            height={520}
            mapStyle={mapStyle}
          />
          {draft?.point && (
            <form
              className="card space-y-3 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                void saveDraft();
              }}
            >
              <p className="text-sm text-subtle">
                Selected: {draft.point.lat.toFixed(4)}, {draft.point.lon.toFixed(4)} ·{' '}
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => setDraft({ ...draft, point: undefined })}
                >
                  Repick
                </button>
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Name">
                  <Input
                    value={draft.kind === 'place' ? placeName : zoneName}
                    onChange={(e) =>
                      draft.kind === 'place'
                        ? setPlaceName(e.target.value)
                        : setZoneName(e.target.value)
                    }
                  />
                </Field>
                {draft.kind === 'place' ? (
                  <Field label="Type">
                    <Select value={placeType} onChange={(e) => setPlaceType(e.target.value)}>
                      <option value="custom">Custom</option>
                      <option value="home">Home</option>
                      <option value="work">Work</option>
                      <option value="charger">Charger</option>
                    </Select>
                  </Field>
                ) : (
                  <Field label="Radius (m)">
                    <Input
                      type="number"
                      min={draft.kind === 'privacy' ? 50 : 10}
                      max={10000}
                      value={zoneRadius}
                      onChange={(e) => setZoneRadius(Number(e.target.value))}
                    />
                  </Field>
                )}
                {draft.kind === 'geofence' && (
                  <Field label="Alert on">
                    <Select value={alertOn} onChange={(e) => setAlertOn(e.target.value)}>
                      <option value="enter">Enter</option>
                      <option value="leave">Leave</option>
                      <option value="both">Both</option>
                    </Select>
                  </Field>
                )}
                <div className="flex items-end gap-2">
                  <Button variant="ghost" onClick={() => setDraft(null)}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={draft.kind === 'place' ? !placeName.trim() : !zoneName.trim()}
                  >
                    Save {draft.kind}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </div>

        <aside aria-label="Map layers" className="space-y-2">
          <Section title="Vehicles" count={(vehicles ?? []).length}>
            {(vehicles ?? []).map((v) => (
              <Row
                key={v.id}
                label={v.displayName}
                onShow={() => {
                  const s = v.state;
                  if (s && s.lat !== undefined && s.lon !== undefined) flyTo(s.lat, s.lon);
                }}
              />
            ))}
          </Section>

          <Section title="Places" count={(places ?? []).length} onAdd={() => startDraft('place')}>
            {edit?.kind === 'place' && (
              <EditRow
                name={edit.name}
                setName={(name) => setEdit({ ...edit, name })}
                extra={
                  <Select
                    aria-label="Place type"
                    value={edit.type}
                    onChange={(e) => setEdit({ ...edit, type: e.target.value })}
                    className="text-xs"
                  >
                    <option value="custom">Custom</option>
                    <option value="home">Home</option>
                    <option value="work">Work</option>
                    <option value="charger">Charger</option>
                  </Select>
                }
                onSave={() => void saveEdit()}
                onCancel={() => setEdit(null)}
              />
            )}
            {(places ?? []).map((p) => (
              <Row
                key={p.id}
                label={p.name}
                hint={p.type}
                onShow={() => flyTo(p.lat, p.lon)}
                onEdit={() =>
                  setEdit({
                    kind: 'place',
                    id: p.id,
                    name: p.name,
                    type: p.type,
                    radiusM: p.radiusM ?? 150,
                  })
                }
                onDelete={() => void deleteItem('place', p.id, p.name)}
              />
            ))}
          </Section>

          <Section
            title="Geofences"
            count={(fences ?? []).length}
            onAdd={() => startDraft('geofence')}
          >
            {edit?.kind === 'geofence' && (
              <EditRow
                name={edit.name}
                setName={(name) => setEdit({ ...edit, name })}
                extra={
                  <label className="flex items-center gap-1 text-xs text-subtle">
                    <input
                      type="checkbox"
                      checked={edit.enabled}
                      onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })}
                    />{' '}
                    Enabled
                  </label>
                }
                onSave={() => void saveEdit()}
                onCancel={() => setEdit(null)}
              />
            )}
            {(fences ?? []).map((f) => (
              <Row
                key={f.id}
                label={f.name}
                hint={f.enabled ? `${(f.radiusM / 1000).toFixed(1)} km` : 'off'}
                onShow={() => flyTo(f.lat, f.lon)}
                onEdit={() =>
                  setEdit({
                    kind: 'geofence',
                    id: f.id,
                    name: f.name,
                    radiusM: f.radiusM,
                    enabled: f.enabled,
                  })
                }
                onDelete={() => void deleteItem('geofence', f.id, f.name)}
              />
            ))}
          </Section>

          <Section
            title="Privacy zones"
            count={(zones ?? []).length}
            onAdd={() => startDraft('privacy')}
          >
            {edit?.kind === 'privacy' && (
              <EditRow
                name={edit.name}
                setName={(name) => setEdit({ ...edit, name })}
                onSave={() => void saveEdit()}
                onCancel={() => setEdit(null)}
              />
            )}
            {(zones ?? []).map((z) => (
              <Row
                key={z.id}
                label={z.name}
                hint={`${(z.radiusM / 1000).toFixed(1)} km`}
                onShow={() => flyTo(z.lat, z.lon)}
                onEdit={() =>
                  setEdit({ kind: 'privacy', id: z.id, name: z.name, radiusM: z.radiusM })
                }
                onDelete={() => void deleteItem('privacy', z.id, z.name)}
              />
            ))}
          </Section>
        </aside>
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  onAdd,
  children,
}: {
  title: string;
  count: number;
  onAdd?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-2">
      <div className="flex items-center gap-2 px-2 py-1 text-sm font-semibold">
        <span>{title}</span>
        <span className="text-xs text-faint">{count}</span>
        {onAdd && (
          <Button variant="ghost" className="ml-auto px-2 py-1 text-xs" onClick={() => onAdd()}>
            <Plus size={12} /> Add
          </Button>
        )}
      </div>
      <ul className="mt-1 space-y-1">
        {count === 0 && <p className="px-2 py-1 text-xs text-faint">None yet.</p>}
        {children}
      </ul>
    </section>
  );
}

function Row({
  label,
  hint,
  onShow,
  onEdit,
  onDelete,
}: {
  label: string;
  hint?: string;
  onShow?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <li className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm hover:bg-panel2">
      <button type="button" className="min-w-0 truncate text-left" onClick={onShow}>
        {label}
        {hint && <span className="ml-1.5 text-xs text-faint">{hint}</span>}
      </button>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {onShow && (
          <IconButton label={`Show on map: ${label}`} onClick={onShow}>
            <MapPin size={12} />
          </IconButton>
        )}
        {onEdit && (
          <IconButton label={`Edit ${label}`} onClick={onEdit}>
            <Pencil size={12} />
          </IconButton>
        )}
        {onDelete && (
          <IconButton label={`Delete ${label}`} onClick={onDelete}>
            <Trash2 size={12} />
          </IconButton>
        )}
      </span>
    </li>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-1 text-subtle hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

function EditRow({
  name,
  setName,
  extra,
  onSave,
  onCancel,
}: {
  name: string;
  setName: (v: string) => void;
  extra?: React.ReactNode;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <li className="space-y-1 rounded-lg border border-control p-2">
      <Input
        aria-label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="text-sm"
      />
      {extra}
      <div className="flex gap-2">
        <Button className="px-2 py-1 text-xs" onClick={onSave}>
          Save
        </Button>
        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </li>
  );
}

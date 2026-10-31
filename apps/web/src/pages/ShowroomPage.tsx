// Showroom: switch between vehicles with the 3D viewer updating camera,
// paint, and state without reloading the page.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Boxes, Car } from 'lucide-react';
import { api } from '../api/client';
import VehicleViewer from '../webgl/VehicleViewer';
import { Badge, Button, Card, EmptyState, Spinner } from '../components/ui';
import { STATUS_LABEL } from '../lib/format';
import type { VehicleWithState } from '@voltlink/shared';

const CLASS_LABELS: Record<string, string> = {
  compact_sedan: 'Compact sedan',
  sport_sedan: 'Sport sedan',
  compact_crossover: 'Compact crossover',
  suv: 'SUV',
  pickup: 'Pickup',
  fallback: 'Vehicle',
};

export default function ShowroomPage() {
  const { data: vehicles, isLoading } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => api<VehicleWithState[]>('/api/v1/vehicles'),
    refetchInterval: 15000,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = vehicles?.find((v) => v.id === selectedId) ?? vehicles?.[0];

  if (isLoading)
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner size={22} />
      </div>
    );
  if (!vehicles || vehicles.length === 0) {
    return (
      <EmptyState
        icon={<Boxes size={30} className="text-faint" />}
        title="Showroom is empty"
        body={
          <span>
            Enable{' '}
            <Link className="text-accent hover:underline" to="/providers">
              demo mode
            </Link>{' '}
            or connect a provider first.
          </span>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-extrabold">Showroom</h1>
        <span className="text-xs text-faint">
          State-aware 3D — rotate, zoom, and watch the vehicle react to its live state
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <div className="space-y-2 lg:col-span-1">
          {vehicles.map((v) => (
            <button
              key={v.id}
              onClick={() => setSelectedId(v.id)}
              className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                v.id === selected?.id
                  ? 'border-accent bg-accent/10'
                  : 'border-line bg-panel hover:border-faint'
              }`}
              aria-pressed={v.id === selected?.id}
            >
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ background: v.exteriorColor ?? '#8b9bb4' }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{v.displayName}</p>
                <p className="text-[11px] text-faint">
                  {CLASS_LABELS[v.vehicleClass] ?? v.vehicleClass}
                </p>
              </div>
              {v.state && (
                <Badge tone={(STATUS_LABEL[v.state.status] ?? STATUS_LABEL.unknown!).tone}>
                  {(STATUS_LABEL[v.state.status] ?? STATUS_LABEL.unknown!).label}
                </Badge>
              )}
            </button>
          ))}
        </div>

        <div className="lg:col-span-3">
          {selected && (
            <Card
              title={selected.displayName}
              subtitle={`${selected.make ?? ''} ${selected.model ?? ''} ${selected.year ?? ''} · ${CLASS_LABELS[selected.vehicleClass]}`}
              actions={
                <Link to={`/vehicles/${selected.id}`}>
                  <Button variant="outline">
                    <Car size={14} /> Live vehicle
                  </Button>
                </Link>
              }
            >
              <VehicleViewer vehicle={selected} state={selected.state} height={460} />
              <p className="mt-2 text-xs text-faint">
                The 3D model reflects real state: doors and trunk animate open, the charge port
                shows the connector while charging, and the lights follow climate and security
                state.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

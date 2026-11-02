// Presentation mode: polished, deterministic, fictional — automatic scene
// cycling with manual navigation. Never connects to a live provider.

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Gauge, MapPin, Pause, Play, Zap } from 'lucide-react';
import { api } from '../api/client';
import VehicleViewer from '../webgl/VehicleViewer';
import { Badge, Button, Card, Spinner } from '../components/ui';
import { fmtDist, STATUS_LABEL } from '../lib/format';
import type { VehicleWithState } from '@voltlink/shared';

type Scene = 'viewer' | 'stats';

const FALLBACK_DEMO: VehicleWithState = {
  id: 'demo-fallback',
  displayName: 'VoltLink One',
  provider: 'tesla',
  providerVehicleId: 'DEMO0000000000001',
  vehicleClass: 'fallback',
  make: 'VoltLink',
  model: 'Model One',
  year: 2025,
  capabilities: [],
  demo: true,
  ownerId: 'demo',
  providerAccountId: 'demo',
  groupIds: [],
  createdAt: new Date(0).toISOString(),
  state: {
    vehicleId: 'demo-fallback',
    provider: 'tesla',
    providerVehicleId: 'DEMO0000000000001',
    status: 'parked',
    fetchedAt: new Date(0).toISOString(),
    freshness: 'last_known',
    dataSource: 'estimated',
    batteryPercent: 78,
    batteryRangeKm: 392,
    odometerKm: 4210,
    lat: 47.6062,
    lon: -122.3321,
    speedKmh: 0,
    locked: true,
  },
};

export default function PresentationPage() {
  // NEW-14: real vehicles are never shown here. Only demo vehicles are used;
  // if the account has none, a built-in fictional vehicle keeps the slideshow
  // deterministic and safe to project publicly.
  const { data: demoVehicles, isLoading } = useQuery({
    queryKey: ['presentation-vehicles'],
    queryFn: () =>
      api<VehicleWithState[]>('/api/v1/vehicles').then((vs) => vs.filter((v) => v.demo)),
    refetchInterval: 20000,
  });
  const vehicles = useMemo(
    () => (demoVehicles && demoVehicles.length > 0 ? demoVehicles : [FALLBACK_DEMO]),
    [demoVehicles],
  );
  const [index, setIndex] = useState(0);
  const [scene, setScene] = useState<Scene>('viewer');
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => {
      setScene((s) => {
        if (s === 'viewer') return 'stats';
        setIndex((i) => (i + 1) % Math.max(1, vehicles?.length ?? 1));
        return 'viewer';
      });
    }, 12000);
    return () => clearInterval(t);
  }, [paused, vehicles?.length]);

  const vehicle = useMemo(
    () => (vehicles && vehicles.length > 0 ? vehicles[index % vehicles.length]! : null),
    [vehicles, index],
  );

  if (isLoading)
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner size={24} />
      </div>
    );

  return (
    <div className="min-h-screen bg-canvas p-4 sm:p-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="" className="h-9 w-9 rounded-lg" />
            <div>
              <h1 className="text-xl font-extrabold tracking-tight">VoltLink</h1>
              <p className="text-[10px] uppercase tracking-widest text-faint">
                Connected Vehicle Platform
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() =>
                setIndex((i) => (i - 1 + (vehicles?.length ?? 1)) % (vehicles?.length ?? 1))
              }
              aria-label="Previous vehicle"
            >
              <ChevronLeft size={16} />
            </Button>
            <span className="text-sm text-subtle">
              {index + 1} / {vehicles?.length ?? 0}
            </span>
            <Button
              variant="ghost"
              onClick={() => setIndex((i) => (i + 1) % (vehicles?.length ?? 1))}
              aria-label="Next vehicle"
            >
              <ChevronRight size={16} />
            </Button>
            <Button
              variant="secondary"
              onClick={() => setPaused((p) => !p)}
              aria-label={paused ? 'Resume cycling' : 'Pause cycling'}
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
            </Button>
          </div>
        </header>

        {vehicle ? (
          <div className="space-y-4">
            <Card
              title={vehicle.displayName}
              subtitle={`${vehicle.make} ${vehicle.model} · ${vehicle.year}`}
              actions={
                vehicle.state && (
                  <Badge tone={(STATUS_LABEL[vehicle.state.status] ?? STATUS_LABEL.unknown!).tone}>
                    {(STATUS_LABEL[vehicle.state.status] ?? STATUS_LABEL.unknown!).label}
                  </Badge>
                )
              }
            >
              {scene === 'viewer' ? (
                <VehicleViewer hideDebugLabel vehicle={vehicle} state={vehicle.state} height={480} />
              ) : (
                <PresentationStats vehicle={vehicle} />
              )}
            </Card>
            <p className="text-center text-xs text-faint">
              Presentation mode · deterministic fictional data (demo vehicles only) · automatic
              scene cycling {paused ? '(paused)' : ''}
            </p>
          </div>
        ) : (
          <Card>
            <p className="py-8 text-center text-sm text-subtle">
              Enable demo mode from the app to populate presentation scenes.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}

function PresentationStats({ vehicle }: { vehicle: VehicleWithState }) {
  const s = vehicle.state;
  return (
    <div className="grid gap-4 py-6 sm:grid-cols-3">
      <BigStat
        icon={<Zap className="text-accent" />}
        label="Battery"
        value={`${Math.round(s?.batteryPercent ?? 0)}%`}
        sub={fmtDist(s?.batteryRangeKm ?? 0, 'metric', 0)}
      />
      <BigStat
        icon={<Gauge className="text-accent" />}
        label="Efficiency"
        value={s ? `${Math.round(s.odometerKm ?? 0).toLocaleString()} km` : '—'}
        sub="odometer"
      />
      <BigStat
        icon={<MapPin className="text-accent" />}
        label="Location"
        value={s?.address?.split(',')[0] ?? '—'}
        sub={s?.speedKmh ? `${Math.round(s.speedKmh)} km/h` : 'parked'}
      />
    </div>
  );
}

function BigStat({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-line bg-panel2 p-6 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10">
        {icon}
      </div>
      <p className="text-[11px] font-bold uppercase tracking-widest text-faint">{label}</p>
      <p className="mt-1 truncate text-3xl font-extrabold">{value}</p>
      {sub && <p className="mt-1 text-sm text-subtle">{sub}</p>}
    </div>
  );
}

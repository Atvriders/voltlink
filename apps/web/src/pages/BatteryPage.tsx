// Battery & efficiency analytics with clearly-labeled degradation estimates.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Battery, Gauge } from 'lucide-react';
import { api } from '../api/client';
import { Badge, Card, EmptyState, Select, Spinner, Stat } from '../components/ui';
import type { BatteryHealth, BatteryPoint, DailyAggregate, EfficiencyPoint, VehicleWithState } from '@voltlink/shared';

const CHART_COLORS: Record<string, string> = {
  'voltlink-dark': '#0ea5e9',
  'voltlink-light': '#0284c7',
  'fleet-ops': '#a3e635',
  'high-contrast': '#00e5ff',
  'colorblind-safe': '#0072b2',
};

export default function BatteryPage() {
  const [vehicleId, setVehicleId] = useState('');
  const [days, setDays] = useState(14);
  const [batteryDays, setBatteryDays] = useState(14);
  const { data: vehicles } = useQuery({ queryKey: ['vehicles'], queryFn: () => api<VehicleWithState[]>('/api/v1/vehicles') });
  const active = vehicleId || vehicles?.[0]?.id;

  const { data: battery, isLoading: batteryLoading } = useQuery({
    queryKey: ['analytics', 'battery', active, batteryDays],
    queryFn: () => api<BatteryPoint[]>(`/api/v1/analytics/${active}/battery?days=${batteryDays}`),
    enabled: !!active,
  });
  const { data: efficiency, isLoading: effLoading } = useQuery({
    queryKey: ['analytics', 'efficiency', active, days],
    queryFn: () => api<EfficiencyPoint[]>(`/api/v1/analytics/${active}/efficiency?days=${days}`),
    enabled: !!active,
  });
  const { data: aggregates } = useQuery({
    queryKey: ['analytics', 'aggregates', active, days],
    queryFn: () => api<DailyAggregate[]>(`/api/v1/analytics/${active}/aggregates?days=${days}`),
    enabled: !!active,
  });
  const { data: health } = useQuery({
    queryKey: ['analytics', 'health', active],
    queryFn: () => api<BatteryHealth>(`/api/v1/analytics/${active}/battery-health`),
    enabled: !!active,
  });

  const color = CHART_COLORS[document.documentElement.getAttribute('data-theme') ?? 'voltlink-dark'] ?? '#0ea5e9';

  if (!active) return <EmptyState icon={<Battery size={28} className="text-faint" />} title="No vehicles" body="Connect a vehicle or demo mode to see battery analytics." />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-extrabold">Battery & efficiency</h1>
        <div className="ml-auto flex gap-2">
          <Select aria-label="Vehicle" value={active} onChange={(e) => setVehicleId(e.target.value)} className="text-xs">
            {(vehicles ?? []).map((v) => <option key={v.id} value={v.id}>{v.displayName}</option>)}
          </Select>
          <Select aria-label="Efficiency window" value={days} onChange={(e) => setDays(Number(e.target.value))} className="text-xs">
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={365}>12 months</option>
          </Select>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title="State of charge history" actions={
            <Select aria-label="Battery window" value={batteryDays} onChange={(e) => setBatteryDays(Number(e.target.value))} className="text-xs">
              <option value={3}>3 days</option>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
            </Select>
          }>
            {batteryLoading ? (
              <div className="flex h-64 items-center justify-center"><Spinner size={22} /></div>
            ) : (battery ?? []).length === 0 ? (
              <EmptyState title="No battery samples" body="Telemetry will build this chart over time." />
            ) : (
              <div className="h-64" role="img" aria-label="State of charge chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={battery} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--vl-line)" />
                    <XAxis dataKey="ts" tickFormatter={(t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} stroke="var(--vl-faint)" fontSize={11} minTickGap={40} />
                    <YAxis domain={[0, 100]} stroke="var(--vl-faint)" fontSize={11} />
                    <Tooltip contentStyle={{ background: 'var(--vl-panel)', border: '1px solid var(--vl-line)', borderRadius: 8 }} labelFormatter={(t) => new Date(t).toLocaleString()} />
                    <Line type="monotone" dataKey="batteryPct" name="SoC %" stroke={color} dot={false} strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <div className="mt-4">
            <Card title="Efficiency trend" subtitle="Wh per km, daily">
              {effLoading ? (
                <div className="flex h-56 items-center justify-center"><Spinner size={22} /></div>
              ) : (efficiency ?? []).length === 0 ? (
                <EmptyState icon={<Gauge size={26} className="text-faint" />} title="No drive data yet" />
              ) : (
                <div className="h-56" role="img" aria-label="Efficiency chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={efficiency} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--vl-line)" />
                      <XAxis dataKey="date" stroke="var(--vl-faint)" fontSize={11} minTickGap={40} />
                      <YAxis stroke="var(--vl-faint)" fontSize={11} />
                      <Tooltip contentStyle={{ background: 'var(--vl-panel)', border: '1px solid var(--vl-line)', borderRadius: 8 }} />
                      <Legend />
                      <Line type="monotone" dataKey="whPerKm" name="Wh/km" stroke={color} dot={false} strokeWidth={2} />
                      <Line type="monotone" dataKey="tempC" name="Avg temp °C" stroke="#fbbf24" dot={false} strokeDasharray="4 2" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>
          </div>
        </div>

        <div className="space-y-4">
          <Card title="Battery health estimate">
            {health ? (
              <div className="space-y-3">
                <div className="flex items-end gap-2">
                  <span className="text-3xl font-extrabold text-accent">{health.estimatedUsableKwh.toFixed(1)} kWh</span>
                  <span className="text-sm text-subtle">usable (est.)</span>
                </div>
                <div>
                  <p className="text-xs text-subtle">Estimated degradation</p>
                  <p className="text-lg font-bold">{health.estimatedDegradationPct.toFixed(1)}%</p>
                </div>
                <p className="text-xs text-faint">Based on {health.sampleCount} charging session(s).</p>
                <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                  {health.disclaimer}
                </p>
              </div>
            ) : (
              <p className="py-2 text-sm text-faint">Not enough charging data to estimate.</p>
            )}
          </Card>

          <Card title="Daily aggregates" subtitle={`Last ${days} days`}>
            {aggregates && aggregates.length > 0 ? (
              <ul className="space-y-1.5 text-sm">
                {[...aggregates].reverse().slice(0, 7).map((a) => (
                  <li key={a.date} className="flex items-center justify-between">
                    <span className="text-subtle">{a.date.slice(5)}</span>
                    <span>{a.distanceKm.toFixed(1)} km</span>
                    <span className="text-subtle">{a.chargeEnergyKwh.toFixed(1)} kWh in</span>
                    <Badge tone="accent">{a.driveCount} drives</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-2 text-sm text-faint">No aggregate data.</p>
            )}
          </Card>

          <Card title="Usage summary">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Energy (drives)" value={(aggregates?.reduce((s, a) => s + a.energyKwh, 0) ?? 0).toFixed(1) + ' kWh'} />
              <Stat label="Charged" value={(aggregates?.reduce((s, a) => s + a.chargeEnergyKwh, 0) ?? 0).toFixed(1) + ' kWh'} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

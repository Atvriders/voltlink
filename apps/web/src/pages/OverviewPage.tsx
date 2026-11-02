// Fleet/vehicle overview: selected vehicle card, live state, quick actions,
// recent drives/charging, active automations, provider health.

import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  BatteryCharging,
  Bell,
  Car,
  Lock,
  LockOpen,
  RadioTower,
  ShieldAlert,
  Snowflake,
  Zap,
} from 'lucide-react';
import { api } from '../api/client';
import { Badge, Button, Card, EmptyState, ProgressBar, Spinner, Stat } from '../components/ui';
import {
  fmtClock,
  fmtDist,
  fmtEnergy,
  fmtPower,
  fmtSpeed,
  fmtTemp,
  FRESHNESS_LABEL,
  STATUS_LABEL,
  timeAgo,
} from '../lib/format';
import type {
  Automation,
  ChargeSession,
  Drive,
  ProviderInfo,
  VehicleState,
  VehicleWithState,
} from '@voltlink/shared';
import { useAuth } from '../auth/AuthContext';
import { ChargingBadge } from '../components/Shell';

export default function OverviewPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: vehicles, isLoading } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => api<VehicleWithState[]>('/api/v1/vehicles'),
    refetchInterval: 15000,
  });
  const { data: providers } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api<ProviderInfo[]>('/api/v1/providers'),
  });
  const { data: drives } = useQuery({
    queryKey: ['drives', 'recent'],
    queryFn: () => api<{ items: Drive[] }>('/api/v1/drives?pageSize=4').then((d) => d.items),
  });
  const { data: charges } = useQuery({
    queryKey: ['charging', 'recent'],
    queryFn: () =>
      api<{ items: ChargeSession[] }>('/api/v1/charging?pageSize=4').then((d) => d.items),
  });
  const { data: automations } = useQuery({
    queryKey: ['automations'],
    queryFn: () => api<Automation[]>('/api/v1/automations'),
  });

  const units = user?.units ?? 'metric';
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
        icon={<Car size={30} className="text-faint" />}
        title="No vehicles yet"
        body={
          <span>
            Connect a provider or start{' '}
            <Link className="text-accent hover:underline" to="/providers">
              demo mode
            </Link>{' '}
            to explore VoltLink with a fictional fleet.
          </span>
        }
      />
    );
  }

  const state = selected?.state;
  const activeAutomations = automations?.filter((a) => a.enabled) ?? [];
  const alertCount =
    automations?.filter((a) => a.enabled && a.lastResult === 'failed')?.length ?? 0;

  return (
    <div className="space-y-4">
      {/* Vehicle selector strip */}
      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Vehicles">
        {vehicles.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={v.id === selected?.id}
            onClick={() => setSelectedId(v.id)}
            className={`flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
              v.id === selected?.id
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-line bg-panel text-subtle hover:text-ink'
            }`}
          >
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ background: v.exteriorColor ?? '#8b9bb4' }}
              aria-hidden
            />
            {v.displayName}
            {v.state?.chargingState === 'charging' && <Zap size={13} className="text-charging" />}
          </button>
        ))}
        <Link
          to="/showroom"
          className="flex shrink-0 items-center gap-1 rounded-xl border border-dashed border-line px-3 py-2 text-sm text-faint hover:text-accent"
        >
          Showroom <ArrowRight size={13} />
        </Link>
      </div>

      {/* Main grid */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Left: selected vehicle */}
        <div className="lg:col-span-2">
          <Card
            title={
              <span className="flex items-center gap-2">
                {selected?.displayName} <ChargingBadgeX state={state} />
                {selected?.demo && <Badge tone="info">demo</Badge>}
              </span>
            }
            subtitle={
              selected
                ? `${selected.make ?? ''} ${selected.model ?? ''} ${selected.year ?? ''}`
                : undefined
            }
            actions={
              <Button variant="outline" onClick={() => navigate(`/vehicles/${selected?.id}`)}>
                Live vehicle <ArrowRight size={14} />
              </Button>
            }
          >
            {state ? (
              <OverviewState state={state} units={units} />
            ) : (
              <EmptyState
                title="No telemetry yet"
                body="State appears after the first provider sync."
              />
            )}
          </Card>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Card
              title="Recent drives"
              actions={
                <Link className="text-xs text-accent hover:underline" to="/drives">
                  View all
                </Link>
              }
            >
              {drives && drives.length > 0 ? (
                <ul className="divide-y divide-line">
                  {drives.slice(0, 4).map((d) => (
                    <li key={d.id}>
                      <Link
                        to={`/drives/${d.id}`}
                        className="flex items-center justify-between gap-2 py-2 text-sm hover:text-accent"
                      >
                        <span className="truncate">{d.vehicleName}</span>
                        <span className="text-subtle">
                          {fmtDist(d.distanceKm, units)} · {fmtClock(d.startAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-sm text-faint">No drives recorded yet.</p>
              )}
            </Card>

            <Card title="Recent charging">
              {charges && charges.length > 0 ? (
                <ul className="divide-y divide-line">
                  {charges.slice(0, 4).map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span className="truncate">{c.vehicleName}</span>
                      <span className="text-subtle">
                        {fmtEnergy(c.energyAddedKwh)} · {fmtClock(c.startAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-sm text-faint">No charging recorded yet.</p>
              )}
            </Card>

            <Card
              title="Automations"
              actions={
                <Link className="text-xs text-accent hover:underline" to="/automations">
                  Manage
                </Link>
              }
            >
              {activeAutomations.length > 0 ? (
                <ul className="divide-y divide-line">
                  {activeAutomations.slice(0, 4).map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span className="flex items-center gap-2 truncate">
                        <Zap size={13} className="text-accent" /> {a.name}
                      </span>
                      {a.lastResult === 'failed' ? (
                        <Badge tone="danger">failed</Badge>
                      ) : (
                        <span className="text-xs text-faint">runs: {a.runCount}</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-sm text-faint">No automations configured.</p>
              )}
              {alertCount > 0 && (
                <div className="mt-2 flex items-center gap-2 text-xs text-warn">
                  <ShieldAlert size={13} /> {alertCount} automation(s) with failures
                </div>
              )}
            </Card>
          </div>
        </div>

        {/* Right: fleet + provider health */}
        <div className="space-y-4">
          <Card title="Fleet">
            <ul className="space-y-2">
              {vehicles.map((v) => (
                <li key={v.id}>
                  <button
                    onClick={() => setSelectedId(v.id)}
                    className="flex w-full items-center gap-3 rounded-lg border border-line bg-panel2 px-3 py-2 text-left hover:border-accent/50"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ background: v.exteriorColor ?? '#8b9bb4' }}
                      aria-hidden
                    />
                    <span className="flex-1 truncate text-sm font-medium">
                      {v.displayName}
                      {v.demo && <Badge tone="info">demo</Badge>}
                    </span>
                    {v.state && <VehicleMini state={v.state} />}
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Provider health">
            <ul className="space-y-2">
              {(providers ?? []).map((p) => (
                <li key={p.id} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 capitalize">
                    <RadioTower size={13} className="text-subtle" /> {p.provider}
                  </span>
                  {p.status === 'connected' ? (
                    <Badge tone="ok">Connected</Badge>
                  ) : p.status === 'error' ? (
                    <Badge tone="danger">Error</Badge>
                  ) : (
                    <Badge tone="neutral">{p.status}</Badge>
                  )}
                </li>
              ))}
              {(providers ?? []).length === 0 && (
                <p className="py-2 text-sm text-faint">No provider accounts.</p>
              )}
            </ul>
            <Link className="mt-3 block text-xs text-accent hover:underline" to="/providers">
              Provider settings & readiness
            </Link>
          </Card>

          <Card title="Notifications">
            <Link
              to="/notifications"
              className="flex items-center gap-2 text-sm text-subtle hover:text-accent"
            >
              <Bell size={14} /> Open notification center
            </Link>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ChargingBadgeX({ state }: { state?: VehicleState | null }) {
  if (!state) return null;
  if (state.chargingState === 'charging') return <ChargingBadge />;
  if (state.plugConnected) return <Badge tone="info">Plugged in</Badge>;
  return null;
}

function OverviewState({ state, units }: { state: VehicleState; units: 'metric' | 'imperial' }) {
  const fresh = (FRESHNESS_LABEL[state.freshness] ?? FRESHNESS_LABEL.last_known)!;
  const status = (STATUS_LABEL[state.status] ?? STATUS_LABEL.unknown)!;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={fresh.tone}>{fresh.label}</Badge>
        <Badge tone={status.tone}>{status.label}</Badge>
        {state.locked ? (
          <span className="flex items-center gap-1 text-xs text-ok">
            <Lock size={12} /> Locked
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-danger">
            <LockOpen size={12} /> Unlocked
          </span>
        )}
        {state.climateOn && (
          <span className="flex items-center gap-1 text-xs text-info">
            <Snowflake size={12} /> Climate on
          </span>
        )}
        {state.sentryMode && (
          <span className="flex items-center gap-1 text-xs text-info">
            <ShieldAlert size={12} /> Security mode
          </span>
        )}
        <span className="ml-auto text-xs text-faint">updated {timeAgo(state.fetchedAt)}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Battery"
          value={<span className="text-accent">{Math.round(state.batteryPercent ?? 0)}%</span>}
          sub={fmtDist(state.batteryRangeKm ?? 0, units, 0)}
        />
        <Stat
          label="Charging"
          value={
            state.chargingState === 'charging'
              ? fmtPower(state.chargePowerKw)
              : (state.chargingState ?? '—')
          }
          sub={
            state.timeToFullChargeMin
              ? `~${Math.round(state.timeToFullChargeMin)} min to full`
              : `limit ${state.chargeLimitPct ?? '—'}%`
          }
        />
        <Stat
          label="Interior"
          value={fmtTemp(state.insideTempC, units)}
          sub={`outside ${fmtTemp(state.outsideTempC, units)}`}
        />
        <Stat
          label="Location"
          value={state.address ? <span className="text-sm">{state.address}</span> : '—'}
          sub={state.speedKmh ? fmtSpeed(state.speedKmh, units) : undefined}
        />
        <Stat
          label="Odometer"
          value={state.odometerKm != null ? fmtDist(state.odometerKm, units, 0) : '—'}
          sub={state.softwareVersion ? `SW ${state.softwareVersion}` : undefined}
        />
        <Stat
          label="Tire pressure"
          value={
            state.tirePressureKpa ? (
              <span className="text-sm">{Math.round(state.tirePressureKpa.frontLeft)} kPa</span>
            ) : (
              '—'
            )
          }
          sub={
            state.tirePressureKpa
              ? `${Math.round(state.tirePressureKpa.frontLeft / 6.895)} psi front`
              : undefined
          }
        />
      </div>

      <ProgressBar
        value={state.batteryPercent ?? 0}
        tone={state.chargingState === 'charging' ? 'bg-charging' : 'bg-accent'}
      />
    </div>
  );
}

function VehicleMini({ state }: { state: VehicleState }) {
  const s = (STATUS_LABEL[state.status] ?? STATUS_LABEL.unknown)!;
  return (
    <span className="flex items-center gap-1.5 text-xs">
      {state.chargingState === 'charging' && (
        <BatteryCharging size={12} className="text-charging" />
      )}
      <span className="text-subtle">{state.batteryPercent ?? '—'}%</span>
      <Badge tone={s.tone}>{s.label}</Badge>
    </span>
  );
}

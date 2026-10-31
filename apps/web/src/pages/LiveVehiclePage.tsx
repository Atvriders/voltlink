// Live vehicle page: state-aware 3D view, detailed telemetry, and secure
// remote controls with the full command lifecycle.

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BatteryCharging,
  Bell,
  Car,
  CircleDot,
  Clock,
  Fan,
  Gauge,
  KeyRound,
  Lightbulb,
  Lock,
  MapPin,
  Navigation,
  Pause,
  Play,
  Power,
  RotateCw,
  ShieldCheck,
  Snowflake,
  Thermometer,
  Unlock,
  Wind,
  Zap,
} from 'lucide-react';
import { api, ApiError } from '../api/client';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Modal,
  ProgressBar,
  Select,
  Spinner,
} from '../components/ui';
import { useAuth } from '../auth/AuthContext';
import VehicleViewer, { autoPreset, type GraphicsPreset } from '../webgl/VehicleViewer';
import {
  batteryTone,
  COMMAND_STATUS_LABEL,
  fmtClock,
  fmtDist,
  fmtPower,
  fmtSpeed,
  fmtTemp,
  FRESHNESS_LABEL,
  STATUS_LABEL,
  timeAgo,
} from '../lib/format';
import {
  COMMAND_DEFINITIONS,
  HIGH_RISK_COMMANDS,
  type CommandType,
  type CommandParams,
  type VehicleCommand,
  type VehicleWithState,
  type VehicleState,
} from '@voltlink/shared';
import { computeFreshness, controlsFor, type ParamControl } from '@voltlink/shared';
import { outcomeFor } from '../lib/commandLifecycle';
import { useNow } from '../lib/useNow';
import { useAnnounce } from '../lib/announcer';

interface CommandWithEvents extends VehicleCommand {
  events?: { id: string; event: string; actor: string; detail: string; createdAt: string }[];
}

export default function LiveVehiclePage() {
  const { id } = useParams();
  const { user } = useAuth();
  useNow(15_000); // F-FRESH: recompute the freshness label between refetches
  const qc = useQueryClient();
  const units = user?.units ?? 'metric';

  const { data: vehicles } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => api<VehicleWithState[]>('/api/v1/vehicles'),
    refetchInterval: 10000,
  });
  const vehicle = vehicles?.find((v) => v.id === id);
  const state = vehicle?.state;

  const { data: commands } = useQuery({
    queryKey: ['commands', id],
    queryFn: () =>
      api<{ items: VehicleCommand[] }>(`/api/v1/commands?vehicleId=${id}&pageSize=8`).then(
        (d) => d.items,
      ),
    refetchInterval: 5000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => api(`/api/v1/vehicles/${id}/refresh`, { method: 'POST' }),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ['vehicles'] }), 1200),
  });

  const [activeCommandId, setActiveCommandId] = useState<string | null>(null);
  const { data: activeCommand } = useQuery({
    queryKey: ['command', activeCommandId],
    queryFn: () => api<CommandWithEvents>(`/api/v1/commands/${activeCommandId}`),
    enabled: !!activeCommandId,
    refetchInterval: 1500,
  });

  const [preset, setPreset] = useState<GraphicsPreset>(autoPreset());

  if (!vehicles || !vehicle) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-subtle">Vehicle not found.</p>
        <Link className="text-sm text-accent hover:underline" to="/">
          Back to overview
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/" className="text-sm text-subtle hover:text-accent">
          Overview
        </Link>
        <span className="text-faint">/</span>
        <h1 className="text-lg font-extrabold">{vehicle.displayName}</h1>
        {state && (
          <Badge tone={(STATUS_LABEL[state.status] ?? STATUS_LABEL.unknown!).tone}>
            {(STATUS_LABEL[state.status] ?? STATUS_LABEL.unknown!).label}
          </Badge>
        )}
        {state && (
          <Badge
            tone={
              (FRESHNESS_LABEL[computeFreshness(state, Date.now())] ?? FRESHNESS_LABEL.last_known!)
                .tone
            }
          >
            {
              (FRESHNESS_LABEL[computeFreshness(state, Date.now())] ?? FRESHNESS_LABEL.last_known!)
                .label
            }
          </Badge>
        )}{' '}
        {state?.chargingState === 'charging' && (
          <Badge tone="charging" pulse>
            Charging {fmtPower(state.chargePowerKw)}
          </Badge>
        )}
        {state && <span className="text-xs text-faint">updated {timeAgo(state.fetchedAt)}</span>}
        <div className="ml-auto flex items-center gap-2">
          <Select
            aria-label="Graphics preset"
            value={preset}
            onChange={(e) => setPreset(e.target.value as GraphicsPreset)}
            className="py-1.5 text-xs"
          >
            <option value="low">Low graphics</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="ultra">Ultra</option>
          </Select>
          <Button
            variant="secondary"
            loading={refreshMutation.isPending}
            onClick={() => refreshMutation.mutate()}
          >
            <RotateCw size={14} /> Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <VehicleViewer vehicle={vehicle} state={state ?? null} preset={preset} height={420} />

          {/* Controls */}
          <Card
            title="Remote controls"
            subtitle={
              state
                ? `Capabilities: ${vehicle.capabilities.length} discovered for this vehicle`
                : 'State not loaded yet'
            }
          >
            {state ? (
              <ControlsPanel
                vehicle={vehicle}
                onCommandIssued={(cmd) => setActiveCommandId(cmd.id)}
              />
            ) : (
              <p className="py-2 text-sm text-faint">Waiting for first telemetry sync…</p>
            )}
          </Card>

          {/* Command activity */}
          <Card
            title="Command activity"
            actions={
              <Link className="text-xs text-accent hover:underline" to={`/vehicles/${id}/history`}>
                Full history
              </Link>
            }
          >
            {commands && commands.length > 0 ? (
              <ul className="divide-y divide-line">
                {commands.slice(0, 6).map((c) => (
                  <li key={c.id}>
                    <button
                      className="flex w-full items-center gap-3 py-2 text-left text-sm hover:text-accent"
                      onClick={() => setActiveCommandId(c.id)}
                    >
                      <CommandIcon type={c.type} />
                      <span className="font-medium">
                        {COMMAND_DEFINITIONS[c.type]?.label ?? c.type}
                      </span>
                      <span className="text-xs text-faint">
                        {fmtClock(c.createdAt, user?.timezone)}
                      </span>
                      <span className="ml-auto">
                        <Badge tone={COMMAND_STATUS_LABEL[c.status]?.tone ?? 'neutral'}>
                          {(COMMAND_STATUS_LABEL[c.status] ?? { label: c.status }).label}
                        </Badge>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-2 text-sm text-faint">No commands issued for this vehicle yet.</p>
            )}
          </Card>
        </div>

        {/* Right rail: state detail */}
        <div className="space-y-4">
          <StateDetails vehicle={vehicle} state={state ?? null} units={units} />
        </div>
      </div>

      {/* Command lifecycle modal */}
      <CommandModal
        command={activeCommand}
        onClose={() => setActiveCommandId(null)}
        units={units}
      />
    </div>
  );
}

function CommandIcon({ type }: { type: CommandType }) {
  const map: Record<string, React.ReactNode> = {
    lock: <Lock size={14} />,
    unlock: <Unlock size={14} />,
    wake: <Power size={14} />,
    climate_start: <Snowflake size={14} />,
    climate_stop: <Pause size={14} />,
    set_temperature: <Thermometer size={14} />,
    defrost: <Wind size={14} />,
    seat_heater: <Fan size={14} />,
    steering_heater: <CircleDot size={14} />,
    charge_start: <Zap size={14} />,
    charge_stop: <Pause size={14} />,
    set_charge_limit: <BatteryCharging size={14} />,
    set_charging_amps: <Gauge size={14} />,
    charge_port_open: <BatteryCharging size={14} />,
    charge_port_close: <BatteryCharging size={14} />,
    open_trunk: <Car size={14} />,
    open_frunk: <Car size={14} />,
    window_vent: <Wind size={14} />,
    window_close: <Wind size={14} />,
    sentry_mode: <ShieldCheck size={14} />,
    flash_lights: <Lightbulb size={14} />,
    honk_horn: <Bell size={14} />,
    homelink: <Navigation size={14} />,
    remote_start: <Play size={14} />,
    valet_mode: <KeyRound size={14} />,
    speed_limit: <Gauge size={14} />,
    send_navigation: <MapPin size={14} />,
    schedule_update: <RotateCw size={14} />,
  };
  return <span className="text-subtle">{map[type] ?? <Activity size={14} />}</span>;
}

const CONTROL_GROUPS: { title: string; commands: CommandType[] }[] = [
  { title: 'Access', commands: ['wake', 'lock', 'unlock'] },
  {
    title: 'Climate',
    commands: [
      'climate_start',
      'climate_stop',
      'set_temperature',
      'defrost',
      'seat_heater',
      'steering_heater',
    ],
  },
  {
    title: 'Charging',
    commands: [
      'charge_start',
      'charge_stop',
      'set_charge_limit',
      'set_charging_amps',
      'charge_port_open',
      'charge_port_close',
    ],
  },
  {
    title: 'Doors & windows',
    commands: ['open_trunk', 'open_frunk', 'window_vent', 'window_close'],
  },
  {
    title: 'Security',
    commands: ['sentry_mode', 'flash_lights', 'honk_horn', 'valet_mode', 'speed_limit'],
  },
  { title: 'Navigation & updates', commands: ['send_navigation', 'schedule_update'] },
];

function ControlsPanel({
  vehicle,
  onCommandIssued,
}: {
  vehicle: VehicleWithState;
  onCommandIssued: (cmd: VehicleCommand) => void;
}) {
  const [paramFor, setParamFor] = useState<CommandType | null>(null);
  const [error, setError] = useState('');
  const [issueType, setIssueType] = useState<CommandType | null>(null);
  const announce = useAnnounce();
  const issue = useMutation({
    // F-PARAMS + A-STEPUP: parameters and a fresh idempotency key travel with
    // the command; credentials never do. 403 STEP_UP_REQUIRED is handled by the
    // global StepUpDialog inside api() and the same request is resent.
    mutationFn: (input: { type: CommandType; params: CommandParams; idempotencyKey: string }) =>
      api<VehicleCommand>('/api/v1/commands', {
        method: 'POST',
        body: {
          vehicleId: vehicle.id,
          type: input.type,
          params: input.params,
          idempotencyKey: input.idempotencyKey,
        },
      }),
    onSuccess: (cmd) => {
      onCommandIssued(cmd);
      announce(`Command ${COMMAND_DEFINITIONS[cmd.type]?.label ?? cmd.type}: ${cmd.status}`);
      setIssueType(null);
      setError('');
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : 'Command failed.';
      setError(msg);
      announce(msg, 'assertive');
      setIssueType(null);
    },
  });

  const click = (type: CommandType) => {
    if (controlsFor(type).length > 0) {
      setParamFor(type);
      return;
    }
    setIssueType(type);
    issue.mutate({ type, params: {}, idempotencyKey: crypto.randomUUID() });
  };

  const caps = new Set(vehicle.capabilities);

  return (
    <div className="space-y-4">
      {error && (
        <div
          className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
          role="alert"
        >
          {error}
        </div>
      )}
      {CONTROL_GROUPS.map((group) => {
        const available = group.commands.filter((c) =>
          caps.has(COMMAND_DEFINITIONS[c].requiresCapability as never),
        );
        if (available.length === 0) return null;
        return (
          <div key={group.title}>
            <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-faint">
              {group.title}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {available.map((c) => {
                const def = COMMAND_DEFINITIONS[c];
                const isHigh = HIGH_RISK_COMMANDS.includes(c);
                return (
                  <button
                    key={c}
                    onClick={() => click(c)}
                    disabled={issue.isPending}
                    title={def.description}
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                      isHigh
                        ? 'border-warn/50 bg-warn/10 text-warn hover:bg-warn/20'
                        : 'border-line bg-panel2 text-ink hover:border-accent/60 hover:text-accent'
                    }`}
                  >
                    <CommandIcon type={c} />
                    {def.label}
                    {issueType === c && <Spinner size={11} />}
                    {isHigh && <ShieldCheck size={11} />}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      <ParamModal
        type={paramFor}
        vehicle={vehicle}
        onClose={() => setParamFor(null)}
        onSubmit={(type, params) => {
          setParamFor(null);
          setIssueType(type);
          issue.mutate({ type, params, idempotencyKey: crypto.randomUUID() });
        }}
      />
    </div>
  );
}

function ParamModal({
  type,
  vehicle,
  onClose,
  onSubmit,
}: {
  type: CommandType | null;
  vehicle: VehicleWithState;
  onClose: () => void;
  onSubmit: (type: CommandType, params: CommandParams) => void;
}) {
  const controls = type ? controlsFor(type) : [];
  const [values, setValues] = useState<Record<string, string>>({});
  if (!type || controls.length === 0) return null;
  const state = (vehicle.state ?? {}) as Record<string, unknown>;
  const defaults: Record<string, string> = {};
  for (const c of controls) {
    if (c.kind === 'range') {
      const current = (state as Record<string, unknown>)[c.param];
      defaults[c.param] =
        typeof current === 'number' ? String(current) : String((c.min + c.max) / 2);
    } else if (c.kind === 'toggle') {
      const current = (state as Record<string, unknown>)[c.param];
      defaults[c.param] = current === true ? 'on' : 'off';
    }
  }
  const params: CommandParams = {};
  for (const c of controls) {
    const v = values[c.param] ?? defaults[c.param] ?? '';
    if (c.kind === 'range') {
      const n = Number(v);
      if (Number.isFinite(n)) (params as Record<string, unknown>)[c.param] = n;
    } else if (c.kind === 'toggle') {
      (params as Record<string, unknown>)[c.param] = v === 'on';
    } else if (c.kind === 'pin') {
      if (/^\d{4}$/.test(v)) (params as Record<string, unknown>)[c.param] = v;
    } else if (c.kind === 'destination') {
      if (v.trim())
        (params as Record<string, unknown>)[c.param] = { name: v.trim(), lat: 0, lon: 0 };
    }
  }
  const setValue = (param: string, v: string) => setValues((prev) => ({ ...prev, [param]: v }));
  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <CommandIcon type={type} /> {COMMAND_DEFINITIONS[type]?.label ?? type}
        </span>
      }
    >
      <div className="mt-2 space-y-3">
        {controls.map((c: ParamControl) => {
          const v = values[c.param] ?? defaults[c.param] ?? '';
          if (c.kind === 'range') {
            return (
              <Field key={c.param} label={`${c.param}${c.unit ? ` (${c.unit})` : ''}`}>
                <Input
                  type="number"
                  min={c.min}
                  max={c.max}
                  step={c.step}
                  value={v}
                  onChange={(e) => setValue(c.param, e.target.value)}
                />
              </Field>
            );
          }
          if (c.kind === 'toggle') {
            return (
              <Field key={c.param} label={c.param}>
                <Select value={v} onChange={(e) => setValue(c.param, e.target.value)}>
                  <option value="off">Off</option>
                  <option value="on">On</option>
                </Select>
              </Field>
            );
          }
          if (c.kind === 'pin') {
            return (
              <Field key={c.param} label="4-digit PIN">
                <Input
                  inputMode="numeric"
                  maxLength={4}
                  value={v}
                  onChange={(e) => setValue(c.param, e.target.value)}
                />
              </Field>
            );
          }
          return (
            <Field key={c.param} label="Destination (address or place name)">
              <Input
                value={v}
                placeholder="e.g. 3500 Deer Creek Rd, Palo Alto"
                onChange={(e) => setValue(c.param, e.target.value)}
              />
            </Field>
          );
        })}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => onSubmit(type, params)}>Set & send</Button>
      </div>
    </Modal>
  );
}

function CommandModal({
  command,
  onClose,
  units: _units,
}: {
  command?: CommandWithEvents;
  onClose: () => void;
  units: 'metric' | 'imperial';
}) {
  if (!command) return null;
  const statuses = ['queued', 'submitted', 'accepted', 'confirmed'] as const;
  const idx = statuses.indexOf(command.status as (typeof statuses)[number]);
  const steps = ['Queued', 'Submitted', 'Provider accepted', 'Vehicle confirmed'];
  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Activity size={16} className="text-accent" />{' '}
          {COMMAND_DEFINITIONS[command.type]?.label ?? command.type}
        </span>
      }
    >
      <div className="space-y-4">
        <ol className="space-y-2">
          {steps.map((label, i) => {
            const done = idx >= i;
            const failed = ['failed', 'rejected', 'timed_out', 'unsupported', 'canceled'].includes(
              command.status,
            );
            return (
              <li
                key={label}
                className={`flex items-center gap-2 text-sm ${done && !failed ? 'text-ok' : failed && i >= idx ? 'text-danger' : i === idx + 1 ? 'text-subtle' : 'text-faint'}`}
              >
                {done || failed ? <CircleDot size={14} /> : <Clock size={14} />}
                {label}
                {i === idx && <span className="text-xs text-faint">· current</span>}
              </li>
            );
          })}
        </ol>
        {command.errorMessage && (
          <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {command.errorMessage}
          </div>
        )}
        {outcomeFor(command.status).explain && command.status !== 'confirmed' && (
          <p className="text-sm text-subtle">{outcomeFor(command.status).explain}</p>
        )}
        {command.status === 'confirmed' && (
          <div className="rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">
            Vehicle state confirms the command completed.
          </div>
        )}
        {command.events && command.events.length > 0 && (
          <div>
            <h4 className="mb-1 text-xs font-bold uppercase text-faint">Audit trail</h4>
            <ul className="space-y-1 text-xs text-subtle">
              {command.events.map((e) => (
                <li key={e.id}>
                  [{fmtClock(e.createdAt)}] {e.event} — {e.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

function StateDetails({
  vehicle: _vehicle,
  state,
  units,
}: {
  vehicle: VehicleWithState;
  state: VehicleState | null;
  units: 'metric' | 'imperial';
}) {
  if (!state)
    return (
      <Card title="State">
        <p className="py-2 text-sm text-faint">No state snapshot yet.</p>
      </Card>
    );
  const doors = state.doors ?? {
    frontLeft: false,
    frontRight: false,
    rearLeft: false,
    rearRight: false,
  };
  const anyDoor = Object.values(doors).some(Boolean);
  const tire = state.tirePressureKpa;

  return (
    <>
      <Card title="Battery & charging">
        <div className="mb-2 flex items-end justify-between">
          <span
            className={`text-3xl font-extrabold ${batteryTone(state.batteryPercent) === 'danger' ? 'text-danger' : 'text-accent'}`}
          >
            {Math.round(state.batteryPercent ?? 0)}%
          </span>
          <span className="text-sm text-subtle">
            {fmtDist(state.batteryRangeKm ?? 0, units, 0)} estimated range
          </span>
        </div>
        <ProgressBar
          value={state.batteryPercent ?? 0}
          tone={state.chargingState === 'charging' ? 'bg-charging' : 'bg-accent'}
        />
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <Row k="Charge limit" v={state.chargeLimitPct ? `${state.chargeLimitPct}%` : '—'} />
          <Row k="Charging state" v={state.chargingState ?? '—'} />
          <Row
            k="Power"
            v={state.chargingState === 'charging' ? fmtPower(state.chargePowerKw) : '—'}
          />
          <Row k="Current" v={state.chargeCurrentA ? `${state.chargeCurrentA} A` : '—'} />
          <Row
            k="Time to full"
            v={state.timeToFullChargeMin ? `${Math.round(state.timeToFullChargeMin)} min` : '—'}
          />
          <Row
            k="Capacity (est.)"
            v={state.batteryCapacityKwh ? `${state.batteryCapacityKwh} kWh` : '—'}
          />
        </dl>
      </Card>

      <Card title="Climate">
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <Row k="Climate" v={state.climateOn ? 'On' : 'Off'} />
          <Row k="Inside" v={fmtTemp(state.insideTempC, units)} />
          <Row k="Outside" v={fmtTemp(state.outsideTempC, units)} />
          <Row k="Target" v={fmtTemp(state.driverTempSettingC, units)} />
          <Row k="Defrost" v={state.defrostOn ? 'On' : 'Off'} />
          <Row k="Seat heat" v={state.seatHeaterLevel ? String(state.seatHeaterLevel) : 'Off'} />
        </dl>
      </Card>

      <Card title="Locks & security">
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <Row k="Doors" v={state.locked ? 'Locked' : 'Unlocked'} />
          <Row k="Any door open" v={anyDoor ? 'Yes' : 'No'} />
          <Row k="Trunk" v={state.trunkOpen ? 'Open' : 'Closed'} />
          <Row k="Frunk" v={state.frunkOpen ? 'Open' : 'Closed'} />
          <Row k="Windows" v={state.windowsOpen ? 'Vented' : 'Closed'} />
          <Row k="Security mode" v={state.sentryMode ? 'On' : 'Off'} />
          <Row k="Alarm" v={state.alarmState ?? '—'} />
          <Row k="Valet" v={state.valetMode ? 'On' : 'Off'} />
        </dl>
      </Card>

      <Card title="Location & odometer">
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <Row k="Odometer" v={`${Math.round(state.odometerKm ?? 0).toLocaleString()} km`} />
          <Row k="Software" v={state.softwareVersion ?? '—'} />
          <Row k="Speed" v={state.speedKmh ? fmtSpeed(state.speedKmh, units) : '—'} />
          <Row k="Heading" v={state.headingDeg ? `${Math.round(state.headingDeg)}°` : '—'} />
          <Row k="Address" v={state.address ?? '—'} span />
        </dl>
      </Card>

      {tire && (
        <Card title="Tire pressure (kPa)">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Row k="Front L" v={String(Math.round(tire.frontLeft))} />
            <Row k="Front R" v={String(Math.round(tire.frontRight))} />
            <Row k="Rear L" v={String(Math.round(tire.rearLeft))} />
            <Row k="Rear R" v={String(Math.round(tire.rearRight))} />
          </dl>
        </Card>
      )}
    </>
  );
}

function Row({ k, v, span }: { k: string; v: string; span?: boolean }) {
  return (
    <div className={span ? 'col-span-2' : ''}>
      <dt className="text-[10px] font-bold uppercase tracking-wider text-faint">{k}</dt>
      <dd className="truncate text-sm">{v}</dd>
    </div>
  );
}

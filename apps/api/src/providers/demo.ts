// Deterministic DemoProvider: a fictional fleet that evolves with time.
// Never contacts real services. All names, places, and coordinates are
// fictional. Demo commands mutate overlays; the underlying simulation is a
// pure function of time.

import {
  hashString,
  seededRng,
  type CommandDispatchResult,
  type FetchStateResult,
  type ProviderContext,
  type ProviderVehicleDescriptor,
  type VehicleProvider,
} from './types';
import { prisma } from '../core/db';
import type { Capability, CommandParams, CommandType, VehicleState } from '@voltlink/shared';

// Fictional region: Rivermark County (clearly fictional coordinates).
export const DEMO_HOME = { lat: 39.0421, lon: -104.6712, name: '1420 Meridian Ave, Rivermark' };
export const DEMO_WORK = { lat: 39.1134, lon: -104.5841, name: '48 Copper Creek Rd, Rivermark' };
export const DEMO_OFFICE = { lat: 39.1001, lon: -104.5902, name: 'Rivermark Commerce Park' };
export const DEMO_SITE = { lat: 39.2211, lon: -104.4933, name: 'Hawk Ridge Trailhead' };
export const DEMO_CHARGER = { lat: 39.0877, lon: -104.6033, name: 'Rivermark Supercharge' };

const FULL_CAPABILITIES: Capability[] = [
  'wake',
  'lock',
  'unlock',
  'climate_start',
  'climate_stop',
  'set_temperature',
  'defrost',
  'seat_heater',
  'steering_heater',
  'charge_start',
  'charge_stop',
  'set_charge_limit',
  'set_charging_amps',
  'charge_port_open',
  'charge_port_close',
  'open_trunk',
  'open_frunk',
  'window_vent',
  'window_close',
  'sentry_mode',
  'flash_lights',
  'honk_horn',
  'homelink',
  'remote_start',
  'valet_mode',
  'speed_limit',
  'send_navigation',
  'schedule_update',
  'location',
];

interface DemoVehicleSpec {
  id: string;
  name: string;
  make: string;
  model: string;
  year: number;
  vehicleClass: 'compact_sedan' | 'sport_sedan' | 'compact_crossover' | 'suv' | 'pickup';
  color: string;
  wheelStyle: string;
  vinLast4: string;
  batteryKwh: number;
  efficiencyWhPerKm: number;
  odometerBase: number;
  capabilities: Capability[];
  /** Role in the demo: park/home, drive loop, charging, office, offline */
  role: 'home' | 'driver' | 'charger' | 'office' | 'offline';
  chargeLimit: number;
}

export const DEMO_VEHICLES: DemoVehicleSpec[] = [
  {
    id: 'demo-aurora',
    name: 'Aurora',
    make: 'Halcyon',
    model: 'Pulse',
    year: 2025,
    vehicleClass: 'compact_sedan',
    color: '#3b7fbd',
    wheelStyle: 'aero',
    vinLast4: '1F4K',
    batteryKwh: 60,
    efficiencyWhPerKm: 151,
    odometerBase: 8421,
    capabilities: FULL_CAPABILITIES.filter((c) => c !== 'homelink'),
    role: 'home',
    chargeLimit: 90,
  },
  {
    id: 'demo-comet',
    name: 'Comet',
    make: 'Halcyon',
    model: 'Veloce',
    year: 2025,
    vehicleClass: 'sport_sedan',
    color: '#c0392b',
    wheelStyle: 'sport',
    vinLast4: '7R2M',
    batteryKwh: 78,
    efficiencyWhPerKm: 172,
    odometerBase: 5310,
    capabilities: FULL_CAPABILITIES.filter((c) => c !== 'remote_start' && c !== 'homelink'),
    role: 'driver',
    chargeLimit: 80,
  },
  {
    id: 'demo-terra',
    name: 'Terra',
    make: 'Cascade',
    model: 'Crosswind',
    year: 2024,
    vehicleClass: 'compact_crossover',
    color: '#2e8b57',
    wheelStyle: 'touring',
    vinLast4: '3G9T',
    batteryKwh: 72,
    efficiencyWhPerKm: 168,
    odometerBase: 12900,
    capabilities: FULL_CAPABILITIES,
    role: 'charger',
    chargeLimit: 85,
  },
  {
    id: 'demo-atlas',
    name: 'Atlas',
    make: 'Cascade',
    model: 'Range',
    year: 2024,
    vehicleClass: 'suv',
    color: '#5d5f66',
    wheelStyle: 'alloy',
    vinLast4: '9N1W',
    batteryKwh: 100,
    efficiencyWhPerKm: 195,
    odometerBase: 21880,
    capabilities: FULL_CAPABILITIES,
    role: 'office',
    chargeLimit: 80,
  },
  {
    id: 'demo-bison',
    name: 'Bison',
    make: 'Northline',
    model: 'Hauler',
    year: 2023,
    vehicleClass: 'pickup',
    color: '#8a6d3b',
    wheelStyle: 'offroad',
    vinLast4: '4D7P',
    batteryKwh: 110,
    efficiencyWhPerKm: 240,
    odometerBase: 30411,
    capabilities: FULL_CAPABILITIES.filter((c) => c !== 'schedule_update'),
    role: 'offline',
    chargeLimit: 90,
  },
];

// Overlays applied by demo commands, kept in memory (re-derivable on restart).
const overlays = new Map<string, Partial<VehicleState>>();

// Z-DEMOSCOPE: degradation is per organization, never process-global.
async function orgDegraded(ctx: ProviderContext): Promise<boolean> {
  if (!ctx.accountId) return false;
  try {
    const account = await prisma.providerAccount.findUnique({
      where: { id: ctx.accountId },
      select: { organizationId: true },
    });
    if (!account) return false;
    const org = await prisma.organization.findUnique({
      where: { id: account.organizationId },
      select: { demoDegraded: true },
    });
    return org?.demoDegraded === true;
  } catch {
    return false;
  }
}

export async function isDemoDegraded(ctx: ProviderContext): Promise<boolean> {
  return orgDegraded(ctx);
}

function timeOfDay(now = new Date()): {
  hour: number;
  minute: number;
  dayIndex: number;
  epoch: number;
} {
  const hour = now.getUTCHours() + 7; // fictional "Rivermark Time" (UTC-7)
  const wrapped = ((hour % 24) + 24) % 24;
  const minute = now.getUTCMinutes();
  const dayIndex = Math.floor(now.getTime() / 86400000);
  return {
    hour: Math.floor(wrapped + minute / 60),
    minute,
    dayIndex,
    epoch: Math.floor(now.getTime() / 1000),
  };
}

function daySchedule(t: {
  hour: number;
}):
  'sleep' | 'home_charge' | 'commute_morning' | 'work' | 'commute_evening' | 'active' | 'charging' {
  const h = t.hour;
  if (h >= 0 && h < 6) return 'home_charge';
  if (h >= 6 && h < 8) return 'commute_morning';
  if (h >= 8 && h < 17) return 'work';
  if (h >= 17 && h < 18.5) return 'commute_evening';
  if (h >= 18.5 && h < 22) return 'active';
  return 'sleep';
}

/** Position along the Rivermark loop for the driving vehicle. */
function loopPosition(hourOfDay: number): {
  lat: number;
  lon: number;
  headingDeg: number;
  speedKmh: number;
  address: string;
} {
  // Comet drives loops 10:00-12:00 and 15:00-17:00 local.
  const inLoop = (hourOfDay >= 10 && hourOfDay < 12) || (hourOfDay >= 15 && hourOfDay < 17);
  const segs = [
    DEMO_HOME,
    { lat: 39.0612, lon: -104.6531, name: 'Juniper Rd' },
    DEMO_CHARGER,
    { lat: 39.0734, lon: -104.6211, name: 'Lakefront Dr' },
    DEMO_HOME,
  ];
  const segLen = 8; // minutes per segment
  const loopElapsed = ((hourOfDay % 6) + 6) % 6; // position within a 6-hour cycle
  const segIndex = Math.floor((loopElapsed * 60) / segLen) % segs.length;
  const frac = ((loopElapsed * 60) % segLen) / segLen;
  const a = segs[segIndex] ?? DEMO_HOME;
  const b = segs[(segIndex + 1) % segs.length] ?? DEMO_HOME;
  const lat = a.lat + (b.lat - a.lat) * frac;
  const lon = a.lon + (b.lon - a.lon) * frac;
  const headingDeg = (Math.atan2(b.lon - a.lon, b.lat - a.lat) * 180) / Math.PI + 90;
  return {
    lat,
    lon,
    headingDeg: ((headingDeg % 360) + 360) % 360,
    speedKmh: inLoop ? 34 + Math.sin(hourOfDay * 7) * 18 : 0,
    address: inLoop ? `${a.name} → ${b.name}` : 'Parked — 1420 Meridian Ave',
  };
}

function commutePosition(
  hourOfDay: number,
  towardWork: boolean,
): { lat: number; lon: number; headingDeg: number; speedKmh: number; address: string } {
  const start = towardWork ? DEMO_HOME : DEMO_WORK;
  const end = towardWork ? DEMO_WORK : DEMO_HOME;
  const begin = towardWork ? 7.3 : 17.0;
  const frac = Math.min(1, Math.max(0, (hourOfDay - begin) / 0.9));
  const lat = start.lat + (end.lat - start.lat) * frac;
  const lon = start.lon + (end.lon - start.lon) * frac;
  const headingDeg = (Math.atan2(end.lon - start.lon, end.lat - start.lat) * 180) / Math.PI + 90;
  const speedKmh = frac > 0 && frac < 1 ? 58 + Math.sin(hourOfDay * 13) * 12 : 0;
  return {
    lat,
    lon,
    headingDeg: ((headingDeg % 360) + 360) % 360,
    speedKmh,
    address: `Rivermark Pkwy (${towardWork ? 'to office' : 'homebound'})`,
  };
}

/** Base (non-overlay) simulated state for a demo vehicle at the current time. */
export function simulatedState(
  spec: DemoVehicleSpec,
  now: Date,
  degraded = false,
): Omit<VehicleState, 'vehicleId' | 'provider' | 'providerVehicleId'> {
  const t = timeOfDay(now);
  const phase = daySchedule(t);
  const rng = seededRng(hashString(spec.id) ^ t.dayIndex);

  const state: VehicleState = {
    vehicleId: '',
    provider: 'demo',
    providerVehicleId: spec.id,
    fetchedAt: now.toISOString(),
    freshness: 'live',
    status: 'unknown',
    dataSource: 'telemetry',
    odometerKm: spec.odometerBase + t.dayIndex * 38,
    softwareVersion: '2026.32.6',
    chargeLimitPct: spec.chargeLimit,
    tirePressureKpa: { frontLeft: 282, frontRight: 279, rearLeft: 285, rearRight: 281 },
    outsideTempC: 12 + Math.sin(t.dayIndex / 5 + (hashString(spec.id) % 10)) * 9,
    insideTempC: 19 + rng() * 3,
    locked: true,
    doors: { frontLeft: false, frontRight: false, rearLeft: false, rearRight: false },
    trunkOpen: false,
    frunkOpen: false,
    windowsOpen: false,
    climateOn: false,
    sentryMode: false,
    valetMode: false,
    alarmState: 'armed',
    batteryCapacityKwh: spec.batteryKwh,
    lat: DEMO_HOME.lat,
    lon: DEMO_HOME.lon,
    address: DEMO_HOME.name,
  };

  switch (spec.role) {
    case 'home': {
      if (phase === 'home_charge') {
        const startPct = 38;
        const pct = Math.min(spec.chargeLimit, startPct + (t.hour - 0) * 5.4);
        state.batteryPercent = pct;
        state.chargingState = pct >= spec.chargeLimit ? 'complete' : 'charging';
        state.chargePowerKw = pct >= spec.chargeLimit ? 0 : 11.4;
        state.chargeCurrentA = pct >= spec.chargeLimit ? 0 : 48;
        state.plugConnected = true;
        state.chargePortOpen = false;
        state.status = pct >= spec.chargeLimit ? 'asleep' : 'charging';
        state.locked = true;
      } else if (phase === 'commute_morning' || phase === 'commute_evening') {
        const pos = commutePosition(t.hour, phase === 'commute_morning');
        state.status = 'driving';
        state.lat = pos.lat;
        state.lon = pos.lon;
        state.headingDeg = pos.headingDeg;
        state.speedKmh = pos.speedKmh;
        state.address = pos.address;
        const basePct = phase === 'commute_morning' ? 84 : 62;
        state.batteryPercent =
          basePct - (phase === 'commute_morning' ? (t.hour - 7.3) * 4 : (t.hour - 17) * 5);
        state.climateOn = true;
        state.insideTempC = 21.5;
      } else if (phase === 'work') {
        state.status = 'asleep';
        state.batteryPercent = 79;
        state.lat = DEMO_WORK.lat;
        state.lon = DEMO_WORK.lon;
        state.address = DEMO_WORK.name;
        state.locked = true;
      } else if (phase === 'sleep') {
        state.status = 'asleep';
        state.batteryPercent = 47;
      } else {
        state.status = 'parked';
        state.batteryPercent = 56;
        state.climateOn = t.hour > 19 && t.hour < 21;
        state.insideTempC = state.climateOn ? 22 : 19;
      }
      break;
    }
    case 'driver': {
      const pos = loopPosition(t.hour);
      const moving = pos.speedKmh > 1;
      state.status = moving ? 'driving' : 'parked';
      state.lat = pos.lat;
      state.lon = pos.lon;
      state.headingDeg = pos.headingDeg;
      state.speedKmh = pos.speedKmh;
      state.address = pos.address;
      state.batteryPercent = moving ? 64 - (t.hour % 2) * 9 : 58;
      state.climateOn = true;
      state.insideTempC = 21;
      state.locked = moving ? true : true;
      break;
    }
    case 'charger': {
      const pct = Math.min(spec.chargeLimit, 22 + ((t.epoch % (8 * 3600)) / 3600) * 7.6);
      state.status = pct >= spec.chargeLimit - 0.5 ? 'charging' : 'charging';
      state.batteryPercent = pct;
      state.chargingState = 'charging';
      state.chargePowerKw = 11.4;
      state.chargeCurrentA = 32;
      state.chargeVoltageV = 240;
      state.plugConnected = true;
      state.chargePortOpen = false;
      state.timeToFullChargeMin = Math.max(
        0,
        (((spec.chargeLimit - pct) / 100) * spec.batteryKwh * 60) / 11.4,
      );
      state.chargeEnergyAddedKwh = (pct / 100) * spec.batteryKwh * 0.08;
      state.locked = true;
      state.chargingState = 'charging';
      break;
    }
    case 'office': {
      state.status = 'asleep';
      state.batteryPercent = 61;
      state.lat = DEMO_OFFICE.lat;
      state.lon = DEMO_OFFICE.lon;
      state.address = DEMO_OFFICE.name;
      state.sentryMode = true;
      state.alarmState = 'armed';
      state.locked = true;
      break;
    }
    case 'offline': {
      state.status = 'offline';
      state.freshness = 'last_known';
      state.batteryPercent = 43;
      state.lat = DEMO_SITE.lat;
      state.lon = DEMO_SITE.lon;
      state.address = DEMO_SITE.name;
      state.locked = true;
      state.sentryMode = true;
      break;
    }
  }

  // deterministic small variations
  state.batteryRangeKm = Math.round(
    ((state.batteryPercent ?? 0) / 100) * spec.batteryKwh * (1000 / spec.efficiencyWhPerKm),
  );

  // overlay wins
  const ov = overlays.get(spec.id);
  if (ov) Object.assign(state, ov);
  if (degraded && spec.role !== 'offline') {
    state.freshness = 'stale';
    state.dataSource = 'estimated';
  }
  return state;
}

const MINUTE = 60_000;

class DemoProviderImpl implements VehicleProvider {
  id = 'demo' as const;

  async readiness(
    ctx: ProviderContext,
  ): Promise<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }> {
    const degraded = await orgDegraded(ctx);
    return {
      ok: !degraded,
      checks: [
        {
          name: 'Fictional data',
          ok: true,
          detail: 'All demo vehicles are fictional and deterministic.',
        },
        {
          name: 'Network isolation',
          ok: true,
          detail: 'Demo commands never contact real services.',
        },
        {
          name: 'Provider health',
          ok: !degraded,
          detail: degraded ? 'Simulated provider degradation is active.' : 'Demo provider healthy.',
        },
      ],
    };
  }

  async listVehicles(): Promise<ProviderVehicleDescriptor[]> {
    return DEMO_VEHICLES.map((s) => ({
      providerVehicleId: s.id,
      displayName: s.name,
      make: s.make,
      model: s.model,
      year: s.year,
      vehicleClass: s.vehicleClass,
      exteriorColor: s.color,
      wheelStyle: s.wheelStyle,
      vinLast4: s.vinLast4,
      capabilities: s.capabilities,
    }));
  }

  async fetchState(ctx: ProviderContext, providerVehicleId: string): Promise<FetchStateResult> {
    const spec = DEMO_VEHICLES.find((v) => v.id === providerVehicleId);
    if (!spec) throw new Error('Unknown demo vehicle');
    const state = simulatedState(spec, new Date(), await orgDegraded(ctx));
    const freshness = state.freshness ?? 'live';
    return {
      state: { ...state, vehicleId: undefined } as never,
      live: freshness === 'live',
      freshForSec: 90,
    };
  }

  async sendCommand(
    ctx: ProviderContext,
    providerVehicleId: string,
    type: CommandType,
    params: CommandParams,
  ): Promise<CommandDispatchResult> {
    const spec = DEMO_VEHICLES.find((v) => v.id === providerVehicleId);
    if (!spec) return { kind: 'rejected', errorMessage: 'Unknown vehicle.' };
    if (!spec.capabilities.includes(type as Capability) && type !== 'wake') {
      return {
        kind: 'unsupported',
        errorMessage: 'This demo vehicle does not support that capability.',
      };
    }
    // Deterministic rejections for realistic demo behavior.
    if (type === 'charge_start' && spec.role !== 'charger' && spec.role !== 'home') {
      return {
        kind: 'rejected',
        errorMessage: 'Charging is not available: vehicle is not plugged in.',
      };
    }
    if (type === 'open_trunk' && spec.role === 'offline') {
      return { kind: 'rejected', errorMessage: 'Vehicle is offline.' };
    }
    if (type === 'remote_start' && spec.id === 'demo-comet') {
      return { kind: 'rejected', errorMessage: 'This vehicle does not support remote start.' };
    }
    const ov = overlays.get(spec.id) ?? {};
    switch (type) {
      case 'wake':
        ov.status = 'online';
        ov.freshness = 'live';
        break;
      case 'lock':
        ov.locked = true;
        break;
      case 'unlock':
        ov.locked = false;
        break;
      case 'climate_start':
        ov.climateOn = true;
        ov.insideTempC = 22;
        break;
      case 'climate_stop':
        ov.climateOn = false;
        break;
      case 'set_temperature':
        ov.climateOn = true;
        ov.insideTempC = params.temperatureC ?? 21;
        ov.driverTempSettingC = params.temperatureC ?? 21;
        break;
      case 'defrost':
        ov.defrostOn = true;
        ov.climateOn = true;
        setTimeout(() => {
          const o = overlays.get(spec.id) ?? {};
          o.defrostOn = false;
          overlays.set(spec.id, o);
        }, 5 * MINUTE);
        break;
      case 'seat_heater':
        ov.seatHeaterLevel = params.seatLevel ?? 1;
        break;
      case 'steering_heater':
        ov.steeringHeaterOn = params.steeringOn ?? true;
        break;
      case 'charge_start':
        ov.chargingState = 'charging';
        ov.chargePowerKw = 11.4;
        break;
      case 'charge_stop':
        ov.chargingState = 'stopped';
        ov.chargePowerKw = 0;
        break;
      case 'set_charge_limit':
        ov.chargeLimitPct = params.chargeLimitPct ?? 80;
        break;
      case 'set_charging_amps':
        ov.chargeCurrentA = params.chargingAmps ?? 32;
        break;
      case 'charge_port_open':
        ov.chargePortOpen = true;
        break;
      case 'charge_port_close':
        ov.chargePortOpen = false;
        break;
      case 'open_trunk':
        ov.trunkOpen = true;
        setTimeout(() => {
          const o = overlays.get(spec.id) ?? {};
          o.trunkOpen = false;
          overlays.set(spec.id, o);
        }, 90_000);
        break;
      case 'open_frunk':
        ov.frunkOpen = true;
        setTimeout(() => {
          const o = overlays.get(spec.id) ?? {};
          o.frunkOpen = false;
          overlays.set(spec.id, o);
        }, 90_000);
        break;
      case 'window_vent':
        ov.windowsOpen = true;
        break;
      case 'window_close':
        ov.windowsOpen = false;
        break;
      case 'sentry_mode':
        ov.sentryMode = params.sentryOn ?? !ov.sentryMode;
        break;
      case 'flash_lights':
      case 'honk_horn':
        // transient — no persistent state change
        break;
      case 'homelink':
        break;
      case 'remote_start':
        ov.status = 'online';
        break;
      case 'valet_mode':
        ov.valetMode = params.valetOn ?? !ov.valetMode;
        break;
      case 'speed_limit':
        ov.speedLimitMode = {
          active: params.speedLimitKmh ? true : !ov.speedLimitMode?.active,
          limitKmh: params.speedLimitKmh ?? 110,
        };
        break;
      case 'send_navigation':
        break;
      case 'schedule_update':
        break;
      default:
        return { kind: 'unsupported', errorMessage: `Unknown command type ${type}.` };
    }
    overlays.set(spec.id, ov);
    return { kind: 'accepted', response: 'Demo provider accepted the command.' };
  }

  async health(ctx: ProviderContext): Promise<{ ok: boolean; detail: string }> {
    const degraded = await orgDegraded(ctx);
    return degraded
      ? { ok: false, detail: 'Simulated demo-provider degradation.' }
      : { ok: true, detail: 'Demo provider healthy.' };
  }
}

export const DemoProvider = DemoProviderImpl;

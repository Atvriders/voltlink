// R2-18 / M4b / M4e: table-driven predicate tests. Every observable command
// has a confirmation predicate; a non-matching snapshot must NOT confirm
// (the command stays accepted and later times out), a matching one must.
// M4b (predicate ignored, any snapshot confirms) and M4e (shared predicate:
// unlock confirms on locked===true) must turn rows red.
import { describe, expect, it } from 'vitest';
import { commandStatePredicate, type CommandType } from './commands';

type Row = {
  type: CommandType;
  params: Record<string, unknown>;
  match: Record<string, unknown>;
  mismatch: Record<string, unknown>;
};

const rows: Row[] = [
  { type: 'lock', params: {}, match: { locked: true }, mismatch: { locked: false } },
  { type: 'unlock', params: {}, match: { locked: false }, mismatch: { locked: true } },
  { type: 'climate_start', params: {}, match: { climateOn: true }, mismatch: { climateOn: false } },
  { type: 'climate_stop', params: {}, match: { climateOn: false }, mismatch: { climateOn: true } },
  {
    type: 'set_temperature',
    params: { driverTempC: 21 },
    match: { driverTempSettingC: 21 },
    mismatch: { driverTempSettingC: 24 },
  },
  {
    type: 'set_temperature',
    params: { passengerTempC: 22 },
    match: { passengerTempSettingC: 22 },
    mismatch: { passengerTempSettingC: 19 },
  },
  {
    type: 'charge_start',
    params: {},
    match: { chargingState: 'Charging' },
    mismatch: { chargingState: 'Stopped' },
  },
  {
    type: 'charge_stop',
    params: {},
    match: { chargingState: 'Stopped' },
    mismatch: { chargingState: 'Charging' },
  },
  {
    type: 'set_charge_limit',
    params: { chargeLimitPct: 80 },
    match: { chargeLimitPct: 80 },
    mismatch: { chargeLimitPct: 60 },
  },
  {
    type: 'charge_port_open',
    params: {},
    match: { chargePortDoorOpen: true },
    mismatch: { chargePortDoorOpen: false },
  },
  {
    type: 'charge_port_close',
    params: {},
    match: { chargePortDoorOpen: false },
    mismatch: { chargePortDoorOpen: true },
  },
  {
    type: 'sentry_mode',
    params: { on: true },
    match: { sentryMode: true },
    mismatch: { sentryMode: false },
  },
  {
    type: 'window_vent',
    params: {},
    match: { windowsVented: true },
    mismatch: { windowsVented: false },
  },
  {
    type: 'window_close',
    params: {},
    match: { windowsVented: false },
    mismatch: { windowsVented: true },
  },
  { type: 'open_trunk', params: {}, match: { trunkOpen: true }, mismatch: { trunkOpen: false } },
  { type: 'open_frunk', params: {}, match: { frunkOpen: true }, mismatch: { frunkOpen: false } },
  { type: 'defrost', params: {}, match: { defrostOn: true }, mismatch: { defrostOn: false } },
];

describe('R2-18 commandStatePredicate: every observable predicate, match and mismatch', () => {
  for (const row of rows) {
    it(`${row.type} ${JSON.stringify(row.params)} confirms ONLY on a matching snapshot`, () => {
      expect(
        commandStatePredicate(row.type, row.params, row.match),
        'matching snapshot must confirm',
      ).toBe(true);
      expect(
        commandStatePredicate(row.type, row.params, row.mismatch),
        'non-matching snapshot must NOT confirm',
      ).toBe(false);
    });
  }
});

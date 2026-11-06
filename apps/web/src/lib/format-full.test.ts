// Unit coverage for the formatting helpers (F-UIMISC): every formatter,
// both unit systems, and the missing-value paths.

import { describe, expect, it } from 'vitest';
import {
  fmtKm,
  fmtDist,
  fmtSpeed,
  fmtTemp,
  fmtPower,
  fmtEnergy,
  fmtDuration,
  fmtClock,
  fmtDateTime,
  fmtEfficiency,
  fmtPressure,
  fmtElevation,
  fmtMoney,
  timeAgo,
  FRESHNESS_LABEL,
  STATUS_LABEL,
  COMMAND_STATUS_LABEL,
} from './format';

describe('distance/speed/temperature formatters', () => {
  it('formats both unit systems', () => {
    expect(fmtKm(10, 'metric')).toBe('10 km');
    expect(fmtKm(10, 'imperial')).toBe('6 mi');
    expect(fmtDist(1.23, 'metric', 2)).toBe('1.23 km');
    expect(fmtDist(1.23, 'imperial')).toBe('0.8 mi');
    expect(fmtSpeed(100, 'metric')).toBe('100 km/h');
    expect(fmtSpeed(100, 'imperial')).toBe('62 mph');
    expect(fmtTemp(0, 'metric')).toBe('0°C');
    expect(fmtTemp(0, 'imperial')).toBe('32°F');
    expect(fmtTemp(undefined, 'metric')).toBe('—');
  });
});

describe('energy/duration formatters', () => {
  it('handles values and missing values', () => {
    expect(fmtPower(12.345)).toBe('12.3 kW');
    expect(fmtPower(undefined)).toBe('—');
    expect(fmtPower(null)).toBe('—');
    expect(fmtEnergy(20)).toBe('20.0 kWh');
    expect(fmtEnergy(null)).toBe('—');
    expect(fmtDuration(30)).toBe('30s');
    expect(fmtDuration(120)).toBe('2m');
    expect(fmtDuration(3600)).toBe('1h');
    expect(fmtDuration(5400)).toBe('1h 30m');
  });
});

describe('clock/date/time-ago formatters', () => {
  it('formats clock and date with timezones and tolerates garbage', () => {
    const iso = '2026-01-02T03:04:05.000Z';
    expect(fmtClock(undefined)).toBe('—');
    expect(fmtClock(iso, 'UTC')).toMatch(/\d{2}:\d{2}/);
    expect(fmtClock(iso, 'bad-zone')).toBe('—');
    expect(fmtDateTime(undefined)).toBe('—');
    expect(fmtDateTime(iso, 'UTC').length).toBeGreaterThan(0);
    expect(fmtDateTime(iso, 'bad-zone').length).toBeGreaterThan(0);
    expect(timeAgo(undefined)).toBe('—');
    expect(timeAgo(new Date(Date.now() - 30_000).toISOString())).toBe('30s ago');
    expect(timeAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(timeAgo(new Date(Date.now() - 5 * 3600_000).toISOString())).toBe('5h ago');
    expect(timeAgo(new Date(Date.now() - 5 * 86400_000).toISOString())).toBe('5d ago');
  });
});

describe('efficiency/pressure/elevation/money formatters', () => {
  it('formats both systems and missing values', () => {
    expect(fmtEfficiency(150, 'metric')).toBe('150 Wh/km');
    expect(fmtEfficiency(150, 'imperial')).toBe('241 Wh/mi');
    expect(fmtEfficiency(0, 'metric')).toBe('—');
    expect(fmtEfficiency(undefined, 'metric')).toBe('—');
    expect(fmtPressure(250, 'metric')).toBe('250 kPa');
    expect(fmtPressure(250, 'imperial')).toBe('36 psi');
    expect(fmtPressure(null, 'metric')).toBe('—');
    expect(fmtElevation(1000, 'metric')).toBe('1,000 m');
    expect(fmtElevation(1000, 'imperial')).toBe('3,281 ft');
    expect(fmtElevation(null, 'metric')).toBe('—');
    expect(fmtMoney(12.5)).toContain('12.5');
    expect(fmtMoney(undefined)).toBe('—');
    expect(fmtMoney(12.5, 'EUR')).toContain('€');
  });
});

describe('label tables', () => {
  it('cover the known keys', () => {
    expect(FRESHNESS_LABEL.live?.label).toBe('Live');
    expect(STATUS_LABEL.asleep?.label).toBe('Asleep');
    for (const key of ['queued', 'submitted', 'accepted', 'confirmed', 'failed']) {
      expect(COMMAND_STATUS_LABEL[key]).toBeDefined();
    }
  });
});

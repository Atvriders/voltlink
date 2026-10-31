import { describe, expect, it } from 'vitest';
import {
  fmtDateTime,
  fmtDist,
  fmtDuration,
  fmtEfficiency,
  fmtElevation,
  fmtEnergy,
  fmtKm,
  fmtMoney,
  fmtPower,
  fmtPressure,
  fmtSpeed,
  fmtTemp,
  timeAgo,
  FRESHNESS_LABEL,
  COMMAND_STATUS_LABEL,
} from './format';
import { circleGeoJson, fictionalCityGeoJson, routeGeoJson } from './map';

describe('format helpers', () => {
  it('formats distance in metric and imperial', () => {
    expect(fmtKm(123.45, 'metric')).toContain('123');
    expect(fmtKm(123.45, 'metric')).toContain('km');
    expect(fmtKm(100, 'imperial')).toContain('62');
    expect(fmtKm(100, 'imperial')).toContain('mi');
  });

  it('formats speeds', () => {
    expect(fmtSpeed(0, 'metric')).toContain('km/h');
    expect(fmtSpeed(100, 'metric')).toContain('100');
  });

  it('formats temperatures', () => {
    expect(fmtTemp(20, 'metric')).toContain('20');
    expect(fmtTemp(20, 'imperial')).toContain('68');
    expect(fmtTemp(undefined, 'metric')).toContain('—');
  });

  it('formats power and energy', () => {
    expect(fmtPower(7.2)).toContain('7.2');
    expect(fmtPower(7.2)).toContain('kW');
    expect(fmtEnergy(62.4)).toContain('62.4');
    expect(fmtEnergy(62.4)).toContain('kWh');
  });

  it('formats durations', () => {
    expect(fmtDuration(90)).toBe('2m');
    expect(fmtDuration(3661)).toBe('1h 1m');
    expect(fmtDuration(0)).toBe('0s');
    expect(fmtDuration(7200)).toBe('2h');
  });

  it('formats money', () => {
    expect(fmtMoney(12.5, 'USD')).toContain('$');
    expect(fmtMoney(undefined)).toContain('—');
  });

  it('timeAgo handles undefined and past dates', () => {
    expect(timeAgo(undefined)).toContain('—');
    expect(timeAgo(new Date(Date.now() - 3600_000).toISOString())).toMatch(/\d/);
  });

  it('freshness labels cover every freshness value', () => {
    for (const f of ['live', 'recent', 'stale', 'last_known']) {
      expect(FRESHNESS_LABEL[f]).toBeTruthy();
    }
  });

  it('command status labels cover the lifecycle', () => {
    for (const s of [
      'queued',
      'submitted',
      'accepted',
      'confirmed',
      'failed',
      'rejected',
      'unsupported',
      'timed_out',
      'canceled',
    ]) {
      expect(COMMAND_STATUS_LABEL[s]).toBeTruthy();
    }
  });
});

describe('map geometry helpers', () => {
  it('circleGeoJson produces a closed polygon feature', () => {
    const c = circleGeoJson(39, -104, 500);
    expect(c.type).toBe('Feature');
    const geom = c.geometry as { type: string; coordinates: number[][][] };
    expect(geom.type).toBe('Polygon');
    const ring = geom.coordinates[0]!;
    expect(ring.length).toBeGreaterThanOrEqual(32);
    const firstX = ring[0]![0]!;
    const firstY = ring[0]![1]!;
    const lastX = ring[ring.length - 1]![0]!;
    const lastY = ring[ring.length - 1]![1]!;
    expect(firstX).toBeCloseTo(lastX, 6);
    expect(firstY).toBeCloseTo(lastY, 6);
  });

  it('routeGeoJson maps points to lon/lat pairs', () => {
    const r = routeGeoJson([
      { lat: 39, lon: -104 },
      { lat: 40, lon: -105 },
    ]);
    expect(r.type).toBe('Feature');
    const geom = r.geometry as { type: string; coordinates: number[][] };
    expect(geom.type).toBe('LineString');
    expect(geom.coordinates).toEqual([
      [-104, 39],
      [-105, 40],
    ]);
  });

  it('fictional city has streets and water', () => {
    const city = fictionalCityGeoJson();
    const kinds = city.features.map((f) => (f as { properties: { kind: string } }).properties.kind);
    expect(kinds).toContain('street');
    expect(kinds).toContain('arterial');
    expect(kinds).toContain('water');
    expect(kinds).toContain('park');
    expect(city.features.length).toBeGreaterThan(50);
  });
});

describe('distance formatting edge cases', () => {
  it('fmtDist rounds to digits', () => {
    expect(fmtDist(1.23456, 'metric', 2)).toContain('1.23');
  });
});

describe('F-UIMISC unit formatting', () => {
  it('fmtPressure converts kPa to psi for imperial', () => {
    expect(fmtPressure(100, 'metric')).toBe('100 kPa');
    expect(fmtPressure(100, 'imperial')).toBe('15 psi');
  });
  it('fmtEfficiency converts Wh/km to Wh/mi', () => {
    expect(fmtEfficiency(100, 'metric')).toBe('100 Wh/km');
    expect(fmtEfficiency(100, 'imperial')).toBe('161 Wh/mi');
    expect(fmtEfficiency(0, 'metric')).toBe('—');
  });
  it('fmtElevation converts metres to feet', () => {
    expect(fmtElevation(1000, 'metric')).toBe('1,000 m');
    expect(fmtElevation(1000, 'imperial')).toBe('3,281 ft');
  });
  it('fmtDateTime formats in the requested time zone', () => {
    const iso = '2025-01-02T12:00:00.000Z';
    expect(fmtDateTime(iso, 'UTC')).toContain('2025');
    expect(fmtDateTime(iso, 'UTC')).toContain('12:00');
  });
});

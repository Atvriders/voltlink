// Tesla + Tessie adapter contract tests against local fakes (guide 01 §14,
// Gate 6). No real credentials; endpoints are 127.0.0.1 via
// TESLA_ALLOW_TEST_ENDPOINTS=true.

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/core/db';
import { randomId } from '../src/core/crypto';
import { startFakeTesla, type FakeTesla } from './fakes/fakeTesla';
import { classify } from '../src/providers/tesla/classify';
import { pkceChallenge, teslaAuthorizeUrl } from '../src/providers/tesla/oauth';
import { mapVehicleData } from '../src/providers/tesla/mapping';
import { deriveTeslaCapabilities } from '../src/providers/tesla/capabilities';
import { buildTeslaSteps } from '../src/providers/tesla/commands';
import { discoverRegion } from '../src/providers/tesla/region';
import { getValidAccessToken } from '../src/providers/tesla/tokens';
import { TeslaProviderImpl, parseClass } from '../src/providers/tesla/index';
import { seal } from '../src/core/keyring';

let fake: FakeTesla;

beforeAll(async () => {
  process.env.TESLA_ALLOW_TEST_ENDPOINTS = 'true';
  fake = await startFakeTesla(0);
  process.env.TESLA_TOKEN_URL = `${fake.base}/oauth2/v3/token`;
  process.env.TESLA_AUTHORIZE_URL = `${fake.base}/oauth2/v3/authorize`;
  process.env.TESLA_FLEET_BASE_NA = `${fake.base}`;
  process.env.TESLA_FLEET_BASE_EU = `${fake.base}`;
  process.env.TESLA_DEFAULT_AUDIENCE = `${fake.base}`;
  process.env.TESLA_COMMAND_PROXY_URL = `${fake.proxy}`;
  process.env.TESLA_CLIENT_ID = 'test-client';
  process.env.TESLA_CLIENT_SECRET = 'test-secret';
  process.env.TESLA_REDIRECT_URI = 'http://127.0.0.1:3110/api/v1/providers/tesla/callback';
  process.env.TESLA_PUBLIC_KEY_FILE = '/nonexistent-test-key.pem';
  process.env.TESLA_PARTNER_DOMAIN = '127.0.0.1';
});

afterAll(async () => {
  await fake.close();
  delete process.env.TESLA_CLIENT_ID;
  delete process.env.TESLA_CLIENT_SECRET;
  await prisma.$disconnect();
});

describe('Tesla OAuth PKCE (Z-TESLASTATE)', () => {
  it('matches the RFC 7636 Appendix B vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('builds authorize URLs with S256, keypair step, and no energy scopes', () => {
    const url = teslaAuthorizeUrl('state123', 'challenge123');
    const u = new URL(url);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('show_keypair_step')).toBe('true');
    const scopes = String(u.searchParams.get('scope'));
    expect(scopes).toContain('vehicle_location');
    expect(scopes).toContain('offline_access');
    expect(scopes).not.toContain('energy_');
  });
});

describe('fake contract strictness (guide 01 documented surface)', () => {
  it('rejects routes the real Tesla API does not have', async () => {
    const res = await fetch(`${fake.base}/api/1/vehicles/5YJ3000000NEXUS01/definitely_not_a_route`);
    expect(res.status).toBe(404);
  });

  it('rejects command names the real Tesla API does not document', async () => {
    const res = await fetch(
      `${fake.base}/api/1/vehicles/5YJ3000000NEXUS01/command/not_a_tesla_command`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect(res.status).toBe(404);
  });

  it('accepts every documented command name', async () => {
    fake.pairKey('5YJ3000000NEXUS01');
    for (const name of [
      'door_lock',
      'honk_horn',
      'actuate_trunk',
      'speed_limit_set_limit',
      'navigation_request',
    ]) {
      const res = await fetch(`${fake.base}/api/1/vehicles/5YJ3000000NEXUS01/command/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status, name).toBe(200);
    }
  });
});

describe('classify (guide 01 §6)', () => {
  const h = (init: Record<string, string> = {}) => new Headers(init);
  it('maps the documented statuses to categories', () => {
    expect(classify(408, '', h()).category).toBe('vehicle_unavailable');
    expect(classify(500, 'vehicle is offline or asleep', h()).category).toBe('vehicle_unavailable');
    expect(classify(500, 'public key has not been paired', h()).category).toBe(
      'virtual_key_not_paired',
    );
    expect(classify(401, 'login_required', h()).category).toBe('reauth_required');
    expect(classify(401, '', h()).category).toBe('token_expired');
    expect(classify(402, '', h()).category).toBe('billing_required');
    expect(classify(403, 'command protocol required', h()).category).toBe('protocol_required');
    expect(classify(412, '', h()).category).toBe('partner_not_registered');
    expect(classify(421, '', h()).category).toBe('wrong_region');
    expect(classify(429, '', h({ 'retry-after': '4' })).retryAfterMs).toBe(4000);
    expect(classify(503, '', h()).category).toBe('outcome_unknown');
  });
});

describe('mapping (P-TESLAMAP / G-04)', () => {
  it('maps the doc example: latch Engaged is NOT plugged in', () => {
    const out = mapVehicleData(
      {
        charge_state: {
          charging_state: 'Disconnected',
          battery_level: 60,
          battery_range: 133.99,
          charge_limit_soc: 80,
          charge_port_latch: 'Engaged',
          charge_current_request: 32,
          timestamp: 1700000000000,
        },
        climate_state: {
          inside_temp: 21.5,
          outside_temp: 18,
          driver_temp_setting: 21,
          timestamp: 1700000000000,
        },
        drive_state: {
          shift_state: 'P',
          latitude: 37.77,
          longitude: -122.41,
          heading: 90,
          timestamp: 1700000000000,
        },
        vehicle_state: {
          locked: true,
          df: 0,
          pf: 0,
          dr: 0,
          pr: 0,
          ft: 0,
          rt: 0,
          odometer: 1000,
          timestamp: 1700000000000,
        },
        vehicle_config: { rhd: false },
      },
      'online',
    );
    expect(out.chargingState).toBe('disconnected');
    expect(out.plugConnected).toBe(false); // NOT charge_port_latch
    expect(out.batteryRangeKm).toBeCloseTo(215.6, 1); // 133.99 mi in km
    expect(out.chargeCurrentRequestA).toBe(32);
    expect(out.odometerKm).toBeCloseTo(1609.3, 1);
  });

  it('swaps doors on RHD cars', () => {
    const out = mapVehicleData(
      {
        vehicle_state: { df: 1, pf: 0, dr: 0, pr: 0, timestamp: 1700000000000 },
        vehicle_config: { rhd: true },
      },
      'online',
    );
    expect(out.doors).toEqual({
      frontLeft: false,
      frontRight: true,
      rearLeft: false,
      rearRight: false,
    });
  });
});

describe('capabilities (NEW-07)', () => {
  it('derives from scopes + hardware, blocking signed commands without a key', () => {
    const { capabilities, details } = deriveTeslaCapabilities({
      scopes: ['vehicle_device_data', 'vehicle_cmds', 'vehicle_location'],
      hidePrivate: false,
      vd: {
        vehicle_config: { can_actuate_trunks: true, motorized_charge_port: true },
        vehicle_state: {
          fd_window: 0,
          sentry_mode_available: true,
          remote_start_supported: true,
          speed_limit_mode: { active: false },
          valet_mode: false,
          homelink_device_count: 2,
          software_update: { status: 'available' },
        },
        climate_state: {
          seat_heater_left: 0,
          steering_wheel_heater: false,
          min_avail_temp: 15,
          max_avail_temp: 28,
        },
        charge_state: {
          charge_current_request_max: 48,
          charge_limit_soc_min: 50,
          charge_limit_soc_max: 100,
        },
      },
      fleet: { protocolRequired: true, keyPaired: false },
    });
    expect(capabilities).toContain('wake');
    expect(capabilities).toContain('location');
    expect(capabilities).not.toContain('lock'); // key not paired
    expect(details.lock?.reason).toBe('virtual_key_not_paired');
    expect(details.set_charging_amps?.max).toBe(48);
  });
});

describe('commands (P-TESLASIGN)', () => {
  it('builds the documented name and body for every control', () => {
    expect(buildTeslaSteps('lock', {}, {})).toEqual([
      { name: 'door_lock', body: {}, idempotent: true },
    ]);
    expect(buildTeslaSteps('open_trunk', {}, {})).toEqual([
      { name: 'actuate_trunk', body: { which_trunk: 'rear' }, idempotent: false },
    ]);
    expect(buildTeslaSteps('set_temperature', { temperatureC: 22 }, {})).toEqual([
      { name: 'set_temps', body: { driver_temp: 22, passenger_temp: 22 }, idempotent: true },
    ]);
    expect(buildTeslaSteps('valet_mode', { valetOn: true }, { pin: '1234' })).toEqual([
      { name: 'set_valet_mode', body: { on: true, password: '1234' }, idempotent: true },
    ]);
    expect(buildTeslaSteps('speed_limit', { speedLimitOn: false }, { pin: '4321' })).toEqual([
      { name: 'speed_limit_deactivate', body: { pin: '4321' }, idempotent: true },
    ]);
    expect(buildTeslaSteps('wake', {}, {})[0]!.name).toBe('wake_up');
  });
});

describe('region discovery (P-TESLAREGION)', () => {
  it('skips 421 and falls through to the next region', async () => {
    // The fake answers 421 from users/region; discovery must classify, not crash.
    await expect(discoverRegion('access-abc')).rejects.toThrow(/421|wrong_region/);
  });
});

describe('token refresh rotation (P-TESLAREFRESH)', () => {
  it('refreshes once under concurrency and persists the rotated refresh token', async () => {
    const user = await prisma.user.create({
      data: {
        email: `tref-${Date.now()}@example.test`,
        name: 'Tesla Refresh',
        passwordHash: 'x',
        webauthnUserId: randomId(),
      },
    });
    const org = await prisma.organization.create({
      data: {
        kind: 'PERSONAL',
        name: 't',
        createdById: user.id,
        memberships: { create: { userId: user.id, role: 'OWNER' } },
      },
    });
    const account = await prisma.providerAccount.create({
      data: { organizationId: org.id, provider: 'tesla', label: 'Tesla', status: 'connected' },
    });
    const { sealJson } = await import('../src/core/crypto');
    await prisma.providerCredential.create({
      data: {
        providerAccountId: account.id,
        keyVersion: 1,
        algorithm: sealJson({}).algorithm,
        ciphertext: sealJson({
          accessToken: 'old-access',
          refreshToken: 'old-refresh',
          expiresAt: Date.now() - 1000, // expired
          scopes: [],
        }).ciphertext,
      },
    });
    const before = fake.requests.filter((r) => r.path === '/oauth2/v3/token').length;
    const results = await Promise.allSettled([
      getValidAccessToken(account.id),
      getValidAccessToken(account.id),
    ]);
    const after = fake.requests.filter((r) => r.path === '/oauth2/v3/token').length;
    expect(after - before).toBe(1); // exactly one refresh call
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const creds = await prisma.providerCredential.findUniqueOrThrow({
      where: { providerAccountId: account.id },
    });
    const { open } = await import('../src/core/keyring');
    const stored = JSON.parse(
      open(creds.ciphertext, `provider-credential:${account.id}`),
    ) as { refreshToken: string; expiresAt: number };
    expect(stored.refreshToken).not.toBe('old-refresh');
    expect(stored.expiresAt).toBeGreaterThan(Date.now());
    await prisma.providerCredential.deleteMany({ where: { providerAccountId: account.id } });
    await prisma.providerAccount.deleteMany({ where: { id: account.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  });
});

describe('Tesla provider-level flows', () => {
  it('parseClass maps VIN digit 8 and falls back', () => {
    expect(parseClass('5YJ30000000000001')).toBe('fallback');
    expect(parseClass('5YJ30003000000001')).toBe('compact_sedan');
    expect(parseClass('5YJ3000S000000001')).toBe('sport_sedan');
    expect(parseClass('5YJ3000X000000001')).toBe('suv');
    expect(parseClass('5YJ3000Y000000001')).toBe('compact_crossover');
  });

  it('readiness reports per-vehicle key pairing from fleet_status', async () => {
    const org = await prisma.organization.create({ data: { name: 'Tesla Org' } });
    const pa = await prisma.providerAccount.create({
      data: { organizationId: org.id, provider: 'tesla', label: 'Tesla', status: 'connected', demo: false },
    });
    await prisma.vehicle.create({
      data: {
        organizationId: org.id,
        providerAccountId: pa.id,
        provider: 'tesla',
        providerVehicleId: '5YJ3000000NEXUS01',
        displayName: 'Nexus One',
      },
    });
    await prisma.vehicle.create({
      data: {
        organizationId: org.id,
        providerAccountId: pa.id,
        provider: 'tesla',
        providerVehicleId: '5YJ3000000N0KEY01',
        displayName: 'No Key',
      },
    });
    fake.pairKey('5YJ3000000NEXUS01');
    const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ scp: [] })).toString('base64url')}.sig`;
    await prisma.providerCredential.create({
      data: {
        providerAccountId: pa.id,
        keyVersion: seal(JSON.stringify({ accessToken: jwt, refreshToken: 'rt', expiresAt: Date.now() + 3600_000 }), `provider-credential:${pa.id}`).keyVersion,
        algorithm: 'v1',
        ciphertext: seal(JSON.stringify({ accessToken: jwt, refreshToken: 'rt', expiresAt: Date.now() + 3600_000 }), `provider-credential:${pa.id}`).ciphertext,
      },
    });
    const p = new TeslaProviderImpl();
    const r = await p.readiness({ accountId: pa.id });
    const paired = r.checks.find((c) => c.name === 'vehicle.US01.key');
    const unpaired = r.checks.find((c) => c.name === 'vehicle.EY01.key');
    expect(paired?.ok).toBe(true);
    expect(unpaired?.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('fetchState online maps vehicle_data and reports live', async () => {
    const org = await prisma.organization.create({ data: { name: 'Tesla Org 2' } });
    const pa = await prisma.providerAccount.create({
      data: { organizationId: org.id, provider: 'tesla', label: 'Tesla', status: 'connected', demo: false },
    });
    await prisma.vehicle.create({
      data: {
        organizationId: org.id,
        providerAccountId: pa.id,
        provider: 'tesla',
        providerVehicleId: '5YJ3000000NEXUS01',
        displayName: 'Nexus One',
      },
    });
    const payload = Buffer.from(
      JSON.stringify({ scp: ['vehicle_location', 'vehicle_device_data', 'vehicle_cmds'] }),
    ).toString('base64url');
    const jwt = `eyJhbGciOiJub25lIn0.${payload}.sig`;
    await prisma.providerCredential.create({
      data: {
        providerAccountId: pa.id,
        keyVersion: seal(JSON.stringify({ accessToken: jwt, refreshToken: 'rt', expiresAt: Date.now() + 3600_000 }), `provider-credential:${pa.id}`).keyVersion,
        algorithm: 'v1',
        ciphertext: seal(JSON.stringify({ accessToken: jwt, refreshToken: 'rt', expiresAt: Date.now() + 3600_000 }), `provider-credential:${pa.id}`).ciphertext,
      },
    });
    fake.setConnectivity('5YJ3000000NEXUS01', 'online');
    const p = new TeslaProviderImpl();
    const out = await p.fetchState(
      { accountId: pa.id, userId: 'u1', credentials: {}, meta: { provider: 'tesla', label: 'T', demo: false, scopes: [] } },
      '5YJ3000000NEXUS01',
    );
    expect(out.live).toBe(true);
    expect(out.freshForSec).toBe(60);
  });

  it('fetchState asleep falls back to cached data or throws vehicle_asleep', async () => {
    const org = await prisma.organization.create({ data: { name: 'Tesla Org 3' } });
    const pa = await prisma.providerAccount.create({
      data: { organizationId: org.id, provider: 'tesla', label: 'Tesla', status: 'connected', demo: false },
    });
    const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ scp: [] })).toString('base64url')}.sig`;
    await prisma.providerCredential.create({
      data: {
        providerAccountId: pa.id,
        keyVersion: seal(JSON.stringify({ accessToken: jwt, refreshToken: 'rt', expiresAt: Date.now() + 3600_000 }), `provider-credential:${pa.id}`).keyVersion,
        algorithm: 'v1',
        ciphertext: seal(JSON.stringify({ accessToken: jwt, refreshToken: 'rt', expiresAt: Date.now() + 3600_000 }), `provider-credential:${pa.id}`).ciphertext,
      },
    });
    fake.setConnectivity('5YJ3000000NEXUS01', 'asleep');
    const p = new TeslaProviderImpl();
    await expect(
      p.fetchState(
        { accountId: pa.id, userId: 'u1', credentials: {}, meta: { provider: 'tesla', label: 'T', demo: false, scopes: [] } },
        '5YJ3000000NEXUS01',
      ),
    ).rejects.toThrow('vehicle_asleep');
  });

  it('sendCommand wake goes to the fleet host and health reports reachability', async () => {
    const org = await prisma.organization.create({ data: { name: 'Tesla Org 4' } });
    const pa = await prisma.providerAccount.create({
      data: { organizationId: org.id, provider: 'tesla', label: 'Tesla', status: 'connected', demo: false },
    });
    const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ scp: ['vehicle_cmds'] })).toString('base64url')}.sig`;
    await prisma.providerCredential.create({
      data: {
        providerAccountId: pa.id,
        keyVersion: seal(JSON.stringify({ accessToken: jwt, refreshToken: 'rt', expiresAt: Date.now() + 3600_000 }), `provider-credential:${pa.id}`).keyVersion,
        algorithm: 'v1',
        ciphertext: seal(JSON.stringify({ accessToken: jwt, refreshToken: 'rt', expiresAt: Date.now() + 3600_000 }), `provider-credential:${pa.id}`).ciphertext,
      },
    });
    fake.pairKey('5YJ3000000NEXUS01');
    fake.setConnectivity('5YJ3000000NEXUS01', 'online');
    const ctx = { accountId: pa.id, userId: 'u1', credentials: {}, meta: { provider: 'tesla', label: 'T', demo: false, scopes: [] } };
    const p = new TeslaProviderImpl();
    const wake = await p.sendCommand(ctx, '5YJ3000000NEXUS01', 'wake', {});
    expect(wake.kind).toBe('accepted');
    const unsupported = await p.sendCommand(ctx, '5YJ3000000NEXUS01', 'definitely_not_mapped' as never, {});
    expect(unsupported.kind).toBe('unsupported');
    const h = await p.health(ctx);
    expect(h.ok).toBe(true);
  });
});

// Tenancy migration test (guide 05 §3, spec L534): deploy the three legacy
// migrations, load the legacy fixture, then deploy everything and verify the
// data conversion. Requires TEST_DATABASE_ADMIN_URL.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { adminDatabaseUrl } from './lib/admin-url';

const ADMIN_URL = adminDatabaseUrl();
const API_ROOT = path.resolve(__dirname, '..');
const PRISMA_DIR = path.join(API_ROOT, 'prisma');
const SCHEMA = path.join(PRISMA_DIR, 'schema.prisma');
const MIGRATIONS_DIR = path.join(PRISMA_DIR, 'migrations');
const FIXTURE = path.join(__dirname, 'fixtures', 'legacy-seed.sql');

function prismaBin(): string {
  const candidates = [
    path.resolve(API_ROOT, 'node_modules', '.bin', 'prisma'),
    path.resolve(API_ROOT, '..', '..', 'node_modules', '.bin', 'prisma'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return require.resolve('prisma/build/index.js');
}

function deploy(schemaPath: string, databaseUrl: string): void {
  const bin = prismaBin();
  const args = ['migrate', 'deploy', '--schema', schemaPath];
  const env = { ...process.env, DATABASE_URL: databaseUrl, CHECKPOINT_DISABLE: '1' };
  if (bin.endsWith('.js'))
    execFileSync(process.execPath, [bin, ...args], { cwd: API_ROOT, stdio: 'pipe', env });
  else execFileSync(bin, args, { cwd: API_ROOT, stdio: 'pipe', env });
}

async function adminClient(): Promise<Client> {
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  return c;
}

const suffix = `${Date.now()}_${process.pid}`;
const dbName = `voltlink_test_tenancy_${suffix}`;
let admin!: Client;
let dbUrl: string;

beforeAll(async () => {
  admin = await adminClient();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  dbUrl = url.toString();

  // Build a copy of prisma/ containing only the three shipped legacy migrations.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voltlink-tenancy-'));
  const legacyDir = path.join(tmp, 'migrations');
  fs.cpSync(MIGRATIONS_DIR, legacyDir, { recursive: true });
  for (const name of fs.readdirSync(legacyDir)) {
    if (
      name.startsWith('20261030213636') ||
      name.startsWith('20261030213700') ||
      name.startsWith('20261030214947')
    ) {
      fs.rmSync(path.join(legacyDir, name), { recursive: true, force: true });
    }
  }
  const legacySchema = path.join(tmp, 'schema.prisma');
  fs.copyFileSync(SCHEMA, legacySchema);
  try {
    deploy(legacySchema, dbUrl);
    const c = new Client({ connectionString: dbUrl });
    await c.connect();
    await c.query(fs.readFileSync(FIXTURE, 'utf8'));
    await c.end();
    deploy(SCHEMA, dbUrl);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, 180_000);

afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.end();
}, 60_000);

function client(): Client {
  return new Client({ connectionString: dbUrl });
}

describe('tenancy migration (legacy data conversion)', () => {
  it('leaves no vehicle without an organization', async () => {
    const c = client();
    await c.connect();
    try {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM "Vehicle" WHERE "organizationId" IS NULL`,
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('every organization has an ACTIVE OWNER membership', async () => {
    const c = client();
    await c.connect();
    try {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM "Organization" o WHERE NOT EXISTS
           (SELECT 1 FROM "Membership" m WHERE m."organizationId" = o.id AND m.role = 'OWNER' AND m.status = 'ACTIVE')`,
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('exactly one instance admin exists', async () => {
    const c = client();
    await c.connect();
    try {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM "User" WHERE "isInstanceAdmin"`,
      );
      expect(rows[0].n).toBe(1);
    } finally {
      await c.end();
    }
  });

  it('revokes every legacy session', async () => {
    const c = client();
    await c.connect();
    try {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM "UserSession" WHERE "revokedAt" IS NULL`,
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('purges the soft-deleted user and all of their data', async () => {
    const c = client();
    await c.connect();
    try {
      const user = await c.query(`SELECT count(*)::int AS n FROM "User" WHERE id = 'u2'`);
      expect(user.rows[0].n).toBe(0);
      const vehicles = await c.query(`SELECT count(*)::int AS n FROM "Vehicle" WHERE id = 'v2'`);
      expect(vehicles.rows[0].n).toBe(0);
      const places = await c.query(`SELECT count(*)::int AS n FROM "Place" WHERE id = 'pl2'`);
      expect(places.rows[0].n).toBe(0);
      const drives = await c.query(`SELECT count(*)::int AS n FROM "Drive" WHERE id = 'd2'`);
      expect(drives.rows[0].n).toBe(0);
      const telemetry = await c.query(
        `SELECT count(*)::int AS n FROM telemetry.telemetry_reading WHERE vehicle_id = 'v2'`,
      );
      expect(telemetry.rows[0].n).toBe(0);
      const kept = await c.query(
        `SELECT count(*)::int AS n FROM telemetry.telemetry_reading WHERE vehicle_id = 'v1'`,
      );
      expect(kept.rows[0].n).toBe(2);
    } finally {
      await c.end();
    }
  });

  it('converts the legacy vehicle permission into a DRIVER grant without high-risk', async () => {
    const c = client();
    await c.connect();
    try {
      const { rows } = await c.query(
        `SELECT level, "allowHighRisk", "grantedById" FROM "VehicleGrant" WHERE "vehicleId" = 'v1' AND "userId" = 'u3'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].level).toBe('DRIVER');
      expect(rows[0].allowHighRisk).toBe(false);
      expect(rows[0].grantedById).toBe('u1');
      const leftovers = await c.query(
        `SELECT to_regclass('public."VehiclePermission"') IS NOT NULL AS still_there`,
      );
      expect(leftovers.rows[0].still_there).toBe(false);
    } finally {
      await c.end();
    }
  });

  it('resets the legacy TOTP enrolment with an audit row and a notification', async () => {
    const c = client();
    await c.connect();
    try {
      const u = await c.query(`SELECT "totpEnabled" FROM "User" WHERE id = 'u1'`);
      expect(u.rows[0].totpEnabled).toBe(false);
      const audit = await c.query(
        `SELECT count(*)::int AS n FROM "AuditLog" WHERE "entityId" = 'u1' AND action = 'auth.mfa.totp_reset_by_upgrade'`,
      );
      expect(audit.rows[0].n).toBe(1);
      const note = await c.query(
        `SELECT count(*)::int AS n FROM "AppNotification" WHERE "userId" = 'u1' AND event = 'security'`,
      );
      expect(note.rows[0].n).toBe(1);
    } finally {
      await c.end();
    }
  });

  it('backfills a webauthn user id for every user', async () => {
    const c = client();
    await c.connect();
    try {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM "User" WHERE "webauthnUserId" IS NULL`,
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });
});

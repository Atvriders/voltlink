// Migration A (telemetry schema + voltlink rename) tests — guide 04 §3.6,
// Phase 1 subset. Runs against throwaway databases it creates itself through
// TEST_DATABASE_ADMIN_URL (a role with CREATEDB). The Phase 3 additions
// (precision + drift gates) extend this file.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const API_ROOT = path.resolve(__dirname, '..');
const PRISMA_DIR = path.join(API_ROOT, 'prisma');
const SCHEMA = path.join(PRISMA_DIR, 'schema.prisma');
const MIGRATIONS_DIR = path.join(PRISMA_DIR, 'migrations');

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
  if (bin.endsWith('.js')) {
    execFileSync(process.execPath, [bin, ...args], {
      cwd: API_ROOT,
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: databaseUrl, CHECKPOINT_DISABLE: '1' },
    });
  } else {
    execFileSync(bin, args, {
      cwd: API_ROOT,
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: databaseUrl, CHECKPOINT_DISABLE: '1' },
    });
  }
}

async function adminClient(): Promise<Client> {
  if (!ADMIN_URL) {
    throw new Error('TEST_DATABASE_ADMIN_URL is required (a postgres role with CREATEDB), e.g. postgresql://voltlink:pw@127.0.0.1:5433/postgres');
  }
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  return c;
}

async function createDb(name: string, admin: Client): Promise<string> {
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function dropDb(name: string, admin: Client): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

const suffix = `${Date.now()}_${process.pid}`;
const dbName = `voltlink_test_mig_${suffix}`;
const upgradeDbName = `voltlink_test_mig_upgrade_${suffix}`;
let admin!: Client;
let dbUrl: string;

beforeAll(async () => {
  admin = await adminClient();
  dbUrl = await createDb(dbName, admin);
  deploy(SCHEMA, dbUrl);
}, 120_000);

afterAll(async () => {
  await dropDb(dbName, admin);
  await dropDb(upgradeDbName, admin);
  await admin.end();
}, 60_000);

function client(db: string = dbUrl): Client {
  return new Client({ connectionString: db });
}

describe('Migration A: telemetry schema and voltlink rename', () => {
  it('moves telemetry_reading into the telemetry schema as a partitioned table', async () => {
    const c = client();
    await c.connect();
    try {
      const { rows } = await c.query(
        `SELECT relkind FROM pg_class WHERE oid = 'telemetry.telemetry_reading'::regclass`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].relkind).toBe('p');
      const leftovers = await c.query(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname IN ('telemetry_reading', 'voltlank_migrations')`,
      );
      expect(leftovers.rows).toHaveLength(0);
    } finally {
      await c.end();
    }
  });

  it('replaces the partition function and drops the old one', async () => {
    const c = client();
    await c.connect();
    try {
      const fn = await c.query(
        `SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proname = 'voltlink_ensure_partition'`,
      );
      expect(fn.rows.length).toBeGreaterThanOrEqual(1);
      const old = await c.query(
        `SELECT 1 FROM pg_proc WHERE proname = 'voltlank_ensure_partition'`,
      );
      expect(old.rows).toHaveLength(0);
    } finally {
      await c.end();
    }
  });

  it('creates UTC month partitions at the month boundary', async () => {
    const c = client();
    await c.connect();
    try {
      await c.query(`SELECT voltlink_ensure_partition('2026-10-31T23:59:59.999Z')`);
      await c.query(`SELECT voltlink_ensure_partition('2026-11-01T00:00:00Z')`);
      const insert = await c.query(
        `INSERT INTO telemetry.telemetry_reading (vehicle_id, ts, data)
         VALUES ('v1', '2026-10-31T23:59:59.999Z', '{}'::jsonb), ('v1', '2026-11-01T00:00:00Z', '{}'::jsonb)
         RETURNING tableoid::regclass::text AS part`,
      );
      expect(insert.rows.map((r) => r.part).sort()).toEqual([
        'telemetry.telemetry_2026_10',
        'telemetry.telemetry_2026_11',
      ]);
    } finally {
      await c.end();
    }
  });

  it('handles concurrent partition creation for the same month', async () => {
    const pool = new Pool({ connectionString: dbUrl, max: 10 });
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => pool.query(`SELECT voltlink_ensure_partition('2027-01-15T00:00:00Z')`)),
      );
      for (const r of results) expect(r).toBeDefined();
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = 'telemetry.telemetry_reading'::regclass AND c.relname = 'telemetry_2027_01'`,
      );
      expect(rows[0].n).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it('upgrades an old database without losing rows (expand-then-contract)', async () => {
    // Build a copy of prisma/ containing only the 3 shipped migrations.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voltlink-upgrade-'));
    const oldMigrations = path.join(tmp, 'migrations');
    fs.cpSync(MIGRATIONS_DIR, oldMigrations, { recursive: true });
    for (const name of fs.readdirSync(oldMigrations)) {
      if (name.includes('telemetry_schema_voltlink_rename') || name === '20261030213700_theme_voltlink') {
        fs.rmSync(path.join(oldMigrations, name), { recursive: true, force: true });
      }
    }
    const oldSchema = path.join(tmp, 'schema.prisma');
    fs.copyFileSync(SCHEMA, oldSchema);
    const upgradeUrl = await createDb(upgradeDbName, admin);
    const pre = new Client({ connectionString: upgradeUrl });
    try {
      deploy(oldSchema, upgradeUrl);
      await pre.connect();
      await pre.query(`SELECT voltlank_ensure_partition(now())`);
      await pre.query(
        `INSERT INTO public.telemetry_reading (vehicle_id, ts, data)
         VALUES ('upgrade-1', '2026-10-15T00:00:00Z', '{"k":1}'::jsonb),
                ('upgrade-2', '2026-10-20T00:00:00Z', '{"k":2}'::jsonb)`,
      );
      const before = await pre.query(`SELECT count(*)::int AS n FROM public.telemetry_reading`);
      expect(before.rows[0].n).toBe(2);
      await pre.end();

      deploy(SCHEMA, upgradeUrl);
      const post = new Client({ connectionString: upgradeUrl });
      await post.connect();
      const after = await post.query(`SELECT count(*)::int AS n FROM telemetry.telemetry_reading`);
      expect(after.rows[0].n).toBe(2);
      const inPublic = await post.query(
        `SELECT to_regclass('public.telemetry_reading') IS NOT NULL AS still_public`,
      );
      expect(inPublic.rows[0].still_public).toBe(false); // moved to the telemetry schema
      const themeDefault = await post.query(
        `SELECT column_default FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'theme'`,
      );
      expect(String(themeDefault.rows[0].column_default)).toContain('voltlink-dark');
      await post.end();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

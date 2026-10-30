// Database access: Prisma client plus a pg pool for raw SQL (partitioned
// telemetry, advisory locks, queue).

import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { env } from './env';

export const prisma = new PrismaClient();

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

export interface PgResult {
  rows: unknown[];
  rowCount: number;
}

export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
  const res = await pool.query(text, params as never[]);
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
}

export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    // two-int form: hash the key
    const res = await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    void res;
    return await fn();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
    } catch {
      /* unlock failure during shutdown is harmless */
    }
    client.release();
  }
}

/** Ensure the current-month partition exists for a telemetry timestamp. */
export async function ensureTelemetryPartition(ts: Date): Promise<void> {
  await pool.query('SELECT voltlink_ensure_partition($1)', [ts]);
}

// apps/api/test/unit/migrate-wait.test.ts — R2-21: the web/worker/scheduler
// roles must WAIT on an unreadable migration state (e.g. a fresh database
// without _prisma_migrations) instead of booting on an unmigrated schema.
// A failed migration-state query is 'pending', polled to the 120 s ceiling
// with a clear message.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { MIG_DIR } = vi.hoisted(() => {
  const f = require('node:fs') as typeof import('node:fs');
  const o = require('node:os') as typeof import('node:os');
  const p = require('node:path') as typeof import('node:path');
  return { MIG_DIR: f.mkdtempSync(p.join(o.tmpdir(), 'voltlink-mig-')) };
});

vi.mock('../../src/core/db', () => ({
  pool: {
    query: vi.fn(),
  },
  withAdvisoryLock: vi.fn(),
}));

vi.mock('../../src/core/paths', () => ({
  PATHS: {
    migrations: MIG_DIR,
  },
}));

import { waitForMigrations } from '../../src/cli/migrate';
import { pool } from '../../src/core/db';

const query = vi.mocked(pool.query);

describe('waitForMigrations (R2-21)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    query.mockReset();
    fs.mkdirSync(path.join(MIG_DIR, '20261027120000_initial'), { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const exitNow = () =>
    vi.spyOn(process, 'exit').mockImplementation((((code?: number) => {
      throw new Error(`exit ${code ?? 0}`);
    }) as never));

  it('treats a failed migration-state query as pending and keeps polling to the ceiling', async () => {
    const exit = exitNow();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    query.mockRejectedValue(new Error('relation "_prisma_migrations" does not exist'));
    const p = waitForMigrations(6000);
    await vi.advanceTimersByTimeAsync(3000);
    // Not exited after 3 s — the failed read did not mean 'current'.
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.join(' ')).toContain('could not read migration state');
    // Polled more than once (2 s interval), never exited at once.
    expect(query.mock.calls.length).toBeGreaterThanOrEqual(3);
    exit.mockRestore();
    err.mockRestore();
  });

  it('returns as soon as the state becomes readable and current', async () => {
    const exit = exitNow();
    query.mockRejectedValueOnce(new Error('relation "_prisma_migrations" does not exist'));
    query.mockResolvedValue({ rows: [{ migration_name: '20261027120000_initial' }] });
    const p = waitForMigrations(6000);
    // First failed read schedules the 2 s poll before the retry.
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(exit).not.toHaveBeenCalled();
    expect(query.mock.calls.length).toBe(2);
    exit.mockRestore();
  });

  it('reports the clear 120 s ceiling message for a genuinely pending schema', async () => {
    const exit = exitNow();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    query.mockResolvedValue({ rows: [] });
    const p = waitForMigrations(6000);
    await vi.advanceTimersByTimeAsync(7000);
    await expect(p).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.join(' ')).toContain('migrations not current');
    exit.mockRestore();
    err.mockRestore();
  });
});

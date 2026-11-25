// apps/api/test/unit/migrate-wait.test.ts — R2-21: the web/worker/scheduler
// roles must WAIT on an unreadable migration state (e.g. a fresh database
// without _prisma_migrations) instead of booting on an unmigrated schema.
// A failed migration-state query is 'pending', polled to the 120 s ceiling
// with a clear message.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/db')>();
  // Patch the query method on the REAL pool so connect/end (used by the
  // advisory lock and the api-int worker teardown) stay intact.
  const query = vi.fn() as unknown as typeof actual.pool.query;
  (actual.pool as unknown as { query: typeof query }).query = query;
  return actual;
});

vi.mock('../../src/core/paths', async () => {
  const f = await import('node:fs');
  const o = await import('node:os');
  const p = await import('node:path');
  const dir = f.mkdtempSync(p.join(o.tmpdir(), 'voltlink-mig-'));
  (globalThis as unknown as { __MIG_DIR: string }).__MIG_DIR = dir;
  return {
    PATHS: {
      migrations: dir,
    },
  };
});

import { waitForMigrations } from '../../src/cli/migrate';
import { pool } from '../../src/core/db';

// The paths mock factory created the migrations dir before this module body
// runs (importing cli/migrate pulls the mock in).
const MIG_DIR = (globalThis as unknown as { __MIG_DIR: string }).__MIG_DIR;

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
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code ?? 0}`);
    }) as never);

  it('treats a failed migration-state query as pending and keeps polling to the ceiling', async () => {
    const exit = exitNow();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    query.mockRejectedValue(new Error('relation "_prisma_migrations" does not exist'));
    const p = waitForMigrations(6000);
    // Attach the rejection handler before advancing time so the exit-sentinel
    // rejection is never unhandled.
    const rejection = expect(p).rejects.toThrow('exit 1');
    await vi.advanceTimersByTimeAsync(3000);
    // Not exited after 3 s — the failed read did not mean 'current'.
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    await rejection;
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
    query.mockResolvedValue({ rows: [{ migration_name: '20261027120000_initial' }] } as never);
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
    query.mockResolvedValue({ rows: [] } as never);
    const p = waitForMigrations(6000);
    const rejection = expect(p).rejects.toThrow('exit 1');
    await vi.advanceTimersByTimeAsync(7000);
    await rejection;
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.mock.calls.join(' ')).toContain('migrations not current');
    exit.mockRestore();
    err.mockRestore();
  });
});

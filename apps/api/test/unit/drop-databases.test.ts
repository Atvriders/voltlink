// apps/api/test/unit/drop-databases.test.ts — R2-24 teardown drop loop unit
// tests. The fake admin behaves like Postgres: while an autovacuum backend is
// attached to a fresh template, DROP ... WITH (FORCE) always fails with 42501
// (non-superusers cannot terminate it) and plain DROP DATABASE succeeds after
// the worker exits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dropDatabases, dropOne, validatePrefix, type DbAdmin } from '../setup/drop-databases';

interface FakeState {
  remaining: string[];
  dropped: string[];
  sql: string[];
}

function postgresLike(opts: {
  dbs: string[];
  /** DBs with an attached autovacuum backend: FORCE fails with `code`, plain DROP succeeds. */
  autovacuum: string[];
  /** DBs whose plain DROP keeps failing with `code` until the window closes. */
  plainFails: string[];
  /** DBs whose FORCE drop throws a non-retryable error. */
  nonRetryable: string[];
  code?: string;
}): { client: DbAdmin; state: FakeState } {
  const code = opts.code ?? '42501';
  const state: FakeState = { remaining: [...opts.dbs], dropped: [], sql: [] };
  const client: DbAdmin = {
    query: async (sql: string) => {
      state.sql.push(sql);
      if (sql.trimStart().startsWith('SELECT')) {
        return { rows: state.remaining.map((datname) => ({ datname })) };
      }
      const isForce = sql.includes('WITH (FORCE)');
      const name = /"(voltlink_test_[^"]+)"/.exec(sql)?.[1] ?? '';
      if (isForce && opts.autovacuum.includes(name)) {
        throw { code, message: 'permission denied to terminate process' };
      }
      if (isForce && opts.nonRetryable.includes(name)) {
        throw { code: '55000', message: 'database is being accessed by other users' };
      }
      if (!isForce && opts.plainFails.includes(name)) {
        throw { code, message: 'permission denied to terminate process' };
      }
      state.remaining = state.remaining.filter((d) => d !== name);
      state.dropped.push(name);
      return { rows: [] };
    },
  };
  return { client, state };
}

beforeEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

afterEach(() => {
  process.exitCode = undefined;
});

describe('validatePrefix (R2-24)', () => {
  it('accepts a per-run prefix', () => {
    expect(() => validatePrefix('voltlink_test_1_abcdef12_')).not.toThrow();
  });

  it('rejects an empty prefix (LIKE % would match every database)', () => {
    expect(() => validatePrefix('')).toThrow(/VL_TEST_DB_PREFIX/);
  });

  it('rejects the bare voltlink_test_ (would drop every other run)', () => {
    expect(() => validatePrefix('voltlink_test_')).toThrow(/VL_TEST_DB_PREFIX/);
  });

  it('rejects a prefix without the trailing underscore', () => {
    expect(() => validatePrefix('voltlink_test_1_abcdef12')).toThrow(/VL_TEST_DB_PREFIX/);
  });
});

describe('dropDatabases (R2-24)', () => {
  it('retries a 42501 FORCE failure with a plain DROP (no FORCE) and leaves nothing', async () => {
    const { client, state } = postgresLike({
      dbs: ['voltlink_test_1_aaaa_template', 'voltlink_test_1_aaaa_w1', 'voltlink_test_1_aaaa_w2'],
      autovacuum: ['voltlink_test_1_aaaa_template'],
      plainFails: [],
      nonRetryable: [],
    });
    const res = await dropDatabases(client, 'voltlink_test_1_aaaa_', {
      retryMs: 5_000,
      pollMs: 5,
    });
    expect(res.remaining).toEqual([]);
    expect(res.dropped).toHaveLength(3);
    expect(state.remaining).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    // The template's first attempt is the FORCE drop; every later statement
    // must be the plain DROP — a retry that keeps WITH (FORCE) never succeeds
    // while the autovacuum backend is attached.
    const templateSql = state.sql.filter((s) => s.includes('voltlink_test_1_aaaa_template'));
    expect(templateSql[0]).toContain('WITH (FORCE)');
    for (const stmt of templateSql.slice(1)) {
      expect(stmt).not.toContain('WITH (FORCE)');
      expect(stmt).toContain('DROP DATABASE IF EXISTS');
    }
  });

  it('retries a 55006 FORCE failure with a plain DROP', async () => {
    const { client, state } = postgresLike({
      dbs: ['voltlink_test_5_eeee_template'],
      autovacuum: ['voltlink_test_5_eeee_template'],
      plainFails: [],
      nonRetryable: [],
      code: '55006',
    });
    const res = await dropDatabases(client, 'voltlink_test_5_eeee_', { retryMs: 1_000, pollMs: 5 });
    expect(res.remaining).toEqual([]);
    expect(res.dropped).toEqual(['voltlink_test_5_eeee_template']);
    expect(state.sql.filter((s) => s.includes('WITH (FORCE)'))).toHaveLength(1);
  });

  it('names the leftovers and sets a non-zero exit when the plain DROP never clears', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = postgresLike({
      dbs: ['voltlink_test_2_bbbb_template', 'voltlink_test_2_bbbb_w1'],
      autovacuum: ['voltlink_test_2_bbbb_template', 'voltlink_test_2_bbbb_w1'],
      plainFails: ['voltlink_test_2_bbbb_template', 'voltlink_test_2_bbbb_w1'],
      nonRetryable: [],
    });
    let thrown: unknown = null;
    try {
      await dropDatabases(client, 'voltlink_test_2_bbbb_', { retryMs: 80, pollMs: 5 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).toContain('voltlink_test_2_bbbb_template');
    expect(String((thrown as Error).message)).toContain('voltlink_test_2_bbbb_w1');
    expect(process.exitCode).toBe(1);
    // The printed line names zero drops; the error line names both leftovers.
    const logs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logs).toContain('[test-db] prefix voltlink_test_2_bbbb_: dropped 0 database(s)');
    const errs = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errs).toContain(
      'could NOT drop: "voltlink_test_2_bbbb_template", "voltlink_test_2_bbbb_w1"',
    );
  });

  it('carries on with the other databases when one drop throws a non-retryable error', async () => {
    const { client, state } = postgresLike({
      dbs: ['voltlink_test_3_cccc_template', 'voltlink_test_3_cccc_w1'],
      autovacuum: [],
      plainFails: [],
      nonRetryable: ['voltlink_test_3_cccc_template'],
    });
    let thrown: unknown = null;
    try {
      await dropDatabases(client, 'voltlink_test_3_cccc_');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(process.exitCode).toBe(1);
    // w1 WAS dropped; only the template is left and named.
    expect(state.dropped).toContain('voltlink_test_3_cccc_w1');
    expect(state.remaining).toEqual(['voltlink_test_3_cccc_template']);
    expect(String((thrown as Error).message)).toContain('voltlink_test_3_cccc_template');
  });
});

describe('dropOne (R2-24)', () => {
  it('returns false for a non-retryable failure', async () => {
    const { client, state } = postgresLike({
      dbs: ['voltlink_test_4_dddd_w1'],
      autovacuum: [],
      plainFails: [],
      nonRetryable: ['voltlink_test_4_dddd_w1'],
    });
    const ok = await dropOne(client, 'voltlink_test_4_dddd_w1', { retryMs: 50, pollMs: 5 });
    expect(ok).toBe(false);
    expect(state.remaining).toEqual(['voltlink_test_4_dddd_w1']);
  });

  it('returns true once the plain DROP succeeds', async () => {
    const { client } = postgresLike({
      dbs: ['voltlink_test_4_dddd_w1'],
      autovacuum: ['voltlink_test_4_dddd_w1'],
      plainFails: [],
      nonRetryable: [],
    });
    const ok = await dropOne(client, 'voltlink_test_4_dddd_w1', { retryMs: 1_000, pollMs: 5 });
    expect(ok).toBe(true);
  });
});

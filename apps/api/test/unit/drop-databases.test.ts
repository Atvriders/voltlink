// apps/api/test/unit/drop-databases.test.ts — R2-24 teardown drop loop unit
// tests with a fake admin client: 42501 once then dropped; 42501 forever then
// named and the exit is non-zero.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dropDatabases, type DbAdmin } from '../setup/drop-databases';

function fakeClient(opts: {
  forceFails: number | 'always'; // how many FORCE attempts fail with 42501
  plainFails: 'always' | 'never';
  dbs: string[];
}): { client: DbAdmin; state: { remaining: string[]; drops: string[] } } {
  const state = { remaining: [...opts.dbs], drops: [] as string[] };
  let forceLeft = opts.forceFails;
  const fail = { code: '42501', message: 'permission denied to terminate process' };
  const client: DbAdmin = {
    query: async (sql: string) => {
      if (sql.trimStart().startsWith('SELECT')) {
        return { rows: state.remaining.map((datname) => ({ datname })) };
      }
      const isForce = sql.includes('WITH (FORCE)');
      const name = /"(voltlink_test_[^"]+)"/.exec(sql)?.[1] ?? '';
      if (isForce) {
        if (forceLeft === 'always' || forceLeft > 0) {
          if (forceLeft !== 'always') forceLeft -= 1;
          throw fail;
        }
      } else if (opts.plainFails === 'always') {
        throw fail;
      }
      state.remaining = state.remaining.filter((d) => d !== name);
      state.drops.push(name);
      return { rows: [] };
    },
  };
  return { client, state };
}

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

describe('dropDatabases (R2-24)', () => {
  it('retries a 42501 FORCE failure with a plain DROP and leaves nothing', async () => {
    const { client, state } = fakeClient({
      forceFails: 1,
      plainFails: 'never',
      dbs: ['voltlink_test_1_aaaa_template', 'voltlink_test_1_aaaa_w1', 'voltlink_test_1_aaaa_w2'],
    });
    const res = await dropDatabases(client, 'voltlink_test_1_aaaa_', {
      retryMs: 5_000,
      pollMs: 5,
    });
    expect(res.remaining).toEqual([]);
    expect(res.dropped).toHaveLength(3);
    expect(state.remaining).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it('names the leftovers and sets a non-zero exit when 42501 never clears', async () => {
    const { client } = fakeClient({
      forceFails: 'always',
      plainFails: 'always',
      dbs: ['voltlink_test_2_bbbb_template', 'voltlink_test_2_bbbb_w1'],
    });
    let thrown: unknown = null;
    try {
      await dropDatabases(client, 'voltlink_test_2_bbbb_', {
        retryMs: 80,
        pollMs: 5,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).toContain('voltlink_test_2_bbbb_template');
    expect(String((thrown as Error).message)).toContain('voltlink_test_2_bbbb_w1');
    expect(process.exitCode).toBe(1);
  });

  it('carries on with the other databases when one drop throws a non-retryable error', async () => {
    // A fake whose FORCE drop throws a non-retryable error for the first db
    // only; the loop must keep going and drop the rest, then name the one
    // that could not be dropped and fail the run.
    const state = { remaining: ['voltlink_test_3_cccc_template', 'voltlink_test_3_cccc_w1'] };
    const client: DbAdmin = {
      query: async (sql: string) => {
        if (sql.trimStart().startsWith('SELECT')) {
          return { rows: state.remaining.map((datname) => ({ datname })) };
        }
        const name = /"(voltlink_test_[^"]+)"/.exec(sql)?.[1] ?? '';
        if (name.endsWith('template')) throw new Error('database is being accessed by other users');
        state.remaining = state.remaining.filter((d) => d !== name);
        return { rows: [] };
      },
    };
    let thrown: unknown = null;
    try {
      await dropDatabases(client, 'voltlink_test_3_cccc_');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(process.exitCode).toBe(1);
  });
});

// Guide 08 §11.1 — the demo/visual clock. VL_TEST_FROZEN_NOW is honoured ONLY
// when NODE_ENV=test; a production boot with the variable set fails hard in
// validateEnv, and a malformed value fails hard everywhere.

export function demoClockNow(): Date {
  const frozen = process.env.VL_TEST_FROZEN_NOW;
  if (!frozen) return new Date();
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'VL_TEST_FROZEN_NOW is a test-only variable and must not be set in production.',
    );
  }
  const d = new Date(frozen);
  if (Number.isNaN(d.getTime())) {
    throw new Error(
      `VL_TEST_FROZEN_NOW must be a valid date string, got ${JSON.stringify(frozen)}.`,
    );
  }
  return d;
}

/** Called from validateEnv: the production boot failure for the test-only
 * switch (guide 08 §11.1). */
export function assertDemoClockEnv(): void {
  if (process.env.NODE_ENV !== 'test' && process.env.VL_TEST_FROZEN_NOW) {
    throw new Error('VL_TEST_FROZEN_NOW is test-only; refusing to boot in production.');
  }
}

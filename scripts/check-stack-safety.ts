// check-stack-safety.ts — R2-24 gate: shared-machine safety of the test
// harness and the e2e stack scripts. Fails (exit 1) when any tracked file
// regresses to the round-1 behaviour:
//
//   - the api-int harness drops every voltlink_test_% database, rewrites the
//     caller's Redis index, or uses a fixed advisory lock
//   - start-stack.sh / simulate-image.sh bind 0.0.0.0, let an explicit empty
//     VL_SETUP_TOKEN be replaced, accept a foreign process's health endpoint,
//     or build uncapped Postgres pools
//   - fake-smtp.mjs / fake-tesla-server.ts use hard-coded ports or a shared
//     /tmp URL file
//
//   npm run check:stack-safety [root]   (root defaults to process.cwd())
//
// Usage in verification trees: run THIS script from the repo root against an
// old tree, e.g.  tsx scripts/check-stack-safety.ts $REL2/ab44e55

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface StackSafetyFinding {
  file: string;
  why: string;
}

type Assertion = (text: string, file: string) => StackSafetyFinding[];

const requireMatch =
  (pattern: RegExp, why: string): Assertion =>
  (text, file) => {
    if (pattern.test(text)) return [];
    return [{ file, why }];
  };

const forbidMatch =
  (pattern: RegExp, why: string): Assertion =>
  (text, file) => {
    const m = text.match(pattern);
    if (m) return [{ file, why: `${why} (line ${lineOf(text, m.index ?? 0)})` }];
    return [];
  };

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

const CHECKS: Record<string, Assertion[]> = {
  'apps/api/test/setup/global-db.ts': [
    requireMatch(/VL_TEST_DB_PREFIX/, 'must read the per-run prefix VL_TEST_DB_PREFIX'),
    requireMatch(
      /VL_TEST_DB_PREFIX \?\?[\s\S]{0,120}process\.pid/,
      'the DEFAULT prefix must be unique per run (pid + random)',
    ),
    requireMatch(/randomBytes/, 'the default prefix must include randomness'),
    requireMatch(
      /`\$\{PREFIX\}template`|PREFIX\}template/,
      'template name must come from the prefix',
    ),
    requireMatch(/connection_limit/, 'template/admin URLs must cap connection_limit'),
    forbidMatch(
      /LIKE 'voltlink\\\\_test\\\\_%'/,
      'teardown must not drop every voltlink_test_% database',
    ),
    requireMatch(
      /dropDatabases\(/,
      'teardown must route the drops through the shared dropDatabases loop',
    ),
    requireMatch(/validatePrefix\(/, 'the prefix must be validated before any SQL runs'),
  ],
  'apps/api/test/setup/drop-databases.ts': [
    requireMatch(
      /validatePrefix\(/,
      'must validate the prefix before any SQL (reject empty and bare voltlink_test_)',
    ),
    requireMatch(
      /prefix\.replace\(\/\[\\\\_%\]\/g/,
      'teardown LIKE must escape the prefix wildcards',
    ),
    requireMatch(/new Set\(\['42501'/, 'RETRYABLE must include 42501'),
    requireMatch(/55006/, 'RETRYABLE must include 55006'),
    requireMatch(
      /const plain = `DROP DATABASE IF EXISTS "\$\{name\}"`/,
      'must retry 42501/55006 with a plain DROP (no FORCE)',
    ),
    requireMatch(
      /process\.exitCode = 1/,
      'leftovers or a failed listing must set a non-zero exit code',
    ),
  ],
  'apps/api/vitest.config.ts': [
    requireMatch(
      /the worker cap lives on the api-int PROJECT/,
      'the shared api config must document that the cap lives on api-int',
    ),
  ],
  'vitest.config.mts': [
    requireMatch(
      /VL_TEST_MAX_WORKERS \?\? 2/,
      'the api-int project must cap workers (VL_TEST_MAX_WORKERS, default 2)',
    ),
  ],
  'apps/api/test/setup/worker-db.ts': [
    requireMatch(
      /inject\('dbPrefix'\)/,
      'worker DB name must come from the injected per-run prefix',
    ),
    requireMatch(/dropOne\(/, 'worker DB drop must route through the shared drop loop'),
    forbidMatch(
      /VL_TEST_DB_PREFIX \?\? 'voltlink_test_'/,
      'must not fall back to the shared voltlink_test_ default',
    ),
    forbidMatch(/% 16/, 'must not rewrite the Redis index to POOL_ID % 16'),
    requireMatch(/VL_REDIS_INDEX/, 'Redis index override must be opt-in via VL_REDIS_INDEX'),
    requireMatch(/VL_QUEUE_PREFIX/, 'must set a per-fork queue prefix'),
    forbidMatch(
      /pg_advisory_lock\(\d+\)/,
      'advisory lock must be keyed by the prefix, not a fixed number',
    ),
    requireMatch(/connection_limit/, 'worker DATABASE_URL must cap connection_limit'),
  ],
  'scripts/e2e/start-stack.sh': [
    requireMatch(/export HOST="\$\{HOST:-127\.0\.0\.1\}"/, 'must bind 127.0.0.1 by default'),
    requireMatch(
      /VL_SETUP_TOKEN-e2e-local-setup-token/,
      'explicit empty VL_SETUP_TOKEN must stay empty (single hyphen)',
    ),
    requireMatch(/kill -0 "\$\{?SMTP_PID\}?/, 'SMTP readiness must check its own PID'),
    requireMatch(/kill -0 "\$\{?API_PID\}?/, 'API readiness must check its own PID'),
    requireMatch(/connection_limit/, 'DATABASE_URL must be capped with connection_limit'),
    requireMatch(/SMTP_PORT="\$\{SMTP_PORT:-/, 'SMTP port must be configurable'),
    forbidMatch(/smtp:\/\/127\.0\.0\.1:1025/, 'SMTP port must not be hard-coded'),
    forbidMatch(/:1026"/, 'SMTP HTTP port must not be hard-coded'),
  ],
  'scripts/e2e/fake-smtp.mjs': [
    requireMatch(/SMTP_PORT = Number\(process\.env\.SMTP_PORT/, 'SMTP port must come from env'),
    requireMatch(
      /HTTP_PORT = Number\(process\.env\.VL_SMTP_HTTP_PORT/,
      'HTTP port must come from env',
    ),
    forbidMatch(/listen\(1025,/, 'must not hard-code port 1025'),
    forbidMatch(/listen\(1026,/, 'must not hard-code port 1026'),
  ],
  'scripts/e2e/fake-tesla-server.ts': [
    forbidMatch(/'\/tmp\/fake-tesla\.url'/, 'URL file must not be the shared /tmp/fake-tesla.url'),
    requireMatch(/FAKE_TESLA_URL_FILE/, 'URL file path must come from FAKE_TESLA_URL_FILE'),
  ],
  'scripts/e2e/tesla-e2e.sh': [
    forbidMatch(/\/tmp\/fake-tesla\.url/, 'must use the per-run URL file'),
    forbidMatch(
      /:3111\/api\/v1\/providers\/tesla\/callback/,
      'redirect port must not be hard-coded to 3111',
    ),
    requireMatch(/PORT:-\d+\}/, 'redirect URI must use the configured PORT'),
  ],
  'scripts/simulate-image.sh': [
    requireMatch(/HOST=127\.0\.0\.1/, 'must bind 127.0.0.1'),
    requireMatch(/connection_limit=5/, 'DATABASE_URL must cap connection_limit'),
  ],
};

export function checkStackSafety(root = process.cwd()): StackSafetyFinding[] {
  const findings: StackSafetyFinding[] = [];
  for (const [rel, assertions] of Object.entries(CHECKS)) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
      findings.push({ file: rel, why: 'file missing' });
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    for (const assertion of assertions) findings.push(...assertion(text, rel));
  }
  // Syntax-check every shell script the gate covers.
  for (const rel of [
    'scripts/e2e/start-stack.sh',
    'scripts/e2e/tesla-e2e.sh',
    'scripts/simulate-image.sh',
  ]) {
    try {
      execFileSync('bash', ['-n', path.join(root, rel)], { stdio: 'pipe' });
    } catch {
      findings.push({ file: rel, why: 'bash -n syntax check failed' });
    }
  }
  return findings;
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)
) {
  const root = process.argv[2] ?? process.cwd();
  const findings = checkStackSafety(root);
  if (findings.length > 0) {
    console.error(`check-stack-safety: ${findings.length} violation(s) in ${root}:`);
    for (const f of findings) console.error(`  ${f.file}: ${f.why}`);
    process.exit(1);
  }
  console.log(`check-stack-safety: clean (${Object.keys(CHECKS).length} files checked)`);
}

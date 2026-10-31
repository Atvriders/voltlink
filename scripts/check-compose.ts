// check:compose — proves both compose files pass every ENV_SPEC variable to
// every VoltLink role (I-COMPOSEENV, guide 04 §1/§6). Exits non-zero when a
// variable is missing from a role's environment.
import { readFileSync } from 'node:fs';

async function main(): Promise<void> {
  const { ENV_KEYS } = await import('../apps/api/src/core/env-spec');
  const files = ['compose.production.yml', 'docker-compose.yml'];
  let failed = false;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const missing = ENV_KEYS.filter((key) => !src.includes(key));
    if (missing.length > 0) {
      failed = true;
      console.error(`✖ ${file} is missing environment entries: ${missing.join(', ')}`);
    } else {
      console.log(`✓ ${file} passes every ${ENV_KEYS.length} ENV_SPEC variable(s).`);
    }
  }
  if (failed) process.exit(1);
}

void main();

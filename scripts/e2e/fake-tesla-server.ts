// Boots the fake Tesla Fleet API + proxy for e2e runs. Writes its URL to
// $FAKE_TESLA_URL_FILE (default scripts/e2e/run/fake-tesla.url, per run) and
// stays up until killed.
import { startFakeTesla } from '../../apps/api/test/fakes/fakeTesla';

async function main() {
  const fake = await startFakeTesla(0);
  const fs = await import('node:fs');
  const out =
    process.env.FAKE_TESLA_URL_FILE ?? new URL('./run/fake-tesla.url', import.meta.url).pathname;
  fs.writeFileSync(out, fake.base);
  console.log(`FAKE_TESLA_BASE=${fake.base}`);
  console.log(`FAKE_TESLA_PROXY=${fake.proxy}`);
  console.log(`FAKE_TESLA_URL_FILE=${out}`);
  process.on('SIGTERM', () => void fake.close().then(() => process.exit(0)));
  process.on('SIGINT', () => void fake.close().then(() => process.exit(0)));
}

void main();

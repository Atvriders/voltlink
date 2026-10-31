// Boots the fake Tesla Fleet API + proxy for e2e runs. Writes its URL to
// /tmp/fake-tesla.url and stays up until killed.
import { startFakeTesla } from '../../apps/api/test/fakes/fakeTesla';

async function main() {
  const fake = await startFakeTesla(0);
  const fs = await import('node:fs');
  fs.writeFileSync('/tmp/fake-tesla.url', fake.base);
  console.log(`FAKE_TESLA_BASE=${fake.base}`);
  console.log(`FAKE_TESLA_PROXY=${fake.proxy}`);
  process.on('SIGTERM', () => void fake.close().then(() => process.exit(0)));
  process.on('SIGINT', () => void fake.close().then(() => process.exit(0)));
}

void main();

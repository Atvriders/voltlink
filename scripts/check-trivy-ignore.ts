// Rejects expired .trivyignore.yaml entries so ignores cannot rot silently
// (no YAML dependency: the file format is ours).
import { readFileSync } from 'node:fs';

const src = readFileSync('.trivyignore.yaml', 'utf8');
const entries = [...src.matchAll(/- id:\s*(\S+)\n(?:[^\n]*\n)*?\s+expired_at:\s*(\S+)/g)];
const now = Date.now();
let failed = false;
for (const m of entries) {
  const [, id, expiry] = m;
  if (new Date(expiry!).getTime() < now) {
    console.error(`✖ .trivyignore.yaml entry ${id} expired ${expiry}; remove or renew it.`);
    failed = true;
  }
}
if (entries.length === 0) console.log('✓ .trivyignore.yaml has no expiry-based entries.');
else console.log(`✓ .trivyignore.yaml: ${entries.length} entry/entries unexpired.`);
if (failed) process.exit(1);

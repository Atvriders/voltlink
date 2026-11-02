// Personal-data scanner (PA-39, guide 08 §16.5): flags real-looking
// personal data in tracked text files. Everything committed must be fictional:
// RFC 5737 / example-domain addresses, the Rivermark demo world, 555-01xx
// phone numbers. Hard-fails on: emails outside the allowed test domains,
// phone numbers outside 555-01xx, and 17-character VIN-like strings. Reports
// (as warnings) coordinates outside the demo bounding box and private-range
// IPs other than RFC 5737 documentation ranges.
//
//   npx tsx scripts/scan-personal-data.ts

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED_EMAIL_DOMAINS = [
  'voltlink.test',
  'example.test',
  'example.invalid',
  'example.com',
  'example.org',
  'voltlink-e2e.test',
  'voltlink.local', // infrastructure-only sender addresses
  'legacy.test', // tenancy test fixture
];

// Files whose private-range addresses exist on purpose (SSRF policy, its tests,
// env documentation). Warnings only, never hard failures.
const PRIVATE_IP_ALLOW_FILES = new Set([
  'apps/api/src/net/outboundPolicy.ts',
  'apps/api/src/core/env.ts',
  'apps/api/test/ssrf.test.ts',
  'apps/api/test/phase2-security.test.ts',
  '.env.example',
]);

// npm registry metadata in the lockfile carries maintainer emails.
const EMAIL_SKIP_FILES = new Set(['package-lock.json']);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\b(\+?1[-. ]?)?\(?([2-9]\d{2})\)?[-. ]?(\d{3})[-. ]?(\d{4})\b/g;
const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
const COORD_RE =
  /(?:lat|latitude)\s*[:=]\s*(-?\d{1,3}\.\d{3,})|(-?\d{1,3}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/g;
const PRIVATE_IP_RE =
  /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;

// Fictional demo world (Rivermark, CO): lat 38.8-39.4, lon -104.9..-104.2.
const BOX = { latMin: 38.8, latMax: 39.4, lonMin: -104.9, lonMax: -104.2 };
// RFC 5737 documentation ranges are fine.
const RFC5737 = /\b(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)\d{1,3}\b/g;

interface Finding {
  file: string;
  kind: string;
  value: string;
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

export function scanPersonalData(root = ROOT): Finding[] {
  const findings: Finding[] = [];
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  for (const rel of files) {
    const full = path.join(root, rel);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(full);
    } catch {
      continue;
    }
    if (isBinary(buf)) continue;
    const text = buf.toString('utf8');
    if (EMAIL_SKIP_FILES.has(rel)) {
      continue;
    }
    for (const m of text.matchAll(EMAIL_RE)) {
      const email = m[0];
      const domain = email.split('@')[1]!;
      if (!ALLOWED_EMAIL_DOMAINS.includes(domain.toLowerCase()))
        findings.push({ file: rel, kind: 'email', value: email });
    }
    for (const m of text.matchAll(PHONE_RE)) {
      const digits = (m[2] ?? '') + (m[3] ?? '') + (m[4] ?? '');
      const area = digits.slice(0, 3);
      const exchange = digits.slice(3, 6);
      if (area !== '555' || !exchange.startsWith('01'))
        findings.push({ file: rel, kind: 'phone', value: m[0] });
    }
    for (const m of text.matchAll(VIN_RE)) {
      const vin = m[0];
      // Fictional test-VIN conventions: repeated single characters and the
      // NEXUS series used by the Tesla/Tessie fakes.
      if (/^(.)\1{16}$/.test(vin)) continue;
      if (/NEXUS\d{2}$/.test(vin)) continue;
      findings.push({ file: rel, kind: 'vin', value: vin });
    }
    const sanitized = text.replace(RFC5737, '');
    if (!PRIVATE_IP_ALLOW_FILES.has(rel)) {
      for (const m of sanitized.matchAll(PRIVATE_IP_RE)) {
        findings.push({ file: rel, kind: 'private-ip', value: m[0] });
      }
    }
    for (const m of text.matchAll(COORD_RE)) {
      if (m[1]) {
        // "lat: X" form
        const lat = parseFloat(m[1]);
        if (!isNaN(lat) && (lat < BOX.latMin || lat > BOX.latMax)) {
          findings.push({ file: rel, kind: 'coord', value: m[0].slice(0, 60) });
        }
        continue;
      }
      // "X, Y" form: either (lat, lon) or (lon, lat); check both orders.
      const a = parseFloat(m[2] ?? 'NaN');
      const b = parseFloat(m[3] ?? 'NaN');
      if (isNaN(a) || isNaN(b)) continue;
      const latFirst = a >= -90 && a <= 90 && b >= -180 && b <= 180;
      const lat = latFirst ? a : b;
      const lon = latFirst ? b : a;
      if (lat < BOX.latMin || lat > BOX.latMax || lon < BOX.lonMin || lon > BOX.lonMax) {
        findings.push({ file: rel, kind: 'coord', value: m[0].slice(0, 60) });
      }
    }
  }
  return findings;
}

if (
  process.argv[1]?.endsWith('scan-personal-data.ts') ||
  process.argv[1]?.endsWith('scan-personal-data.js')
) {
  const findings = scanPersonalData();
  const hard = findings.filter((f) => f.kind !== 'coord' && f.kind !== 'private-ip');
  for (const f of findings) console.log(`  ${f.file}: ${f.kind} "${f.value}"`);
  console.log(
    `scan-personal-data: ${findings.length} findings (${hard.length} hard, ${findings.length - hard.length} warnings)`,
  );
  process.exit(hard.length > 0 ? 1 : 0);
}

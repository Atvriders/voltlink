// Naming gate: the product is VoltLink and every technical identifier is
// `voltlink`. Fails when the old misspelling appears in any tracked file
// outside an explicit allowlist (the historical initial migration, the rename
// migration that drops the old objects, and the CHANGELOG entry that records
// the rename).
//
//   npm run naming:scan
//
// The scanner's own pattern is built from parts so this file itself never
// contains the literal term it scans for.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Pattern built from parts on purpose: do not write the literal here.
const TERM = 'volt' + 'lank';
const PATTERN = new RegExp(TERM, 'i');

const ALLOWED_PREFIXES = [
  // Historical migrations: the initial one created the old-named objects and
  // the rename migration drops them. Never edited.
  'apps/api/prisma/migrations/20261027120000_initial/',
  'apps/api/prisma/migrations/20261030213636_telemetry_schema_voltlink_rename/',
  // The CHANGELOG entry that records the rename may spell the old name.
  'CHANGELOG.md',
  // The tenancy/upgrade tests apply this fixture to databases that still run
  // the pre-rename schema (the rename migration is deliberately not applied),
  // so the fixture must call the old-named partition function.
  'apps/api/test/fixtures/legacy-seed.sql',
];

export interface NamingFinding {
  file: string;
  line: number;
  text: string;
}

export function scanNaming(root = process.cwd()): NamingFinding[] {
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  const findings: NamingFinding[] = [];
  for (const rel of files) {
    if (ALLOWED_PREFIXES.some((p) => rel === p || rel.startsWith(p))) continue;
    const full = path.join(root, rel);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(full);
    } catch {
      continue; // file listed by git but gone from disk (e.g. mid-rename); git status catches it
    }
    // Skip binary files: a NUL byte in the first 8 KiB means it is not text.
    if (buf.subarray(0, 8192).includes(0)) continue;
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (PATTERN.test(line)) {
        findings.push({ file: rel, line: i + 1, text: line.trim() });
      }
    });
  }
  return findings;
}

if (process.argv[1]?.endsWith('naming-scan.ts') || process.argv[1]?.endsWith('naming-scan.js')) {
  const findings = scanNaming();
  if (findings.length > 0) {
    console.error(`Old name found outside the allowlist (${findings.length}):`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}: ${f.text.slice(0, 120)}`);
    process.exit(1);
  }
  console.log('OK: no old-name content found outside the allowlist.');
}

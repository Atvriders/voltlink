// Legacy-content scanner: VoltLink must contain no leftover content from the
// project the monorepo skeleton was imported from (ham-radio net logging).
//
//   npm run legacy:scan
//
// Reads every `git ls-files` text file (no extension filter: Dockerfile,
// .gitignore, .env.example and LICENSEs are scanned too - C-LEGACY). Binary
// files are skipped by content (a NUL byte in the first 8 KiB). Terms are
// separator-tolerant so net_control / net-control / NET_CONTROL all match.
//
//   npx tsx scripts/legacy-scan.ts --self-test   # planted terms must be found

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LEGACY_TERMS = [
  'ham-net-assistant',
  'netlog',
  'callbook',
  'ham radio',
  'ham-radio',
  'amateur radio',
  'amateur-radio',
  'hamclock',
  'dxpedition',
  'netlogger',
  'arrl',
  'qrz',
];

// Separator-tolerant patterns (spaces, underscores and hyphens all match).
const LEGACY_PATTERNS = [
  /net[ _-]?control/i,
  /call[ _-]?signs?/i,
  /\bhna\b/i,
  /ham\.db/i,
  /club\b/i,
  /college\b/i,
  /club call/i,
];

const ALLOWED = [
  'docs/FOUNDATION_AUDIT.md',
  'docs/ARCHITECTURE_DECISIONS.md',
  'package-lock.json',
  'scripts/legacy-scan.ts', // the term list itself
];

export interface LegacyFinding {
  file: string;
  term: string;
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

export function matchLegacyTerms(text: string): string | undefined {
  const pattern = new RegExp(
    LEGACY_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'i',
  );
  const literal = text.match(pattern);
  if (literal) return literal[0];
  for (const re of LEGACY_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return undefined;
}

export function scanLegacyContent(root = process.cwd()): LegacyFinding[] {
  const findings: LegacyFinding[] = [];
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  for (const rel of files) {
    if (ALLOWED.includes(rel)) continue;
    const full = path.join(root, rel);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(full);
    } catch {
      continue; // listed by git but gone from disk; git status catches it
    }
    if (isBinary(buf)) continue;
    const text = buf.toString('utf8');
    const term = matchLegacyTerms(text);
    if (term) findings.push({ file: rel, term });
  }
  return findings;
}

function selfTest(): void {
  // The matcher itself is the unit under test; scanning needs a git tree.
  const planted = [
    'NET_CONTROL row in a table',
    'a call-sign here',
    'uses @hna workspace',
    'DATABASE_URL=file:/data/ham.db',
    'a club app and a college name',
  ];
  for (const text of planted) {
    const hit = matchLegacyTerms(text);
    if (!hit) {
      console.error(`self-test FAILED: planted term not detected in: ${text}`);
      process.exit(1);
    }
    console.log(`self-test: detected "${hit}" in planted sample`);
  }
  if (matchLegacyTerms('no leftovers here at all')) {
    console.error('self-test FAILED: false positive on clean text');
    process.exit(1);
  }
  console.log('self-test OK: planted terms detected, clean text ignored');
}

if (process.argv[1]?.endsWith('legacy-scan.ts') || process.argv[1]?.endsWith('legacy-scan.js')) {
  if (process.argv.includes('--self-test')) selfTest();
  const findings = scanLegacyContent();
  if (findings.length > 0) {
    console.error('Legacy content found outside the allowlist:');
    for (const f of findings) console.error(`  ${f.file}: "${f.term}"`);
    process.exit(1);
  }
  console.log('OK: no legacy content found.');
}

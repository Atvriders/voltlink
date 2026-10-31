// Legacy-content scanner: VoltLink must contain no leftover content from the
// project the monorepo skeleton was imported from (ham-radio net logging).
//
//   npm run legacy:scan
//
// Fails when any legacy domain term appears in a tracked text file outside
// the allowlisted historical documents and migration history.

import fs from 'node:fs';
import path from 'node:path';

const LEGACY_TERMS = [
  'ham-net-assistant',
  'netlog',
  'callsign',
  'callbook',
  'ham radio',
  'ham-radio',
  'amateur radio',
  'amateur-radio',
  'hamclock',
  'dxpedition',
  'net control',
  'club call',
  'netlogger',
  'arrl',
  'qrz',
];

const ALLOWED = [
  'docs/FOUNDATION_AUDIT.md',
  'docs/ARCHITECTURE_DECISIONS.md',
  'package-lock.json',
  'scripts/legacy-scan.ts', // the term list itself
];

const SCAN_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.sql',
  '.prisma',
  '.yml',
  '.yaml',
  '.html',
  '.css',
  '.sh',
  '.py',
  '.env.example',
]);

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'test-results',
  'playwright-report',
  'web-dist',
  '.blend',
]);

export interface LegacyFinding {
  file: string;
  term: string;
}

export function scanLegacyContent(root = process.cwd()): LegacyFinding[] {
  const findings: LegacyFinding[] = [];
  const pattern = new RegExp(
    LEGACY_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'i',
  );

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (ALLOWED.includes(rel)) continue;
      if (!SCAN_EXTS.has(path.extname(entry.name))) continue;
      const text = fs.readFileSync(full, 'utf8');
      const match = text.match(pattern);
      if (match) {
        findings.push({ file: rel, term: match[0] });
      }
    }
  };

  walk(root);
  return findings;
}

if (process.argv[1]?.endsWith('legacy-scan.ts') || process.argv[1]?.endsWith('legacy-scan.js')) {
  const findings = scanLegacyContent();
  if (findings.length > 0) {
    console.error('Legacy content found outside the allowlist:');
    for (const f of findings) console.error(`  ${f.file}: "${f.term}"`);
    process.exit(1);
  }
  console.log('OK: no legacy content found.');
}

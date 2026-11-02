// Completion matrix generator and verifier (C-COMPLETION, gate 11).
//
//   npx tsx scripts/completion-check.ts           # verify (exit 1 on problems)
//   npx tsx scripts/completion-check.ts --write   # regenerate COMPLETION.md
//
// COMPLETION.md is generated from docs/completion/features.json plus the
// append-only evidence ledger (docs/evidence/ledger.jsonl, guide 08 §16). Every
// cell that is not "-" or "n/a" cites a ledger ID, and the checker re-verifies
// that each cited entry passes and belongs to history. Hand-edited cells and
// stale commits fail the check; run --write to fix.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEATURES_PATH = path.join(ROOT, 'docs/completion/features.json');
const LEDGER_PATH = path.join(ROOT, 'docs/evidence/ledger.jsonl');
const OUT_PATH = path.join(ROOT, 'COMPLETION.md');

interface LedgerRow {
  id: string;
  at: string;
  commit: string;
  dirty: boolean;
  feature: string;
  level: string;
  claim: string;
  command: string;
  exit: number;
  log: string | null;
  sha256: string | null;
  ci: string | null;
  result: 'pass' | 'fail' | 'blocked' | 'manual-pass';
}

interface Feature {
  id: string;
  name: string;
  description: string;
  na: string[];
  evidence: Record<string, string>;
}

interface FeaturesDoc {
  levels: string[];
  features: Feature[];
}

const SHORT_LEVEL: Record<string, string> = {
  'not-started': 'not started',
  'source-implemented': 'source',
  'asset-generated': 'generated',
  'asset-validated': 'validated',
  'unit-tested': 'unit',
  'integration-tested': 'integration',
  'browser-tested': 'browser',
  'visual-regression-tested': 'visual',
  'accessibility-tested': 'a11y',
  'mobile-tested': 'mobile',
  'container-tested': 'container',
  'compose-tested': 'compose',
  'provider-mock-tested': 'mock',
  'live-provider-tested': 'live',
  'production-image-tested': 'image',
  'manually-inspected': 'manual',
  'blocked-external-credentials': 'blocked:creds',
  'blocked-external-service': 'blocked:service',
};

function loadJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

function loadLedger(): Map<string, LedgerRow> {
  const rows = fs
    .readFileSync(LEDGER_PATH, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LedgerRow);
  const byId = new Map<string, LedgerRow>();
  for (const r of rows) {
    if (byId.has(r.id)) throw new Error(`duplicate ledger id ${r.id}`);
    byId.set(r.id, r);
  }
  return byId;
}

function commitExists(sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ledgerFresh(sha: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function problems(): string[] {
  const errs: string[] = [];
  const doc = loadJson<FeaturesDoc>(FEATURES_PATH);
  const ledger = loadLedger();
  for (const level of doc.levels) {
    if (!SHORT_LEVEL[level]) errs.push(`unknown level key "${level}" in features.json`);
  }
  const seenIds = new Set<string>();
  for (const feature of doc.features) {
    for (const [level, id] of Object.entries(feature.evidence)) {
      if (!doc.levels.includes(level)) errs.push(`${feature.id}: unknown level "${level}"`);
      if (seenIds.has(id)) errs.push(`${feature.id}: ledger id ${id} cited twice`);
      seenIds.add(id);
      const row = ledger.get(id);
      if (!row) {
        errs.push(`${feature.id} ${level}: cites missing ledger entry ${id}`);
        continue;
      }
      if (row.feature !== feature.id)
        errs.push(`${id}: feature mismatch (${row.feature} vs ${feature.id})`);
      if (row.level !== level) errs.push(`${id}: level mismatch (${row.level} vs ${level})`);
      if (level.startsWith('blocked-external-')) {
        if (row.result !== 'blocked')
          errs.push(`${id}: blocked level must record result "blocked"`);
      } else if (row.result !== 'pass' && row.result !== 'manual-pass') {
        errs.push(`${id}: level ${level} cites a non-passing entry (${row.result})`);
      }
      if (!commitExists(row.commit)) errs.push(`${id}: commit ${row.commit} is not in history`);
      if (!ledgerFresh(row.commit))
        errs.push(`${id}: commit ${row.commit} is not an ancestor of HEAD`);
      if (row.log) {
        const logPath = path.join(ROOT, row.log);
        if (!fs.existsSync(logPath)) errs.push(`${id}: log ${row.log} missing`);
      }
    }
  }
  // The two blocked levels may only cite blocked entries (and vice versa).
  for (const row of ledger.values()) {
    if (row.result === 'blocked' && !row.level.startsWith('blocked-external-'))
      errs.push(`${row.id}: result "blocked" is only valid for blocked-* levels`);
  }
  return errs;
}

function cell(feature: Feature, level: string): string {
  if (feature.na.includes(level)) return 'n/a';
  const id = feature.evidence[level];
  return id ?? '\u2014';
}

function render(doc: FeaturesDoc, ledger: Map<string, LedgerRow>): string {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  // Deterministic stamp: the newest ledger timestamp, not wall-clock time,
  // so `--write` followed by a plain check always agree.
  const stamp =
    [...ledger.values()]
      .map((r) => r.at)
      .sort()
      .pop() ?? '';
  const lines: string[] = [];
  lines.push('# Completion matrix');
  lines.push('');
  lines.push(
    `Generated by \`npx tsx scripts/completion-check.ts --write\` (ledger evidence through ${stamp}) at commit \`${head}\` from \`docs/completion/features.json\` and the append-only evidence ledger.`,
  );
  lines.push('');
  lines.push(
    'Every cell is a ledger ID (a passing entry cited below), `\u2014` (not reached) or `n/a` (not applicable to this feature). Nothing here was marked by hand.',
  );
  lines.push('');
  lines.push('| Feature | ' + doc.levels.map((l) => SHORT_LEVEL[l]).join(' | ') + ' |');
  lines.push('| --- | ' + doc.levels.map(() => '---').join(' | ') + ' |');
  for (const feature of doc.features) {
    lines.push(`| ${feature.name} | ${doc.levels.map((l) => cell(feature, l)).join(' | ')} |`);
  }
  lines.push('');
  lines.push('## Cited evidence');
  lines.push('');
  const cited = new Set<string>();
  for (const feature of doc.features)
    for (const id of Object.values(feature.evidence)) cited.add(id);
  const rows = [...ledger.values()]
    .filter((r) => cited.has(r.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const r of rows) {
    const mark =
      r.result === 'blocked' ? 'BLOCKED' : r.result === 'manual-pass' ? 'manual' : 'pass';
    lines.push(`- **${r.id}** (${mark}, ${r.feature}, ${r.level}): ${r.claim}`);
    lines.push(
      `  \`${r.command}\` at ${r.commit} — exit ${r.exit}${r.log ? `, log \`${r.log}\`` : ''}`,
    );
  }
  lines.push('');
  lines.push('## Levels not reached');
  lines.push('');
  lines.push(
    'Container, production-image and live-provider levels stay `\u2014` until their CI jobs run after the release push (Phase 12); live-provider testing stays blocked until the owner supplies Tesla credentials.',
  );
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const doc = loadJson<FeaturesDoc>(FEATURES_PATH);
  const ledger = loadLedger();
  const errs = problems();
  const rendered = render(doc, ledger);

  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT_PATH, rendered);
    if (errs.length > 0) {
      console.error('ledger/features problems (COMPLETION.md still written):');
      for (const e of errs) console.error(`  ${e}`);
      process.exit(1);
    }
    console.log(`COMPLETION.md regenerated (${doc.features.length} features).`);
    return;
  }

  if (errs.length > 0) {
    console.error('completion-check failed:');
    for (const e of errs) console.error(`  ${e}`);
    process.exit(1);
  }
  const onDisk = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf8') : null;
  if (onDisk !== rendered) {
    console.error(
      'COMPLETION.md differs from the ledger/features — run `npx tsx scripts/completion-check.ts --write`.',
    );
    process.exit(1);
  }
  console.log(
    `completion-check OK: ${doc.features.length} features, every cell cites a passing ledger entry.`,
  );
}

main();

// check:docs — the stale-phrase gate (CMP-01/C6). Every install or upgrade doc
// must agree with docs/DOCKER_COMPOSE.md, so phrases from the old model fail
// the gate:
//   - "first account … owner" (registration is no longer the first-run path);
//   - "builds locally" / local builds in an install path (install must pull
//     ghcr.io/atvriders/voltlink);
//   - recommending the v1.0.0 pin (the guide pins the current release);
//   - `$(` inside a `.env` example (compose never runs commands in .env).
// Run: npx tsx scripts/check-docs.ts

import { readFileSync, existsSync } from 'node:fs';

const DOC_FILES = [
  'README.md',
  'docs/DOCKER_COMPOSE.md',
  'docs/QUICK_START.md',
  'docs/INSTALLATION.md',
  'docs/UPGRADING.md',
  'docs/BACKUP_RESTORE.md',
  'docs/CONFIGURATION.md',
  'docs/TROUBLESHOOTING.md',
  'docs/DEPLOYMENT.md',
  'docs/TESLA_SETUP.md',
];

// [label, regex, onlyInEnvBlocks]
const RULES: { label: string; re: RegExp; envOnly?: boolean }[] = [
  {
    label: 'first account becomes the owner',
    re: /first\s+account[^\n]{0,80}(becomes?\s+(the\s+)?owner|owner)/i,
  },
  { label: 'builds locally in an install path', re: /build(s|ing)?\s+locally|local build/i },
  {
    label: 'v1.0.0 recommended as a pin',
    re: /(pin|pinning|recommend\w*|use)[^\n]{0,60}v1\.0\.0/i,
  },
];

function envBlocks(src: string): string[] {
  // Lines inside a fenced block that also contains '.env' or 'JWT_SECRET' or
  // 'POSTGRES_PASSWORD' — the .env content of an install guide.
  const blocks: string[] = [];
  const lines = src.split('\n');
  let inFence = false;
  let buf: string[] = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inFence) {
        blocks.push(buf.join('\n'));
        buf = [];
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) buf.push(line);
  }
  return blocks;
}

let failed = false;

for (const file of DOC_FILES) {
  if (!existsSync(file)) continue;
  const src = readFileSync(file, 'utf8');
  for (const rule of RULES) {
    if (rule.re.test(src)) {
      failed = true;
      console.error(`✖ ${file}: stale phrase '${rule.label}'.`);
    }
  }
  // `$(` inside an env block (a .env example must contain literal values).
  const blocks = envBlocks(src).filter(
    (b) => /\.env/.test(b) || /JWT_SECRET|POSTGRES_PASSWORD|VL_MASTER_KEY/.test(b),
  );
  // A heredoc (`cat > file <<ENV`) is a shell script that GENERATES the values
  // while writing the file — that is the documented bare-metal pattern and is
  // not a compose .env example.
  const isGenerator = (b: string) => /cat\s*>\s*\S+\s*<</.test(b) || /<<'?ENV/.test(b);
  for (const block of blocks) {
    if (isGenerator(block)) continue;
    const m = block.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=\$\(/m);
    if (m) {
      failed = true;
      console.error(
        `✖ ${file}: '$(' inside a .env example ('${m[1]}=$(...') — compose never runs commands in .env.`,
      );
    }
  }
}

if (failed) process.exit(1);
console.log('✓ no stale install phrases in the docs.');

#!/usr/bin/env node
// check:token-extraction (R2-01, CMP-01). The install guide's token command
// must extract the setup token from a real boot log line: the token has to be
// the LAST field of the logged line and the documented command must yield the
// token, not the word 'token'. Reads both sides from their sources so the
// check never drifts from the code:
//   - the boot line template from apps/api/src/index.ts (the
//     '[voltlink] first-run setup token …' log call);
//   - the extraction command from docs/DOCKER_COMPOSE.md and the CI workflow
//     (the `grep … first-run setup token …` pipeline).
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const known = 'kLtA9vF7qR2mX5zC1nD4pW8hB3sY6eG0';

// 1. The product's actual log line.
const indexSrc = readFileSync('apps/api/src/index.ts', 'utf8');
const mLine = indexSrc.match(/`\[voltlink\] first-run setup token[^`]*`/);
if (!mLine) {
  console.error('✖ could not find the first-run setup token log line in apps/api/src/index.ts');
  process.exit(1);
}
const template = mLine[0].slice(1, -1);
const rendered = template.replace(/\$\{[^}]*\}/g, known);
console.log(`boot line: ${rendered}`);

// 2. The documented / CI extraction command.
function findCommand(file) {
  const src = readFileSync(file, 'utf8');
  const m = src.match(/(?:grep[^\n]*?first-run setup token[^\n)]*)/);
  return m?.[0]?.trim();
}
const candidates = ['docs/DOCKER_COMPOSE.md', 'README.md', '.github/workflows/ci.yml']
  .map((f) => ({ file: f, cmd: findCommand(f) }))
  .filter((c) => c.cmd);

if (candidates.length === 0) {
  console.error(
    '✖ no documented extraction command found in docs/DOCKER_COMPOSE.md, README.md or ci.yml',
  );
  process.exit(1);
}

let failed = false;

// The guide itself must document the extraction command (R2-01 docs half).
if (!candidates.some((c) => c.file === 'docs/DOCKER_COMPOSE.md')) {
  failed = true;
  console.error(
    '✖ docs/DOCKER_COMPOSE.md has no token extraction command — the guide must tell the installer how to read the setup token.',
  );
}

// The token must be the LAST field of the boot line (R2-01 fix text), so a
// plain `awk '{print $NF}'` yields it from any log prefix.
const lastField = rendered.trim().split(/\s+/).pop();
console.log(`last field of the boot line: '${lastField}'`);
if (lastField !== known) {
  failed = true;
  console.error(
    `✖ the token is not the last field of the boot line ('${lastField}') — keep the token as the last field so the documented command works.`,
  );
}

for (const { file, cmd } of candidates) {
  const escaped = rendered.replace(/'/g, `'\\''`);
  const result = execSync(`printf '%s' '${escaped}' | ${cmd}`, {
    encoding: 'utf8',
  }).trim();
  console.log(`${file}: ${cmd} -> '${result}'`);
  if (result !== known) {
    failed = true;
    console.error(`✖ ${file}: the extraction command yields '${result}', not the token.`);
  }
}
if (failed) process.exit(1);
console.log('✓ the documented command extracts the setup token from a real boot line.');

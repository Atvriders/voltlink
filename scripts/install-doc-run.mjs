#!/usr/bin/env node
// install-doc-run.mjs — executes the RUNNABLE blocks of docs/DOCKER_COMPOSE.md
// verbatim (C5). A block is a `<!-- run: <name> -->` marker directly above a
// fenced ```bash block. Two substitutions are allowed, both printed:
//   1. the `curl …/compose.production.yml -o compose.production.yml` line
//      becomes `cp <--compose-src> compose.production.yml`;
//   2. the `.env.example` curl becomes `cp <--env-example-src> .env.example`;
//   3. every `-f compose.production.yml` gets `-f <--ci-overlay>` appended so
//      the run boots the CI image swap instead of pulling from GHCR.
// Blocks are executed in a scratch workdir with bash -e.
//
// Usage: node scripts/install-doc-run.mjs --workdir <dir>
//        [--guide docs/DOCKER_COMPOSE.md] [--compose-src <file>]
//        [--env-example-src <file>] [--ci-overlay docker-compose.ci.yml]
//        [--only name] [--from name] [--dry-run]

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

function parseArgs(argv) {
  const out = { guide: 'docs/DOCKER_COMPOSE.md' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--guide') out.guide = argv[++i];
    else if (a === '--workdir') out.workdir = argv[++i];
    else if (a === '--compose-src') out.composeSrc = argv[++i];
    else if (a === '--env-example-src') out.envExampleSrc = argv[++i];
    else if (a === '--ci-overlay') out.ciOverlay = argv[++i];
    else if (a === '--only') out.only = argv[++i];
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--until') out.until = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`unknown arg ${a}`);
  }
  return out;
}

export function parseGuideBlocks(md) {
  const blocks = [];
  const re = /<!--\s*run:\s*([\w-]+)\s*-->\s*\n\s*```bash\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    blocks.push({ name: m[1], body: m[2].replace(/\n$/, '') });
  }
  return blocks;
}

export function substitute(block, opts) {
  let body = block;
  if (opts.composeSrc) {
    body = body.replace(
      /curl -fsSL https:\/\/raw\.githubusercontent\.com\/Atvriders\/voltlink\/v[\d.]+\/compose\.production\.yml -o compose\.production\.yml/,
      `cp ${opts.composeSrc} compose.production.yml`,
    );
  }
  if (opts.envExampleSrc) {
    body = body.replace(
      /curl -fsSL https:\/\/raw\.githubusercontent\.com\/Atvriders\/voltlink\/v[\d.]+\/\.env\.example -o \.env\.example/,
      `cp ${opts.envExampleSrc} .env.example`,
    );
  }
  if (opts.ciOverlay) {
    body = body.replaceAll(
      '-f compose.production.yml',
      `-f compose.production.yml -f ${opts.ciOverlay}`,
    );
  }
  return body;
}

const main = () => {
  const opts = parseArgs(process.argv.slice(2));
  const md = readFileSync(opts.guide, 'utf8');
  const blocks = parseGuideBlocks(md);
  if (blocks.length === 0) {
    console.error(`no runnable blocks found in ${opts.guide}`);
    process.exit(1);
  }
  if (opts.workdir) mkdirSync(opts.workdir, { recursive: true });
  const runFrom = opts.from ? blocks.findIndex((b) => b.name === opts.from) : 0;
  if (runFrom < 0) {
    console.error(`--from ${opts.from}: no such block`);
    process.exit(1);
  }
  let runUntil = blocks.length;
  if (opts.until) {
    const idx = blocks.findIndex((b) => b.name === opts.until);
    if (idx < 0) {
      console.error(`--until ${opts.until}: no such block`);
      process.exit(1);
    }
    runUntil = idx + 1;
  }
  for (const block of blocks.slice(runFrom, runUntil)) {
    if (opts.only && block.name !== opts.only) continue;
    const body = substitute(block.body, opts);
    console.log(`\n== run block ${block.name} ==`);
    console.log(body);
    if (opts.dryRun) continue;
    execSync(`set -e\n${body}`, { cwd: opts.workdir, stdio: 'inherit' });
  }
  console.log(`\ninstalled from ${blocks.length} guide block(s).`);
};

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('install-doc-run.mjs')
) {
  main();
}

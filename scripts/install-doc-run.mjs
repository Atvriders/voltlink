#!/usr/bin/env node
// install-doc-run.mjs — executes the RUNNABLE blocks of docs/DOCKER_COMPOSE.md
// (and the README quick-start subset) verbatim (C5). A block is a
// `<!-- run: <name> -->` marker directly above a fenced ```bash block.
// Each block runs under `env -i`, keeping only PATH, HOME and DOCKER_*.
// Three substitutions are allowed, all printed:
//   1. the `curl …/compose.production.yml -o compose.production.yml` line
//      becomes `cp <--compose-src> compose.production.yml`;
//   2. the `curl …/docker-compose.yml -o docker-compose.yml` line becomes
//      `cp <--entry-src> docker-compose.yml`;
//   3. the `.env.example` curl becomes `cp <--env-example-src> .env.example`.
// `--ci-overlay` exports `COMPOSE_FILE=compose.production.yml:<overlay>` for
// every block so the run boots the CI image swap instead of pulling from
// GHCR (the guide stays bare `docker compose`); `--image-digest` exports
// `VOLTLINK_IMAGE_DIGEST` for the same reason. Both are printed.
// `--skip` drops named blocks (CI skips the non-localhost PUBLIC_URL cases).
// `--also` runs the marked quick-start blocks of an extra doc (README).
//
// Usage: node scripts/install-doc-run.mjs --workdir <dir>
//        [--guide docs/DOCKER_COMPOSE.md] [--compose-src <file>]
//        [--entry-src <file>] [--env-example-src <file>]
//        [--ci-overlay docker-compose.ci.yml] [--image-digest @sha256:…]
//        [--also README.md] [--skip env-lan,env-https] [--only name]
//        [--from name] [--until name] [--dry-run]

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

function parseArgs(argv) {
  const out = { guide: 'docs/DOCKER_COMPOSE.md' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--guide') out.guide = argv[++i];
    else if (a === '--also') out.also = argv[++i];
    else if (a === '--workdir') out.workdir = argv[++i];
    else if (a === '--compose-src') out.composeSrc = argv[++i];
    else if (a === '--entry-src') out.entrySrc = argv[++i];
    else if (a === '--env-example-src') out.envExampleSrc = argv[++i];
    else if (a === '--ci-overlay') out.ciOverlay = argv[++i];
    else if (a === '--image-digest') out.imageDigest = argv[++i];
    else if (a === '--only') out.only = argv[++i];
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--until') out.until = argv[++i];
    else if (a === '--skip') out.skip = argv[++i].split(',').filter(Boolean);
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
  if (opts.entrySrc) {
    body = body.replace(
      /curl -fsSL https:\/\/raw\.githubusercontent\.com\/Atvriders\/voltlink\/v[\d.]+\/docker-compose\.yml -o docker-compose\.yml/,
      `cp ${opts.entrySrc} docker-compose.yml`,
    );
  }
  if (opts.envExampleSrc) {
    body = body.replace(
      /curl -fsSL https:\/\/raw\.githubusercontent\.com\/Atvriders\/voltlink\/v[\d.]+\/\.env\.example -o \.env\.example/,
      `cp ${opts.envExampleSrc} .env.example`,
    );
  }
  return body;
}

// The environment each block runs in: env -i keeps PATH, HOME and DOCKER_*;
// the CI overlay and the digest pin travel through the environment so the
// guide needs no COMPOSE_FILE line and no env file.
export function buildKeptEnv(opts, processEnv) {
  const kept = { PATH: processEnv.PATH, HOME: processEnv.HOME };
  const dockerKeys = [];
  for (const [k, v] of Object.entries(processEnv)) {
    if (k.startsWith('DOCKER_') && v) {
      kept[k] = v;
      dockerKeys.push(k);
    }
  }
  if (opts.ciOverlay) {
    kept.COMPOSE_FILE = `compose.production.yml:${opts.ciOverlay}`;
  }
  if (opts.imageDigest) {
    kept.VOLTLINK_IMAGE_DIGEST = opts.imageDigest;
  }
  return { kept, dockerKeys };
}

const main = () => {
  const opts = parseArgs(process.argv.slice(2));
  const md = readFileSync(opts.guide, 'utf8');
  const blocks = parseGuideBlocks(md);
  if (blocks.length === 0) {
    console.error(`no runnable blocks found in ${opts.guide}`);
    process.exit(1);
  }
  const extra = opts.also
    ? parseGuideBlocks(readFileSync(opts.also, 'utf8')).map((b) => ({
        ...b,
        name: `${opts.also.replace(/[^\w-]/g, '_')}:${b.name}`,
      }))
    : [];
  const all = [...blocks, ...extra];
  if (opts.workdir) mkdirSync(opts.workdir, { recursive: true });
  const skip = new Set(opts.skip ?? []);
  const runFrom = opts.from ? all.findIndex((b) => b.name === opts.from) : 0;
  if (runFrom < 0) {
    console.error(`--from ${opts.from}: no such block`);
    process.exit(1);
  }
  let runUntil = all.length;
  if (opts.until) {
    const idx = all.findIndex((b) => b.name === opts.until);
    if (idx < 0) {
      console.error(`--until ${opts.until}: no such block`);
      process.exit(1);
    }
    runUntil = idx + 1;
  }
  const { kept, dockerKeys } = buildKeptEnv(opts, process.env);
  console.log(
    `env -i kept: PATH, HOME${dockerKeys.length ? `, ${dockerKeys.join(', ')}` : ''}${
      opts.ciOverlay ? `, COMPOSE_FILE=compose.production.yml:${opts.ciOverlay}` : ''
    }${opts.imageDigest ? `, VOLTLINK_IMAGE_DIGEST=${opts.imageDigest}` : ''}`,
  );
  if (skip.size > 0) console.log(`skipped blocks: ${[...skip].join(', ')}`);
  for (const block of all.slice(runFrom, runUntil)) {
    if (opts.only && block.name !== opts.only) continue;
    if (skip.has(block.name)) {
      console.log(`\n== skip block ${block.name} ==`);
      continue;
    }
    const body = substitute(block.body, opts);
    console.log(`\n== run block ${block.name} ==`);
    console.log(body);
    if (opts.dryRun) continue;
    execSync(`set -e\n${body}`, { cwd: opts.workdir, stdio: 'inherit', env: kept });
  }
  console.log(`\ninstalled from ${all.length} guide block(s).`);
};

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('install-doc-run.mjs')
) {
  main();
}

#!/usr/bin/env node
// compare-compose-config.mjs — CI compares the C3 renderer's model with the
// AUTHORITY `docker compose config --format json` (C5). Usage:
//   docker compose -f ... config --format json > config.json
//   node scripts/compose-render.mjs --env-file .env compose.production.yml > render.json
//   node scripts/compare-compose-config.mjs render.json config.json
// Compares, per service: image (normalized for the digest suffix), ports,
// networks, volumes and every environment value. Fails on the first mismatch.

import { readFileSync } from 'node:fs';

function norm(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    // docker compose emits booleans as strings already; normalize null vs ''
    return v === '' ? v : v.replace(/^\$\$\$/, '$$');
  }
  return v;
}

const [renderPath, configPath] = process.argv.slice(2);
if (!renderPath || !configPath) {
  console.error('usage: compare-compose-config.mjs <render.json> <config.json>');
  process.exit(64);
}
const rendered = JSON.parse(readFileSync(renderPath, 'utf8'));
const actual = JSON.parse(readFileSync(configPath, 'utf8'));

let failed = false;
const services = Object.keys(rendered.services);
for (const name of services) {
  const r = rendered.services[name];
  const a = actual.services?.[name];
  if (!a) {
    console.error(`✖ service '${name}' exists in the renderer but not in docker compose`);
    failed = true;
    continue;
  }
  const compare = (label, rv, av) => {
    const rr = norm(rv);
    const aa = norm(av);
    const same = JSON.stringify(rr) === JSON.stringify(aa);
    if (!same) {
      failed = true;
      console.error(
        `✖ service '${name}' ${label}: renderer=${JSON.stringify(rr)} compose=${JSON.stringify(aa)}`,
      );
    }
  };
  const imageA = (a.image ?? '').replace(/@sha256:.*$/, '').replace(/:\$\$\$/, ':');
  const imageR = (r.image ?? '').replace(/@sha256:.*$/, '');
  compare('image', imageR, imageA);
  if (r.environment) {
    const ae = a.environment ?? {};
    for (const [k, v] of Object.entries(r.environment)) {
      if (ae[k] === undefined) {
        // compose omits empty-string values; the renderer keeps them.
        if (v === '') continue;
        failed = true;
        console.error(`✖ service '${name}' env ${k}: missing from docker compose output`);
        continue;
      }
      compare(`env ${k}`, v, ae[k]);
    }
  }
  if (r.ports?.length) {
    // Renderer emits compact strings ("[host:]published:target"); compose
    // emits objects. Compare published:target for both.
    const normPort = (s) => {
      const parts = String(s).split(':');
      return parts.length >= 2
        ? `${parts[parts.length - 2]}:${parts[parts.length - 1]}`
        : String(s);
    };
    compare(
      'ports',
      r.ports.map(normPort).sort(),
      (a.ports ?? []).map((p) => `${p.published}:${p.target}`).sort(),
    );
  }
  if (r.networks?.length)
    compare('networks', r.networks.slice().sort(), Object.keys(a.networks ?? {}).sort());
  if (r.volumes?.length) {
    // Renderer emits compact "source:target[:mode]" strings; compose emits
    // {source,target,read_only} objects. Compare target + read-only — the
    // bind-mount source is relative in the files and absolute in compose.
    const normVol = (s) => {
      const parts = String(s).split(':');
      return { t: parts[1], ro: parts[2] === 'ro' };
    };
    compare(
      'volumes',
      r.volumes.map(normVol).sort((x, y) => x.t.localeCompare(y.t)),
      (a.volumes ?? [])
        .map((v) => ({ t: v.target, ro: v.read_only === true }))
        .sort((x, y) => x.t.localeCompare(y.t)),
    );
  }
}
if (failed) {
  console.error('renderer and docker compose disagree — fix scripts/compose-render.mjs');
  process.exit(1);
}
console.log(`✓ renderer matches docker compose config for ${services.length} services.`);

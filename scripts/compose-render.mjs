#!/usr/bin/env node
// compose-render.mjs — a small MODEL of `docker compose config` for VoltLink's
// compose files (C3). It is NOT Compose itself: CI's `docker compose config
// --format json` stays the authority, and the compose-validate job compares
// this renderer's output against it.
//
// Supported subset (everything VoltLink's files use):
//   - block mappings and sequences, 2-space nesting;
//   - inline sequences [a, b];
//   - single-quoted and double-quoted scalars, plain scalars;
//   - YAML anchors (&name) and merge keys (<<: *name);
//   - `include:` (recursive, resolved relative to the including file);
//   - multiple -f files merged in order (maps merge, scalars/lists override);
//   - interpolation: ${VAR}, ${VAR:-def}, ${VAR-def}, ${VAR:?msg}, ${VAR?msg},
//     and $$ for a literal $.
//
// CLI: node scripts/compose-render.mjs [--env-file .env] file1.yml [file2.yml]
// Prints JSON: { name, services: { name: { image, build, environment, networks,
// ports, volumes, profiles } }, networks, volumes }.

import { readFileSync } from 'node:fs';
import path from 'node:path';

const INDENT_RE = /^(\s*)/;

function parseLines(src) {
  return src.split('\n');
}

// Parses a YAML value starting at `lines[i]` (which must be at least `indent`
// columns). Returns [value, nextIndex].
function parseValue(lines, i, indent) {
  const line = lines[i];
  const rest = line.slice(indent).trim();
  if (rest.startsWith('- ')) {
    // sequence block
    return parseSequence(lines, i, indent);
  }
  if (rest === '-') {
    // sequence whose items are nested
    return parseSequence(lines, i, indent);
  }
  // mapping or scalar
  const m = rest.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
  if (m && m[2] === '') {
    return parseMapping(lines, i, indent);
  }
  return [scalar(rest), i + 1];
}

function nextNonChild(lines, i, indent) {
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      j += 1;
      continue;
    }
    const m = INDENT_RE.exec(line);
    const col = m ? m[1].length : 0;
    if (col <= indent) break;
    j += 1;
  }
  return j;
}

function parseSequence(lines, i, indent) {
  const out = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      j += 1;
      continue;
    }
    const m = INDENT_RE.exec(line);
    const col = m ? m[1].length : 0;
    if (col < indent) break;
    if (col === indent && line.slice(indent).startsWith('- ')) {
      const item = line.slice(indent + 2).trim();
      if (item === '') {
        const [v, k] = parseValue(lines, j + 1, indent + 2);
        out.push(v);
        j = k;
        continue;
      }
      out.push(scalar(item));
      j += 1;
      continue;
    }
    if (col === indent && line.slice(indent).startsWith('-')) {
      const [v, k] = parseValue(lines, j + 1, indent + 2);
      out.push(v);
      j = k;
      continue;
    }
    if (col > indent) {
      j += 1;
      continue;
    }
    break;
  }
  return [out, j];
}

function parseMapping(lines, i, indent) {
  const out = {};
  const merges = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      j += 1;
      continue;
    }
    const m = INDENT_RE.exec(line);
    const col = m ? m[1].length : 0;
    if (col < indent) break;
    if (col !== indent) {
      j += 1;
      continue;
    }
    const rest = line.slice(indent);
    // <<: *anchor merge key (the key regex above never matches '<<').
    const mmMerge = rest.match(/^<<:\s*(.*)$/);
    if (mmMerge) {
      for (const name of mmMerge[1]
        .replace(/[\[\],*]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)) {
        merges.push(name);
      }
      j += 1;
      continue;
    }
    const mm = rest.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!mm) {
      j += 1;
      continue;
    }
    const key = mm[1];
    const raw = mm[2].trim();
    if (raw.startsWith('&')) {
      const anchorName = raw.slice(1).trim();
      const [v, k] = isSequenceAt(lines, j + 1, indent + 2)
        ? parseSequence(lines, j + 1, indent + 2)
        : parseMapping(lines, j + 1, indent + 2);
      out[key] = v;
      anchors[anchorName] = v;
      j = k;
      continue;
    }
    if (raw === '') {
      const [v, k] = isSequenceAt(lines, j + 1, indent + 2)
        ? parseSequence(lines, j + 1, indent + 2)
        : parseMapping(lines, j + 1, indent + 2);
      out[key] = v;
      j = k;
      continue;
    }
    out[key] = scalar(raw);
    j += 1;
  }
  const result = { ...out };
  for (const name of merges.reverse()) {
    const base = anchors[name];
    if (base && typeof base === 'object' && !Array.isArray(base)) {
      for (const [k, v] of Object.entries(base)) {
        if (result[k] === undefined) result[k] = v;
      }
    }
  }
  return [result, j];
}

const anchors = {};

function nextContent(lines, i) {
  let j = i;
  while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j += 1;
  return j;
}

function isSequenceAt(lines, i, indent) {
  const j = nextContent(lines, i);
  if (j >= lines.length) return false;
  const line = lines[j];
  const col = INDENT_RE.exec(line)?.[1].length ?? 0;
  return col === indent && (line.slice(indent).startsWith('- ') || line.slice(indent) === '-');
}

function scalar(raw) {
  const t = raw.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  if (t.startsWith('[') && t.endsWith(']')) {
    return t
      .slice(1, -1)
      .split(',')
      .map((s) => scalar(s.trim()))
      .filter((s) => s !== '');
  }
  return t;
}

function parseDocument(file) {
  for (const k of Object.keys(anchors)) delete anchors[k]; // anchors never leak across files
  const src = readFileSync(file, 'utf8');
  const lines = parseLines(src);
  // strip comment-only and blank leading lines
  let start = 0;
  while (
    start < lines.length &&
    (lines[start].trim() === '' || lines[start].trim().startsWith('#'))
  ) {
    start += 1;
  }
  const [doc] = parseMapping(lines, start, 0);
  return doc;
}

function loadWithIncludes(file, stack = []) {
  if (stack.includes(file))
    throw new Error(`compose include cycle: ${[...stack, file].join(' -> ')}`);
  const doc = parseDocument(file);
  const merged = {};
  const include = doc.include ?? [];
  const dir = path.dirname(path.resolve(file));
  for (const inc of Array.isArray(include) ? include : [include]) {
    Object.assign(merged, loadWithIncludes(path.join(dir, inc), [...stack, file]));
  }
  return deepMerge(merged, doc);
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === 'include') continue;
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      out[k] &&
      typeof out[k] === 'object' &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function interpolate(value, env, envFile) {
  if (typeof value === 'string') {
    // $$ -> literal $
    let out = value.replace(/\$\$/g, '\u0000DOLLAR\u0000');
    out = out.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*)|-([^}]*)|:\?([^}]*)|:?\?([^}]*))?\}/g,
      (_m, name, _op, defColon, defPlain, reqColon, reqPlain) => {
        const lookup = (n) => (env[n] !== undefined ? env[n] : envFile[n]);
        const val = lookup(name);
        if (_op === undefined) {
          return val === undefined ? '' : String(val);
        }
        if (defColon !== undefined) return val === undefined || val === '' ? defColon : String(val);
        if (defPlain !== undefined) return val === undefined ? defPlain : String(val);
        if (reqColon !== undefined || reqPlain !== undefined) {
          const msg = reqColon !== undefined ? reqColon : reqPlain;
          if (val === undefined || val === '') {
            throw new Error(`Required variable ${name} is not set${msg ? `: ${msg}` : ''}`);
          }
          return String(val);
        }
        return '';
      },
    );
    return out.replace(/\u0000DOLLAR\u0000/g, '$');
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env, envFile));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, env, envFile);
    return out;
  }
  return value;
}

function loadEnvFile(file) {
  const out = {};
  if (!file) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function renderCompose(files, options = {}) {
  const envFile = options.envFile ? loadEnvFile(options.envFile) : {};
  const shellEnv = { ...process.env, ...(options.env ?? {}) };
  const activeProfiles = new Set(options.profiles ?? []);
  let merged = {};
  for (const f of files) {
    merged = deepMerge(merged, loadWithIncludes(f));
  }
  const doc = interpolate(merged, shellEnv, envFile);
  const services = {};
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    const profiles = Array.isArray(svc.profiles) ? svc.profiles : [];
    // Compose semantics: services without a profile are always active;
    // profiled services render only when --profile activates one of them.
    if (profiles.length > 0 && !profiles.some((p) => activeProfiles.has(p))) continue;
    services[name] = {
      image: svc.image,
      build: svc.build,
      environment: svc.environment ?? {},
      networks: Array.isArray(svc.networks) ? svc.networks : [],
      ports: Array.isArray(svc.ports) ? svc.ports : [],
      volumes: Array.isArray(svc.volumes) ? svc.volumes : [],
      profiles,
    };
  }
  return { name: doc.name, services, networks: doc.networks ?? {}, volumes: doc.volumes ?? {} };
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('compose-render.mjs')
) {
  const args = process.argv.slice(2);
  let envFile = null;
  const files = [];
  const profiles = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env-file') {
      envFile = args[++i];
    } else if (args[i] === '--profile') {
      profiles.push(args[++i]);
    } else {
      files.push(args[i]);
    }
  }
  console.log(JSON.stringify(renderCompose(files, { envFile, profiles }), null, 2));
}

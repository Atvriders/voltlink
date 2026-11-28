// check:compose — the compose-layer gate (I-COMPOSEENV, TI-59, R2-67, R2-70,
// NEW-17, R2-03, I-V100 and the CMP-01 checks). Exits non-zero when any
// install-path compose file:
//   - passes a role an environment key not in ENV_SPEC ∪ {VL_ROLE}, or misses
//     an ENV_SPEC key (TI-59);
//   - references an undeclared network or volume (R2-03, NEW-17);
//   - contains `build:` (the install path must pull the published image);
//   - interpolates `${DATABASE_URL:-` (R2-70);
//   - gives a VL_MASTER_KEY* variable an empty default (R2-67);
//   - gives a required value anything but a `${VAR:-default}` (JWT_SECRET,
//     VL_MASTER_KEY, POSTGRES_PASSWORD, PUBLIC_URL);
//   - ships a default that the runtime validator rejects (VL_MASTER_KEY must
//     base64-decode to exactly 32 bytes, JWT_SECRET needs 32+ characters,
//     POSTGRES_PASSWORD 16+, PUBLIC_URL a real http(s) URL). A 32-character
//     hex key is the trap that shipped once: structurally a fine default,
//     but it decodes to 24 bytes and every app role crash-loops at boot;
//   - names an image other than ghcr.io/atvriders/voltlink, or a default tag
//     that differs from 'v' + package.json's version (I-V100);
//   - drops VL_QUEUE_PREFIX from a role (R2-49, I-COMPOSEENV).
// Also checks .env.example: every key must be in ENV_SPEC ∪ the infra
// allow-list, and the bare DATABASE_URL/TEST_DATABASE_ADMIN_URL must not
// appear (R2-70).
//
// This is a structural checker for pull-only compose files, not a YAML model;
// `docker compose config` remains the CI authority (CI also compares the
// scripts/compose-render output against `docker compose config --format json`).

import { readFileSync } from 'node:fs';

const INSTALL_FILES = ['compose.production.yml', 'docker-compose.yml'];
// Compose-layer (infra) values that never go through ENV_SPEC.
const INFRA_ENV = new Set(['VL_ROLE', 'POSTGRES_USER', 'POSTGRES_DB']);
// Required values: must be `${VAR:?...}` in the app environment.
const REQUIRED = ['POSTGRES_PASSWORD', 'JWT_SECRET', 'VL_MASTER_KEY', 'PUBLIC_URL'];
// .env.example infra allow-list (everything else must be in ENV_SPEC).
const ENV_EXAMPLE_INFRA = new Set([
  'PORT',
  'HOST',
  'WEB_PORT',
  'STATUS_PORT',
  'POSTGRES_PASSWORD',
  'VOLTLINK_IMAGE_TAG',
  'VOLTLINK_IMAGE_DIGEST',
  'VOLTLINK_BIND_ADDRESS',
  'VOLTLINK_STATUS_PORT',
]);

interface RoleEnv {
  role: string;
  keys: Set<string>;
  inherits: boolean;
}

interface ComposeFile {
  roles: RoleEnv[];
  networksDeclared: string[];
  volumesDeclared: string[];
  networksUsed: string[];
  volumesUsed: string[];
  internalNets: string[];
  serviceNets: Map<string, string[]>;
  servicesWithPorts: string[];
  /** `${VAR:-default}` values, so the runtime validators can be replayed. */
  envDefaults: Map<string, string>;
  buildSeen: boolean;
  images: string[];
  errors: string[];
}

function parseCompose(src: string, file: string): ComposeFile {
  const anchors = new Map<string, string[]>();
  const roles = new Map<string, RoleEnv>();
  const networksDeclared: string[] = [];
  const volumesDeclared: string[] = [];
  const networksUsed: string[] = [];
  const volumesUsed: string[] = [];
  const internalNets: string[] = [];
  const serviceNets = new Map<string, string[]>();
  const servicesWithPorts = new Set<string>();
  const envDefaults = new Map<string, string>();
  let netMember = '';
  let buildSeen = false;
  const images: string[] = [];
  const errors: string[] = [];
  const lines = src.split('\n');
  let role = '';
  let section: 'none' | 'environment' = 'none';
  let inAnchor: string | null = null;
  let topLevel = '';

  const roleOf = () => {
    if (!role) return undefined;
    let r = roles.get(role);
    if (!r) {
      r = { role, keys: new Set(), inherits: false };
      roles.set(role, r);
    }
    return r;
  };

  for (const line of lines) {
    // Top-level declaration lists come first so their 2-space members are
    // never mistaken for service headers.
    if (topLevel === 'networks') {
      const m = line.match(/^ {2}([\w-]+):\s*$/);
      if (m) {
        networksDeclared.push(m[1]!);
        netMember = m[1]!;
        continue;
      }
      // `internal: true` on the current network member (published ports are
      // silently not applied on internal-only networks).
      if (netMember && /^\s{4}internal:\s*true\s*$/.test(line)) {
        internalNets.push(netMember);
        continue;
      }
    }
    if (topLevel === 'volumes') {
      const m = line.match(/^ {2}([\w-]+):\s*$/);
      if (m) {
        volumesDeclared.push(m[1]!);
        continue;
      }
    }
    // Top-level keys (column 0): services / networks / volumes / name.
    const mTop = line.match(/^(\w[\w-]*):\s*$/);
    if (mTop) {
      topLevel = mTop[1]!;
      role = '';
      section = 'none';
      inAnchor = null;
      continue;
    }
    // Service header (2-space indent, lowercase name).
    const mRole = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (mRole) {
      role = mRole[1]!;
      section = 'none';
      inAnchor = null;
      continue;
    }
    // Anchored environment map (before the service-anchor pattern: both can
    // match 'environment: &app_env').
    const mAnchor = line.match(/^\s*environment:\s*&(\w+)\s*$/);
    if (mAnchor) {
      section = 'environment';
      inAnchor = mAnchor[1]!;
      anchors.set(inAnchor, []);
      continue;
    }
    if (/^\s*environment:\s*$/.test(line)) {
      section = 'environment';
      inAnchor = null;
      continue;
    }
    // Anchored shared service block (e.g. x-voltlink-common: &voltlink) and
    // service-level `<<: *voltlink` merges.
    if (/^ {0,2}\w[\w-]*:\s*&\w+\s*$/.test(line) || /^ {4}<<:\s*\*\w+\s*$/.test(line)) {
      if (!/^ {4}<<:/.test(line)) {
        role = '';
        section = 'none';
        inAnchor = null;
      }
      continue;
    }
    if (/^ {2,4}image:\s*(\S.*)$/.test(line)) {
      images.push(line.match(/^ {2,4}image:\s*(\S.*)$/)![1]!.trim());
      continue;
    }
    if (/^ {2,4}build:/.test(line)) {
      buildSeen = true;
      continue;
    }
    const mNets = line.match(/^ {4}networks:\s*\[(.*)\]$/);
    if (mNets) {
      const names: string[] = [];
      for (const n of mNets[1]!.split(',')) {
        const name = n.trim();
        if (name) {
          networksUsed.push(name);
          names.push(name);
        }
      }
      if (role) serviceNets.set(role, names);
      continue;
    }
    // A service that publishes a host port (block or inline list).
    if (/^ {4}ports:/.test(line)) {
      if (role) servicesWithPorts.add(role);
    }
    const mVols = line.match(/^ {4}volumes:\s*\[(.*)\]$/);
    if (mVols) {
      for (const v of mVols[1]!.split(',')) {
        const name = v.trim().split(':')[0]!.trim();
        if (name) volumesUsed.push(name);
      }
      continue;
    }
    if (section !== 'environment') {
      // Any other service key ends the environment section.
      if (/^ {2,4}[A-Za-z0-9_]+:/.test(line)) {
        inAnchor = null;
      }
      continue;
    }
    // <<: *anchor merge inside environment.
    const mInherit = line.match(/^\s*<<:\s*\*(\w+)\s*$/);
    if (mInherit) {
      const r = roleOf();
      if (r) {
        r.inherits = true;
        for (const k of anchors.get(mInherit[1]!) ?? []) r.keys.add(k);
      }
      continue;
    }
    // An environment key line. A key with no value is a nested map
    // (healthcheck:, depends_on:, ports:) and ends the environment section.
    const mKey = line.match(/^\s{4,6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (mKey) {
      if (mKey[2]!.trim() === '') {
        section = 'none';
        inAnchor = null;
        continue;
      }
      const key = mKey[1]!;
      const value = mKey[2]!;
      const mDefault = value.match(/'?\$\{[A-Za-z0-9_]+:-([^'}]*)\}'\s*$/);
      if (mDefault) envDefaults.set(key, mDefault[1]!);
      if (inAnchor) anchors.get(inAnchor)!.push(key);
      const r = roleOf();
      if (r) r.keys.add(key);
      // Empty default on the boot-breaking master-key variable (R2-67).
      // (VL_MASTER_KEYS keeps an empty default: the product treats it as
      // unset, and compose cannot omit an anchored key.)
      if (key === 'VL_MASTER_KEY_VERSION' && /'\$\{[A-Za-z0-9_]*:-?\}'\s*$/.test(value)) {
        errors.push(
          `✖ ${file}: '${key}: ${value}' renders an empty string — treat empty as unset in the product (R2-67).`,
        );
      }
      // Required values must carry a NON-EMPTY default right here in the
      // compose file (`${VAR:-default}`) so the documented flow needs no
      // .env file at all. A `:?` fail-fast or an empty `:-` is a regression.
      if (REQUIRED.includes(key) && !/'\$\{[A-Za-z0-9_]+:-[^']+\}'/.test(value)) {
        errors.push(
          `✖ ${file}: '${key}: ${value}' must carry a non-empty default interpolation '\${${key}:-default}' (no .env file is required).`,
        );
      }
      continue;
    }
  }
  return {
    roles: [...roles.values()],
    networksDeclared,
    volumesDeclared,
    networksUsed,
    volumesUsed,
    internalNets,
    serviceNets,
    servicesWithPorts: [...servicesWithPorts],
    envDefaults,
    buildSeen,
    images,
    errors,
  };
}

async function main(): Promise<void> {
  const { ENV_KEYS } = await import('../apps/api/src/core/env-spec');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  const expectedTag = `v${pkg.version}`;
  let failed = false;

  // `include:` resolution: docker-compose.yml includes the canonical file,
  // so its effective source is the concatenation of every included file.
  const includeSeen = new Set<string>();
  function loadEffective(file: string, stack: string[] = []): string {
    if (stack.includes(file))
      throw new Error(`compose include cycle: ${[...stack, file].join(' -> ')}`);
    includeSeen.add(file);
    let src = readFileSync(file, 'utf8');
    const inc = src.match(/^include:\s*$\n((?:^\s*-\s*\S.*$\n?)+)/m);
    if (inc) {
      for (const m of inc[1]!.matchAll(/^\s*-\s*(\S+)\s*$/gm)) {
        src += '\n' + loadEffective(m[1]!, [...stack, file]);
      }
    }
    return src;
  }

  for (const file of INSTALL_FILES) {
    const src = loadEffective(file);
    const parsed = parseCompose(src, file);

    for (const e of parsed.errors) {
      failed = true;
      console.error(e);
    }

    if (parsed.buildSeen) {
      failed = true;
      console.error(
        `✖ ${file}: contains 'build:' — the install path must pull ghcr.io/atvriders/voltlink.`,
      );
    }

    for (const n of parsed.networksUsed) {
      if (!parsed.networksDeclared.includes(n)) {
        failed = true;
        console.error(`✖ ${file}: service uses undeclared network '${n}'.`);
      }
    }
    for (const v of parsed.volumesUsed) {
      if (!parsed.volumesDeclared.includes(v) && !v.startsWith('.') && v !== 'pgdata') {
        failed = true;
        console.error(`✖ ${file}: service uses undeclared volume '${v}'.`);
      }
    }

    // Docker records a port binding on internal-only containers and never
    // applies it: `HostConfig.PortBindings` shows the mapping while
    // `NetworkSettings.Ports` stays null and nothing answers on the host.
    // The status role shipped this way once; the documented URL was dead.
    for (const svc of parsed.servicesWithPorts) {
      const nets = parsed.serviceNets.get(svc) ?? [];
      if (nets.length > 0 && nets.every((n) => parsed.internalNets.includes(n))) {
        failed = true;
        console.error(
          `✖ ${file}: service '${svc}' publishes ports but joins only internal networks (${nets.join(', ')}) — Docker silently never applies the binding; add a non-internal network.`,
        );
      }
    }

    for (const img of parsed.images) {
      if (
        !img.includes('ghcr.io/atvriders/voltlink') &&
        !/^(postgres|redis|tesla\/vehicle-command):/.test(img)
      ) {
        failed = true;
        console.error(
          `✖ ${file}: image '${img}' is not ghcr.io/atvriders/voltlink (install path).`,
        );
      }
      if (img.includes('ghcr.io/atvriders/voltlink')) {
        const mTag = img.match(/\$\{VOLTLINK_IMAGE_TAG:-([^}]+)\}/);
        if (mTag && mTag[1] !== expectedTag) {
          failed = true;
          console.error(
            `✖ ${file}: default image tag is '${mTag[1]}' but package.json version is '${pkg.version}' (expected '${expectedTag}').`,
          );
        }
      }
    }

    if (src.includes('${DATABASE_URL:-')) {
      failed = true;
      console.error(
        `✖ ${file}: interpolates '\${DATABASE_URL:-' — build the bundled URL from POSTGRES_PASSWORD (R2-70).`,
      );
    }

    // Replay the runtime validators against the exported defaults. A default
    // that is structurally fine but that the app rejects still means every
    // role crash-loops out of the box: VL_MASTER_KEY is base64 → 32 bytes
    // (apps/api/src/core/keyring.ts), so a 32-character hex string — the
    // obvious `openssl rand -hex 32`-style value — decodes to 24 bytes and
    // refuses to boot. JWT_SECRET/POSTGRES_PASSWORD are length-gated in
    // core/env.ts; PUBLIC_URL must parse as http(s).
    const secret = (key: string) => parsed.envDefaults.get(key);
    const masterKey = secret('VL_MASTER_KEY');
    if (masterKey !== undefined) {
      const bytes = Buffer.from(masterKey, 'base64').length;
      if (bytes !== 32) {
        failed = true;
        console.error(
          `✖ ${file}: default VL_MASTER_KEY decodes to ${bytes} bytes, not 32 — generate it with 'openssl rand -base64 32' (a hex value is not a base64 key).`,
        );
      }
    }
    const jwtSecret = secret('JWT_SECRET');
    if (jwtSecret !== undefined && jwtSecret.length < 32) {
      failed = true;
      console.error(
        `✖ ${file}: default JWT_SECRET is ${jwtSecret.length} characters; core/env.ts requires 32.`,
      );
    }
    const pgPassword = secret('POSTGRES_PASSWORD');
    if (pgPassword !== undefined && pgPassword.length < 16) {
      failed = true;
      console.error(
        `✖ ${file}: default POSTGRES_PASSWORD is ${pgPassword.length} characters; use at least 16.`,
      );
    }
    const publicUrl = secret('PUBLIC_URL');
    if (publicUrl !== undefined) {
      let ok: boolean;
      try {
        const u = new URL(publicUrl);
        ok = u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        ok = false;
      }
      if (!ok) {
        failed = true;
        console.error(
          `✖ ${file}: default PUBLIC_URL '${publicUrl}' is not an absolute http(s) URL.`,
        );
      }
    }

    const roles = parsed.roles.filter((r) => r.inherits);
    if (roles.length === 0) {
      failed = true;
      console.error(`✖ ${file}: no role inherits the shared app environment anchor.`);
      continue;
    }
    const allowed = new Set([...ENV_KEYS, ...INFRA_ENV]);
    for (const r of roles) {
      const missing = ENV_KEYS.filter((key) => !r.keys.has(key));
      const extra = [...r.keys].filter((key) => !allowed.has(key));
      if (missing.length > 0) {
        failed = true;
        console.error(`✖ ${file} role '${r.role}' is missing: ${missing.join(', ')}`);
      }
      if (extra.length > 0) {
        failed = true;
        console.error(`✖ ${file} role '${r.role}' has keys outside ENV_SPEC: ${extra.join(', ')}`);
      }
      if (!r.keys.has('VL_QUEUE_PREFIX')) {
        failed = true;
        console.error(`✖ ${file} role '${r.role}' is missing VL_QUEUE_PREFIX (R2-49).`);
      }
    }
  }

  const envExample = readFileSync('.env.example', 'utf8');
  for (const line of envExample.split('\n')) {
    // Commented keys (`# VOLTLINK_IMAGE_TAG=v1.1.2`) are documentation, not
    // values; compose already defaults the image reference.
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!m) continue;
    const key = m[1]!;
    if (key === 'DATABASE_URL' || key === 'TEST_DATABASE_ADMIN_URL') {
      failed = true;
      console.error(`✖ .env.example: '${key}' must not be a compose-layer value (R2-70).`);
      continue;
    }
    if (
      (key === 'VOLTLINK_IMAGE_TAG' || key === 'VOLTLINK_IMAGE_DIGEST') &&
      line.slice(key.length + 1).trim() !== ''
    ) {
      failed = true;
      console.error(
        `✖ .env.example: '${key}' must stay empty — compose already defaults the release image reference, and a copied value would pin an old image forever.`,
      );
    }
    if (!(ENV_KEYS as readonly string[]).includes(key) && !ENV_EXAMPLE_INFRA.has(key)) {
      failed = true;
      console.error(`✖ .env.example: key '${key}' is not in ENV_SPEC nor the infra allow-list.`);
    }
  }

  if (failed) process.exit(1);
  console.log('✓ compose files and .env.example pass every structural check.');
}

void main();

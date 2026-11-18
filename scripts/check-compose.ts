// check:compose — proves both compose files pass every ENV_SPEC variable to
// every VoltLink role (I-COMPOSEENV, guide 04 §1/§6). Exits non-zero when a
// variable is missing from a role's MERGED environment (anchor + own keys).
// TI-59: the old checker was a file-wide substring search — a variable deleted
// from the shared &app_env block still passed because it appeared in a comment
// or another role. This version parses the YAML structure (anchors, <<: merges
// and key lines) and checks each role that inherits the app anchor.
import { readFileSync } from 'node:fs';

interface RoleEnv {
  role: string;
  keys: Set<string>;
  inherits: boolean;
}

function parseComposeEnv(src: string): RoleEnv[] {
  const anchors = new Map<string, string[]>();
  const roles = new Map<string, RoleEnv>();
  const lines = src.split('\n');
  let role = '';
  let inEnv = false;
  let inAnchor: string | null = null;

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
    // Service header (2-space indent, lowercase name).
    const mRole = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (mRole) {
      role = mRole[1]!;
      inEnv = false;
      inAnchor = null;
      continue;
    }
    // Anchored environment map: keys below belong to the anchor (and to this
    // role, which is the map itself in YAML).
    const mAnchor = line.match(/^\s*environment:\s*&(\w+)\s*$/);
    if (mAnchor) {
      inEnv = true;
      inAnchor = mAnchor[1]!;
      anchors.set(inAnchor, []);
      continue;
    }
    const mEnv = line.match(/^\s*environment:\s*$/);
    if (mEnv) {
      inEnv = true;
      inAnchor = null;
      continue;
    }
    // <<: *anchor merge.
    const mInherit = line.match(/^\s*<<:\s*\*(\w+)\s*$/);
    if (inEnv && mInherit) {
      const r = roleOf();
      if (r) {
        r.inherits = true;
        for (const k of anchors.get(mInherit[1]!) ?? []) r.keys.add(k);
      }
      continue;
    }
    // An environment key line.
    const mKey = line.match(/^\s{4}([A-Za-z_][A-Za-z0-9_]*):/);
    if (inEnv && mKey) {
      const key = mKey[1]!;
      if (inAnchor) anchors.get(inAnchor)!.push(key);
      const r = roleOf();
      if (r) r.keys.add(key);
      continue;
    }
    // Anything else at column 0 resets parsing state (comments, top-level keys).
    if (/^\S/.test(line) && !/^#/.test(line)) {
      inEnv = false;
      inAnchor = null;
    }
  }
  return [...roles.values()];
}

async function main(): Promise<void> {
  const { ENV_KEYS } = await import('../apps/api/src/core/env-spec');
  const files = ['compose.production.yml', 'docker-compose.yml'];
  let failed = false;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const roles = parseComposeEnv(src).filter((r) => r.inherits);
    if (roles.length === 0) {
      failed = true;
      console.error(`✖ ${file}: no role inherits the shared app environment anchor.`);
      continue;
    }
    for (const r of roles) {
      const missing = ENV_KEYS.filter((key) => !r.keys.has(key));
      if (missing.length > 0) {
        failed = true;
        console.error(`✖ ${file} role '${r.role}' is missing: ${missing.join(', ')}`);
      }
    }
    if (!failed) {
      console.log(
        `✓ ${file} passes every ${ENV_KEYS.length} ENV_SPEC variable(s) to ${roles.length} role(s).`,
      );
    }
  }
  if (failed) process.exit(1);
}

void main();

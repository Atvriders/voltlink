// Builds the outbound policy once per process (guide 03 §2). A parse error in
// VL_OUTBOUND_ALLOW must fail boot (validateEnv calls outboundPolicy()); the
// infrastructure set holds every DNS answer of the DATABASE_URL and REDIS_URL
// hosts with their ports, so VoltLink's own services are always denied.

import dns from 'node:dns';
import { parseAllowlist, type OutboundPolicy } from './outboundPolicy';

let cached: OutboundPolicy | null = null;

async function infrastructureEntries(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const [raw, defaultPort] of [
    [process.env.DATABASE_URL, 5432],
    [process.env.REDIS_URL, 6379],
  ] as const) {
    if (!raw) continue;
    try {
      const u = new URL(raw);
      const port = u.port ? Number(u.port) : defaultPort;
      const host = u.hostname.replace(/^\[|\]$/g, '');
      const answers = await dns.promises.lookup(host, { all: true });
      for (const a of answers) out.add(`${a.address}:${port}`);
    } catch {
      /* host may be a socket path or unresolvable — nothing to deny */
    }
  }
  return out;
}

export async function buildOutboundPolicy(): Promise<OutboundPolicy> {
  if (cached) return cached;
  const allow = parseAllowlist(process.env.VL_OUTBOUND_ALLOW);
  const infrastructure = await infrastructureEntries();
  cached = { allow, infrastructure };
  return cached;
}

/** Synchronous policy handle used by boot validation and by callers that must
 * not resolve DNS on every request. Call after buildOutboundPolicy(). */
export function outboundPolicySync(): OutboundPolicy {
  if (!cached) {
    cached = { allow: parseAllowlist(process.env.VL_OUTBOUND_ALLOW), infrastructure: new Set() };
  }
  return cached;
}

export function resetOutboundPolicy(): void {
  cached = null;
}

/** Policy handle for send paths. The boot sequence builds it; anything that
 * sends before boot (never in production: sends run in the worker role) fails
 * closed with a clear error. */
export function getOutboundPolicy(): OutboundPolicy {
  // Boot builds the full policy (with infrastructure entries) in index/worker;
  // other callers (e.g. save-time preflight on the web role) get the sync part.
  if (!cached) {
    cached = { allow: parseAllowlist(process.env.VL_OUTBOUND_ALLOW), infrastructure: new Set() };
  }
  return cached;
}

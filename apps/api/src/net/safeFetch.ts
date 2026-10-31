// SSRF-safe fetch (N-SSRF, guide 03 §2). Every request to a user-supplied URL
// goes through safeFetch(): the IP policy runs inside the socket's DNS lookup
// (no rebinding window), redirects are never followed, and time and size are
// capped.

import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch } from 'undici';
import { assertAddressAllowed, OutboundBlockedError, type OutboundPolicy } from './outboundPolicy';

export const LIMITS = {
  connectMs: 5_000,
  headersMs: 10_000,
  bodyMs: 10_000,
  totalMs: 15_000,
  maxResponseBytes: 64 * 1024,
  maxRequestBytes: 256 * 1024,
};

function guardedLookup(policy: OutboundPolicy, scheme: 'http:' | 'https:', port: number): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 4);
      try {
        for (const a of addresses) assertAddressAllowed(policy, a.address, port, scheme); // any bad answer => fail closed
      } catch (e) {
        return callback(e as NodeJS.ErrnoException, '', 4);
      }
      if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addresses); // autoSelectFamily path
      const first = addresses[0]!;
      return callback(null, first.address, first.family);
    });
  };
}

const agents = new Map<string, Agent>();
function agentFor(policy: OutboundPolicy, scheme: 'http:' | 'https:', port: number): Agent {
  const key = `${scheme}${port}`;
  let a = agents.get(key);
  if (!a) {
    a = new Agent({
      connect: { timeout: LIMITS.connectMs, lookup: guardedLookup(policy, scheme, port) },
      headersTimeout: LIMITS.headersMs,
      bodyTimeout: LIMITS.bodyMs,
      maxResponseSize: LIMITS.maxResponseBytes,
      connections: 8,
    });
    agents.set(key, a);
  }
  return a;
}

export interface SafeResponse { status: number; headers: Record<string, string>; bodyText: string }

export async function safeFetch(
  policy: OutboundPolicy,
  rawUrl: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {},
): Promise<SafeResponse> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OutboundBlockedError('scheme', url.protocol);
  if (url.username || url.password) throw new OutboundBlockedError('host', 'credentials in URL are not allowed');
  const scheme = url.protocol as 'http:' | 'https:';
  const port = url.port ? Number(url.port) : scheme === 'https:' ? 443 : 80;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) assertAddressAllowed(policy, host, port, scheme); // literals never reach lookup()
  const size = init.body === undefined ? 0 : typeof init.body === 'string' ? Buffer.byteLength(init.body) : init.body.byteLength;
  if (size > LIMITS.maxRequestBytes) throw new Error(`request body too large (${size} bytes)`);
  const res = await fetch(url, {
    method: init.method ?? 'POST',
    headers: { 'user-agent': 'VoltLink-Notifier/1 (+https://github.com/Atvriders/voltlink)', ...init.headers },
    body: init.body,
    redirect: 'manual',
    dispatcher: agentFor(policy, scheme, port),
    signal: AbortSignal.timeout(LIMITS.totalMs),
  });
  const bodyText = (await res.text()).slice(0, 2048); // always consume: frees the socket; maxResponseSize caps it
  return { status: res.status, headers: Object.fromEntries(res.headers), bodyText };
}

export function failureKindOf(err: unknown): 'blocked_by_policy' | 'timeout' | 'dns' | 'network' | 'response_too_large' {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  const code = e.code ?? e.cause?.code;
  if (err instanceof OutboundBlockedError || code === 'VL_OUTBOUND_BLOCKED') return 'blocked_by_policy';
  if (e.name === 'TimeoutError' || ((code ?? '').startsWith('UND_ERR_') && (code ?? '').endsWith('TIMEOUT'))) return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'UND_ERR_RES_EXCEEDED_MAX_SIZE') return 'response_too_large';
  return 'network';
}

/** Save-time preflight: resolve the URL and check every answer. Send time stays
 * authoritative because DNS can change. */
export async function preflightUrl(policy: OutboundPolicy, rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OutboundBlockedError('scheme', url.protocol);
  if (url.username || url.password) throw new OutboundBlockedError('host', 'credentials in URL are not allowed');
  const scheme = url.protocol as 'http:' | 'https:';
  const port = url.port ? Number(url.port) : scheme === 'https:' ? 443 : 80;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    assertAddressAllowed(policy, host, port, scheme);
    return;
  }
  const answers = await dns.promises.lookup(host, { all: true });
  for (const a of answers) assertAddressAllowed(policy, a.address, port, scheme);
}

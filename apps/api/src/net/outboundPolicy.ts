// Outbound IP policy (N-SSRF, guide 03 §2). Classifies addresses against the
// IANA special-purpose registries, parses the VL_OUTBOUND_ALLOW owner
// allowlist and decides whether an address may be connected to.

import net from 'node:net';

export type DenyReason =
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'cgnat'
  | 'link_local'
  | 'ula'
  | 'multicast'
  | 'reserved'
  | 'documentation'
  | 'benchmark'
  | 'translated'
  | 'infrastructure'
  | 'scheme'
  | 'host';

export class OutboundBlockedError extends Error {
  readonly code = 'VL_OUTBOUND_BLOCKED';
  readonly reason: DenyReason;
  constructor(reason: DenyReason, detail: string) {
    super(`Outbound request blocked (${reason}): ${detail}`);
    this.reason = reason;
  }
}

type Rule = [
  network: string,
  prefix: number,
  reason: Exclude<DenyReason, 'infrastructure' | 'scheme' | 'host'>,
];
const RULES: Rule[] = [
  // IANA special-purpose registries + multicast; 240/4 includes 255.255.255.255
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link_local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.31.196.0', 24, 'reserved'],
  ['192.52.193.0', 24, 'reserved'],
  ['192.88.99.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['192.175.48.0', 24, 'reserved'],
  ['198.18.0.0', 15, 'benchmark'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
  ['::', 96, 'reserved'],
  ['::1', 128, 'loopback'],
  ['64:ff9b:1::', 48, 'translated'],
  ['100::', 64, 'reserved'],
  ['2001::', 23, 'reserved'],
  ['2001:db8::', 32, 'documentation'],
  ['2002::', 16, 'translated'],
  ['3fff::', 20, 'documentation'],
  ['5f00::', 16, 'reserved'],
  ['fc00::', 7, 'ula'],
  ['fe80::', 10, 'link_local'],
  ['fec0::', 10, 'reserved'],
  ['ff00::', 8, 'multicast'],
];

const lists = new Map<Exclude<DenyReason, 'infrastructure' | 'scheme' | 'host'>, net.BlockList>();
for (const [addr, prefix, reason] of RULES) {
  const bl = lists.get(reason) ?? new net.BlockList();
  bl.addSubnet(addr, prefix, addr.includes(':') ? 'ipv6' : 'ipv4');
  lists.set(reason, bl);
}
const ORDER = [
  'loopback',
  'unspecified',
  'link_local',
  'multicast',
  'documentation',
  'benchmark',
  'translated',
  'ula',
  'cgnat',
  'private',
  'reserved',
] as const;
const NEVER_ALLOWABLE = new Set<Exclude<DenyReason, 'infrastructure' | 'scheme' | 'host'>>([
  'unspecified',
  'link_local',
  'multicast',
  'reserved',
  'documentation',
  'benchmark',
  'translated',
]);

/** ::ffff:a.b.c.d (IPv4-mapped) and 64:ff9b::/96 (NAT64) carry an IPv4 address; judge that address. */
export function embeddedIPv4(ip: string): string | null {
  if (net.isIP(ip) !== 6) return null;
  const norm = new net.SocketAddress({ address: ip, family: 'ipv6' }).address;
  const m = /^(?:::ffff:|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(
    norm,
  );
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2]!, 16);
  const lo = parseInt(m[3]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function classify(ip: string): DenyReason | 'public' {
  const v4 = net.isIP(ip) === 4 ? ip : embeddedIPv4(ip);
  const addr = v4 ?? ip;
  if (net.isIP(addr) === 0) return 'reserved';
  for (const reason of ORDER) {
    try {
      if (lists.get(reason)?.check(addr, v4 ? 'ipv4' : 'ipv6')) return reason;
    } catch {
      return 'reserved';
    }
  }
  return 'public';
}

interface AllowEntry {
  list: net.BlockList;
  family: 'ipv4' | 'ipv6';
  portLo: number;
  portHi: number;
  explicitPort: boolean;
}
export interface OutboundPolicy {
  allow: AllowEntry[];
  infrastructure: Set<string>;
}

export function parseAllowlist(raw: string | undefined): AllowEntry[] {
  return (raw ?? '')
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((text) => {
      const m = /^\[?([0-9a-fA-F:.]+)\]?\/(\d{1,3})(?::(\d{1,5})(?:-(\d{1,5}))?)?$/.exec(text);
      if (!m)
        throw new Error(`VL_OUTBOUND_ALLOW: cannot parse "${text}" (expected CIDR[:port[-port]])`);
      const [, network, prefixS, p1, p2] = m;
      const family = net.isIP(network!) === 6 ? 'ipv6' : net.isIP(network!) === 4 ? 'ipv4' : null;
      if (!family) throw new Error(`VL_OUTBOUND_ALLOW: "${network}" is not an IP network`);
      const reason = classify(network!);
      if (reason !== 'public' && NEVER_ALLOWABLE.has(reason as never))
        throw new Error(`VL_OUTBOUND_ALLOW: ${text} is ${reason}; it can never be allowed`);
      if (reason === 'loopback' && !p1)
        throw new Error(`VL_OUTBOUND_ALLOW: loopback entry ${text} must name a port`);
      if (Number(prefixS) < (family === 'ipv4' ? 8 : 32))
        throw new Error(`VL_OUTBOUND_ALLOW: ${text} is too broad`);
      const list = new net.BlockList();
      list.addSubnet(network!, Number(prefixS), family);
      const portLo = p1 ? Number(p1) : 1;
      const portHi = p2 ? Number(p2) : p1 ? Number(p1) : 65535;
      if (portLo < 1 || portHi > 65535 || portLo > portHi)
        throw new Error(`VL_OUTBOUND_ALLOW: bad port range in "${text}"`);
      return { list, family, portLo, portHi, explicitPort: !!p1 };
    });
}

/** Assert a connected address is allowed. IP literals pass through here before
 * connecting (net.connect never calls lookup for them); hostnames pass through
 * guardedLookup inside the socket's DNS lookup. */
export function assertAddressAllowed(
  policy: OutboundPolicy,
  addr: string,
  port: number,
  scheme: 'http:' | 'https:',
): void {
  if (policy.infrastructure.has(`${addr}:${port}`))
    throw new OutboundBlockedError('infrastructure', `${addr}:${port}`);
  const reason = classify(addr);
  if (reason === 'public') {
    if (scheme !== 'https:')
      throw new OutboundBlockedError('scheme', `${scheme} to a public address is not allowed`);
    return;
  }
  const allowlisted = policy.allow.some((a) => {
    try {
      return a.list.check(addr, a.family) && port >= a.portLo && port <= a.portHi;
    } catch {
      return false;
    }
  });
  if (NEVER_ALLOWABLE.has(reason as never) || !allowlisted)
    throw new OutboundBlockedError(reason, `${addr}:${port}`);
}

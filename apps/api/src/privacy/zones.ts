// Privacy zones: in-zone coordinates are redacted at ingest and retroactively
// by a queue job. Never logs coordinates. (Z-PRIVZONE, guide 05 §7.1/§7.2)

import { prisma } from '../core/db';
import { haversineKm } from '../core/geo';

export type ZoneLite = { id: string; name: string; lat: number; lon: number; radiusM: number };

export const zoneAt = (
  zones: readonly ZoneLite[],
  lat?: number | null,
  lon?: number | null,
): ZoneLite | null =>
  typeof lat === 'number' && typeof lon === 'number'
    ? (zones.find((z) => haversineKm(lat, lon, z.lat, z.lon) * 1000 <= z.radiusM) ?? null)
    : null;

export function redactState<
  T extends { lat?: number | null; lon?: number | null; address?: string | null },
>(s: T, z: ZoneLite | null) {
  return z
    ? { ...s, lat: null, lon: null, address: null, privacyZoneId: z.id, privacyZoneName: z.name }
    : s;
}

// 30 s in-process TTL cache, invalidated on every zone write. The retroactive
// job is delayed 60 s (> TTL) so it never misses a just-changed zone.
const cache = new Map<string, { at: number; zones: ZoneLite[] }>();
const TTL_MS = 30_000;

export async function zonesForOrg(organizationId: string): Promise<ZoneLite[]> {
  const hit = cache.get(organizationId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.zones;
  const rows = await prisma.privacyZone.findMany({
    where: { organizationId, enabled: true },
    select: { id: true, name: true, lat: true, lon: true, radiusM: true },
  });
  cache.set(organizationId, { at: Date.now(), zones: rows });
  return rows;
}

export function invalidateZonesForOrg(organizationId: string): void {
  cache.delete(organizationId);
}

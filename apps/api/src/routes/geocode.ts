// Location search (guide 07 §1.4, F-NOUI): Photon or Nominatim via env only
// (no SSRF surface), 1 req/s per user, 10-minute cache, queries never logged.

import { policyRouter, sessionActor } from '../authz/policy';
import { env } from '../core/env';
import { APP_VERSION } from '@voltlink/shared';

export const geocodeRouter = policyRouter('/api/v1/geocode');

const lastCall = new Map<string, number>();
const cache = new Map<string, { at: number; body: unknown }>();

export interface GeocodeResult {
  label: string;
  lat: number;
  lon: number;
  kind: string;
}

geocodeRouter.get('/', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const mode = process.env.VL_GEOCODER ?? 'off';
  if (mode === 'off' || !process.env.VL_GEOCODER_URL) {
    res.status(404).json({ error: { code: 'GEOCODER_DISABLED', message: 'Location search is disabled.' } });
    return;
  }
  const q = String(req.query.q ?? '').trim();
  if (q.length < 3) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'At least 3 characters are required.' } });
    return;
  }
  const userId = sessionActor(req).userId;
  const now = Date.now();
  const last = lastCall.get(userId) ?? 0;
  if (now - last < 1000) {
    res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'One search per second.' } });
    return;
  }
  lastCall.set(userId, now);
  const cacheKey = `${mode}:${q.toLowerCase()}`;
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < 10 * 60_000) {
    res.json({ data: hit.body });
    return;
  }
  const base = String(process.env.VL_GEOCODER_URL).replace(/\/$/, '');
  const ua = `VoltLink/${APP_VERSION} (+${env.PUBLIC_URL})`;
  const near = String(req.query.near ?? '');
  const [nlat, nlon] = near.split(',').map((x) => Number(x.trim()));
  try {
    let results: GeocodeResult[];
    if (mode === 'nominatim') {
      const u = new URL(`${base}/search`);
      u.searchParams.set('q', q);
      u.searchParams.set('format', 'jsonv2');
      u.searchParams.set('limit', '5');
      if (Number.isFinite(nlat) && Number.isFinite(nlon)) {
        u.searchParams.set('lat', String(nlat));
        u.searchParams.set('lon', String(nlon));
      }
      const r = await fetch(u, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': ua } });
      if (!r.ok) throw new Error(`geocoder ${r.status}`);
      const body = (await r.json()) as { display_name: string; lat: string; lon: string; type?: string }[];
      results = body.map((x) => ({
        label: x.display_name,
        lat: Number(x.lat),
        lon: Number(x.lon),
        kind: x.type ?? 'place',
      }));
    } else {
      const u = new URL(`${base}/api`);
      u.searchParams.set('q', q);
      u.searchParams.set('limit', '5');
      u.searchParams.set('lang', 'en');
      if (Number.isFinite(nlat) && Number.isFinite(nlon)) {
        u.searchParams.set('lat', String(nlat));
        u.searchParams.set('lon', String(nlon));
      }
      const r = await fetch(u, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': ua } });
      if (!r.ok) throw new Error(`geocoder ${r.status}`);
      const body = (await r.json()) as {
        features: { properties: { name?: string; street?: string; city?: string; country?: string }; geometry: { coordinates: number[] } }[];
      };
      results = body.features.map((f) => ({
        label: [f.properties.name, f.properties.street, f.properties.city, f.properties.country]
          .filter(Boolean)
          .join(', '),
        // GeoJSON order is [lon, lat].
        lon: f.geometry.coordinates[0] ?? 0,
        lat: f.geometry.coordinates[1] ?? 0,
        kind: f.properties.name ? 'poi' : 'address',
      }));
    }
    cache.set(cacheKey, { at: now, body: results });
    res.json({ data: results });
  } catch (err) {
    // Never log the query — location queries are personal data.
    console.error('[voltlink] geocode failed:', (err as Error).message);
    res.status(502).json({ error: { code: 'GEOCODER_ERROR', message: 'The location service is unavailable.' } });
  }
});

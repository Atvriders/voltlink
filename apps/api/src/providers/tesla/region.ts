// Region discovery (guide 01 §5): ask users/region, trying NA then EU; a 421
// from one region means "try the other". China accounts are refused (451).

import { z } from 'zod';
import { assertTeslaBase, regionBase } from './config';
import { classify } from './classify';

const UsersRegion = z.looseObject({
  response: z.looseObject({ region: z.string(), fleet_api_base_url: z.url() }),
});

export async function discoverRegion(
  accessToken: string,
  ouCode?: string,
): Promise<{ region: string; baseUrl: string }> {
  const order: Array<'na' | 'eu'> = ouCode?.toLowerCase() === 'eu' ? ['eu', 'na'] : ['na', 'eu'];
  for (const r of order) {
    const res = await fetch(`${regionBase(r)}/api/1/users/region`, {
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    });
    if (res.status === 421) continue; // "Incorrect region"
    if (!res.ok) throw classify(res.status, await res.text().catch(() => ''), res.headers);
    const { response } = UsersRegion.parse(await res.json());
    const baseUrl = assertTeslaBase(response.fleet_api_base_url);
    if (new URL(baseUrl).hostname.endsWith('.tesla.cn')) {
      throw new TeslaApiError(451, 'legal_region', 'China accounts need a developer.tesla.cn app');
    }
    return { region: response.region, baseUrl };
  }
  throw new TeslaApiError(421, 'wrong_region', 'users/region returned 421 in every region');
}

import { TeslaApiError } from './classify';

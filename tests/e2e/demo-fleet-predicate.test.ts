// demo-fleet-predicate.test.ts — R2-16 / C-E2EHOLLOW: the predicate must be
// able to fail. These cases mirror the hollow-out bug: a fleet the session
// can SEE is not necessarily the user's OWN five demo vehicles.
import { describe, expect, it } from 'vitest';
import { demoFleetPredicate, type DemoFleetVehicle } from './demo-fleet-predicate';

const orgId = 'org-own';
const accountId = 'acct-demo';

function own(count: number): DemoFleetVehicle[] {
  return Array.from({ length: count }, (_, i) => ({
    organizationId: orgId,
    providerAccountId: accountId,
    demo: true,
    state: { status: 'online' },
    id: `v${i}`,
  }));
}

describe('demoFleetPredicate (R2-16 / C-E2EHOLLOW)', () => {
  const memberships = [{ organizationId: orgId, kind: 'PERSONAL', role: 'OWNER' }];

  it('accepts exactly five own demo vehicles with state', () => {
    expect(demoFleetPredicate({ accountId, memberships, vehicles: own(5) })).toBe(true);
  });

  it('rejects six vehicles (the count alone is not ownership)', () => {
    expect(demoFleetPredicate({ accountId, memberships, vehicles: own(6) })).toBe(false);
  });

  it('rejects a fleet with one foreign organizationId', () => {
    const vehicles = own(4);
    vehicles.push({ ...own(1)[0]!, organizationId: 'org-foreign' });
    expect(demoFleetPredicate({ accountId, memberships, vehicles })).toBe(false);
  });

  it('rejects five vehicles belonging to a shared org (no PERSONAL OWNER membership)', () => {
    expect(
      demoFleetPredicate({
        accountId,
        memberships: [{ organizationId: orgId, kind: 'TEAM', role: 'OWNER' }],
        vehicles: own(5),
      }),
    ).toBe(false);
  });

  it('rejects a vehicle from another provider account', () => {
    const vehicles = own(4);
    vehicles.push({ ...own(1)[0]!, providerAccountId: 'acct-other' });
    expect(demoFleetPredicate({ accountId, memberships, vehicles })).toBe(false);
  });

  it('rejects a vehicle without state (unprovisioned fleet)', () => {
    const vehicles = own(4);
    vehicles.push({ ...own(1)[0]!, state: null });
    expect(demoFleetPredicate({ accountId, memberships, vehicles })).toBe(false);
  });

  it('rejects a non-demo vehicle', () => {
    const vehicles = own(4);
    vehicles.push({ ...own(1)[0]!, demo: false });
    expect(demoFleetPredicate({ accountId, memberships, vehicles })).toBe(false);
  });
});

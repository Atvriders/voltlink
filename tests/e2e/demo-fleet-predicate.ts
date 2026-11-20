// demo-fleet-predicate.ts — R2-16 / C-E2EHOLLOW: the pure ownership check for
// the demo fleet, unit-tested separately so it CAN fail (the old enableDemo
// counted whatever the session could see and never checked ownership).
//
// Spec (review #2 point 11): after POST /providers/demo/connect returns
// accountId, the user must have EXACTLY one ACTIVE PERSONAL membership with
// role OWNER, and EXACTLY five demo vehicles that all belong to that same
// organization, that provider account, with demo=true and a non-null state.

export interface DemoFleetMembership {
  organizationId: string;
  kind: string;
  role: string;
}

export interface DemoFleetVehicle {
  organizationId?: string;
  providerAccountId?: string;
  demo?: boolean;
  state?: unknown;
}

export interface DemoFleetCheck {
  accountId: string;
  memberships: DemoFleetMembership[];
  vehicles: DemoFleetVehicle[];
}

export function demoFleetPredicate({ accountId, memberships, vehicles }: DemoFleetCheck): boolean {
  const owners = memberships.filter((m) => m.kind === 'PERSONAL' && m.role === 'OWNER');
  if (owners.length !== 1) return false;
  const orgId = owners[0]!.organizationId;
  if (vehicles.length !== 5) return false;
  return vehicles.every(
    (v) =>
      v.organizationId === orgId &&
      v.providerAccountId === accountId &&
      v.demo === true &&
      v.state != null,
  );
}

// R4: authz/access.ts coverage — the operator-organization branches need an
// operatorOrgId row to exist before getOperatorOrgId caches anything, so they
// live in their own fork file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { hashPassword, randomId } from '../src/core/crypto';
import {
  assertOperator,
  assertOrgPermission,
  getOperatorOrgId,
  orgPermissions,
} from '../src/authz/access';
import type { Actor } from '../src/authz/types';

let operatorOrgId = '';

beforeAll(async () => {
  await initRedis();
  const org = await prisma.organization.create({ data: { name: 'Operators', kind: 'OPERATOR' } });
  operatorOrgId = org.id;
  await prisma.appSetting.create({
    data: { key: 'instance.operatorOrgId', value: org.id },
  });
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

const mkUser = async (email: string) =>
  prisma.user.create({
    data: {
      email,
      name: email.split('@')[0]!,
      passwordHash: await hashPassword('long-enough-123'),
      webauthnUserId: randomId(),
    },
  });

const sessionActor = (userId: string, isInstanceAdmin = false): Actor => ({
  kind: 'session',
  userId,
  sessionId: randomId(),
  isInstanceAdmin,
  emailVerified: true,
  mfaEnrolled: true,
  stepUpAt: null,
  stepUpMethod: null,
});

const systemActor: Actor = { kind: 'system', job: 'retention' };

describe('operator org branches', () => {
  it('getOperatorOrgId reads the row and caches it', async () => {
    expect(await getOperatorOrgId()).toBe(operatorOrgId);
    expect(await getOperatorOrgId()).toBe(operatorOrgId); // cache hit
  });

  it('keeps operator-only permissions in the operator org', async () => {
    const u = await mkUser(`op1.${Date.now()}@t.dev`);
    await prisma.membership.create({
      data: { organizationId: operatorOrgId, userId: u.id, role: 'STATUS_MANAGER' },
    });
    const perms = await orgPermissions(sessionActor(u.id), operatorOrgId);
    expect(perms.has('status.manage')).toBe(true);
    expect(perms.has('incidents.manage')).toBe(true);
    expect(perms.has('org.manage')).toBe(false);
  });

  it('assertOperator: instance admin, system, permitted and denied sessions', async () => {
    await expect(
      assertOperator(sessionActor('any', true), 'status.manage'),
    ).resolves.toBeUndefined();
    await expect(assertOperator(systemActor, 'status.manage')).resolves.toBeUndefined();

    const owner = await mkUser(`op2.${Date.now()}@t.dev`);
    await prisma.membership.create({
      data: { organizationId: operatorOrgId, userId: owner.id, role: 'OWNER' },
    });
    await expect(assertOperator(sessionActor(owner.id), 'status.manage')).resolves.toBeUndefined();

    const viewer = await mkUser(`op3.${Date.now()}@t.dev`);
    await prisma.membership.create({
      data: { organizationId: operatorOrgId, userId: viewer.id, role: 'VIEWER' },
    });
    await expect(assertOperator(sessionActor(viewer.id), 'status.manage')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    // Non-member: the org itself is hidden.
    const stranger = await mkUser(`op4.${Date.now()}@t.dev`);
    await expect(assertOperator(sessionActor(stranger.id), 'status.manage')).rejects.toThrow(
      /Organization not found/,
    );

    const perms = await assertOrgPermission(sessionActor(owner.id), operatorOrgId, 'status.manage');
    expect(perms.has('status.manage')).toBe(true);
  });
});

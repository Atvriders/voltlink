// R4: auth service coverage — direct unit tests for the branches the route
// suites do not reach: open/invite/closed registration, setup bootstrap,
// verification mail, TOTP and recovery-code flows, passkey ceremonies and
// session/reset plumbing. Drives auth/** toward its 90% line gate.

// vi.hoisted runs before the static imports below, so env.ts reads
// these values when the service module is first imported.
const envs = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.MAIL_TO_CONSOLE = 'true';
  process.env.SMTP_URL = 'smtp://127.0.0.1:1025';
  process.env.VL_SETUP_TOKEN = 'cov-setup-token-0123456789abcdef0123456789abcdef';
});
void envs;

// The verify* functions from @simplewebauthn/server need a real authenticator,
// so they are mocked here (the options generators stay real). This lets the
// passkey success paths run end to end.
const wb = vi.hoisted(() => ({ vAuth: vi.fn(), vReg: vi.fn() }));
// TI-14: never open a real SMTP socket (the old run ECONNREFUSED on 127.0.0.1:
// 1025). nodemailer is replaced so sendMail's 'smtp' branch resolves offline.
const mailMock = vi.hoisted(() => ({
  sent: vi.fn().mockResolvedValue({ accepted: ['a@b.c'], response: '250 ok' }),
}));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: mailMock.sent }) },
  createTransport: () => ({ sendMail: mailMock.sent }),
}));
vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@simplewebauthn/server')>();
  return {
    ...mod,
    verifyAuthenticationResponse: wb.vAuth,
    verifyRegistrationResponse: wb.vReg,
  };
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TOTP, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib';
import * as authSvc from '../src/auth/service';
import type { Request } from 'express';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId, hashPassword, sha256hex } from '../src/core/crypto';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { createCeremony } from '../src/auth/ceremony';
import { userKey } from '../src/auth/throttle';
import {
  registerUser,
  bootstrapInstanceAdmin,
  setupStatus,
  requestVerificationFor,
  verifyEmail,
  createVerification,
  createSession,
  createMfaCeremony,
  recoveryCodeHash,
  publicUser,
  login,
  loginMfa,
  requestPasswordReset,
  resetPassword,
  totpSetup,
  totpConfirm,
  totpDisable,
  regenerateRecoveryCodes,
  consumeRecoveryCode,
  listSessions,
  revokeAllOtherSessions,
  touchSession,
  sendMail,
  passkeyRegistrationOptions,
  passkeyLoginOptions,
  passkeyStepUpOptions,
  verifyPasskeyRegistration,
  verifyTotpForUser,
  passkeyLogin,
  deletePasskey,
  stepUp,
  revokeSession,
  setRegistrationMode,
} from '../src/auth/service';

const moduleTotp = new TOTP({ crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() });

beforeAll(async () => {
  await initRedis();
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

async function mkUser(email: string, extra: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email,
      name: email.split('@')[0]!,
      passwordHash: await hashPassword('correct-horse-battery'),
      webauthnUserId: randomId(),
      emailVerifiedAt: new Date(),
      ...extra,
    },
  });
}

describe('setup and registration modes', () => {
  it('bootstraps the instance admin and rejects bad inputs', async () => {
    await prisma.appSetting.deleteMany({
      where: {
        key: {
          in: [
            'instance.bootstrappedAt',
            'instance.operatorOrgId',
            'instance.registrationMode',
            'instance.setupTokenHash',
          ],
        },
      },
    });
    await expect(
      bootstrapInstanceAdmin({
        email: 'not-an-email',
        name: '',
        password: 'long-enough-123',
        setupToken: 'x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
    await expect(
      bootstrapInstanceAdmin({
        email: `bs.${Date.now()}@test.dev`,
        name: '',
        password: 'short',
        setupToken: 'x',
      }),
    ).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    await expect(
      bootstrapInstanceAdmin({
        email: `bs.${Date.now()}@test.dev`,
        name: '',
        password: 'long-enough-123',
        setupToken: 'wrong-token-wrong-token-wrong-token!',
      }),
    ).rejects.toMatchObject({ code: 'SETUP_TOKEN_INVALID' });

    const email = `bs.${Date.now()}@test.dev`;
    const { user } = await bootstrapInstanceAdmin({
      email,
      name: '  ',
      password: 'long-enough-123',
      setupToken: process.env.VL_SETUP_TOKEN!,
    });
    expect(user.email).toBe(email);
    expect(user.name).toBe(email.split('@')[0]);
    await expect(
      bootstrapInstanceAdmin({
        email: `bs2.${Date.now()}@test.dev`,
        name: '',
        password: 'long-enough-123',
        setupToken: process.env.VL_SETUP_TOKEN!,
      }),
    ).rejects.toMatchObject({ code: 'SETUP_COMPLETE' });
    // After bootstrap the instance is no longer in setup mode.
    expect((await setupStatus()).needsSetup).toBe(false);
    await prisma.organization.delete({
      where: {
        id: (
          await prisma.appSetting.findUniqueOrThrow({ where: { key: 'instance.operatorOrgId' } })
        ).value,
      },
    });
    await prisma.appSetting.deleteMany({
      where: {
        key: {
          in: ['instance.bootstrappedAt', 'instance.operatorOrgId', 'instance.registrationMode'],
        },
      },
    });
    // Re-seed a bootstrapped state like the tenancy migration would, so the
    // remaining suites in this worker DB behave normally.
    const org = await prisma.organization.create({
      data: {
        kind: 'OPERATOR',
        name: 'VoltLink operators',
        memberships: { create: { userId: user.id, role: 'OWNER' } },
      },
    });
    await prisma.appSetting.upsert({
      where: { key: 'instance.operatorOrgId' },
      update: { value: org.id },
      create: { key: 'instance.operatorOrgId', value: org.id },
    });
    await prisma.appSetting.upsert({
      where: { key: 'instance.bootstrappedAt' },
      update: { value: new Date().toISOString() },
      create: { key: 'instance.bootstrappedAt', value: new Date().toISOString() },
    });
  });

  it('enforces invite mode tokens and registers via a valid invitation', async () => {
    await prisma.appSetting.upsert({
      where: { key: 'instance.registrationMode' },
      update: { value: 'invite' },
      create: { key: 'instance.registrationMode', value: 'invite' },
    });
    const host = await mkUser(`host.${Date.now()}@test.dev`);
    const org = await prisma.organization.create({
      data: {
        kind: 'PERSONAL',
        name: 'Host',
        createdById: host.id,
        memberships: { create: { userId: host.id, role: 'OWNER' } },
      },
    });
    const email = `inv.${Date.now()}@test.dev`;
    const token = `inv-${randomId()}`;
    await prisma.invitation.create({
      data: {
        organizationId: org.id,
        kind: 'membership',
        email,
        role: 'ADMIN',
        tokenHash: sha256hex(token),
        invitedById: host.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });

    await expect(
      registerUser({ email: 'bad-email', name: 'I', password: 'long-enough-123' }),
    ).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
    await expect(
      registerUser({ email, name: 'I', password: 'long-enough-123' }),
    ).rejects.toMatchObject({ code: 'INVITE_REQUIRED' });
    await expect(
      registerUser({
        email,
        name: 'I',
        password: 'long-enough-123',
        inviteToken: 'wrong',
      }),
    ).rejects.toMatchObject({ code: 'INVITE_REQUIRED' });
    await expect(
      registerUser({
        email: 'other@test.dev',
        name: 'I',
        password: 'long-enough-123',
        inviteToken: token,
      }),
    ).rejects.toMatchObject({ code: 'INVITE_REQUIRED' });

    const result = await registerUser({
      email,
      name: 'Invitee',
      password: 'long-enough-123',
      inviteToken: token,
    });
    expect(result.kind).toBe('created');
    // A fresh invitation for an already-registered email is refused as taken.
    const token2 = `inv2-${randomId()}`;
    await prisma.invitation.create({
      data: {
        organizationId: org.id,
        kind: 'membership',
        email,
        role: 'ADMIN',
        tokenHash: sha256hex(token2),
        invitedById: host.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    await expect(
      registerUser({ email, name: 'I', password: 'long-enough-123', inviteToken: token2 }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
    // The invite is consumed; a second registration is refused.
    await expect(
      registerUser({
        email,
        name: 'Again',
        password: 'long-enough-123',
        inviteToken: token,
      }),
    ).rejects.toMatchObject({ code: 'INVITE_REQUIRED' });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.deleteMany({
      where: { id: { in: [host.id, result.kind === 'created' ? result.user.id : ''] } },
    });
  });

  it('handles open and closed modes', async () => {
    const mailSpy = vi.spyOn(authSvc, 'sendMail').mockResolvedValue({ sent: true, detail: 'smtp' });
    await prisma.appSetting.upsert({
      where: { key: 'instance.registrationMode' },
      update: { value: 'closed' },
      create: { key: 'instance.registrationMode', value: 'closed' },
    });
    await expect(
      registerUser({ email: `c.${Date.now()}@test.dev`, name: 'C', password: 'long-enough-123' }),
    ).rejects.toMatchObject({ code: 'REGISTRATION_CLOSED' });

    await prisma.appSetting.update({
      where: { key: 'instance.registrationMode' },
      data: { value: 'open' },
    });
    const email = `open.${Date.now()}@test.dev`;
    // Open mode answers uniformly for new and existing emails.
    const created = await registerUser({ email, name: 'Open', password: 'long-enough-123' });
    expect(created.kind).toBe('check_email');
    expect(await prisma.user.findUnique({ where: { email } })).not.toBeNull();
    const again = await registerUser({ email, name: 'Open', password: 'long-enough-123' });
    expect(again.kind).toBe('check_email');
    await prisma.user.deleteMany({ where: { email } });
    mailSpy.mockRestore();
  });
});

describe('verification and password reset mail flows', () => {
  it('issues and consumes verification tokens', async () => {
    const user = await prisma.user.create({
      data: {
        email: `v.${Date.now()}@test.dev`,
        name: 'v',
        passwordHash: await hashPassword('x-123456789'),
        webauthnUserId: randomId(),
      },
    });
    await requestVerificationFor(user);
    const { token } = await createVerification(user.id);
    await expect(verifyEmail('bad-token')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
    await verifyEmail(token);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.emailVerifiedAt).not.toBeNull();
    await prisma.user.delete({ where: { id: user.id } });
  });

  it('requests a reset, rejects bad tokens and resets the password', async () => {
    const user = await mkUser(`rp.${Date.now()}@test.dev`);
    await requestPasswordReset(user.email);
    const row = await prisma.passwordReset.findFirstOrThrow({ where: { userId: user.id } });
    const token = `rp-token-${randomId()}`;
    await prisma.passwordReset.create({
      data: {
        userId: user.id,
        tokenHash: sha256hex(token),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    await expect(resetPassword('bad', 'new-password-123')).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
    await expect(resetPassword(token, 'short')).rejects.toMatchObject({
      code: 'WEAK_PASSWORD',
    });
    await resetPassword(token, 'new-password-123');
    const loginAfter = await login({
      email: user.email,
      password: 'new-password-123',
      ip: '127.0.0.1',
    });
    expect(loginAfter.user?.id).toBe(user.id);
    // The reset token is single-use.
    await expect(resetPassword(token, 'another-password-123')).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
    void row;
    await prisma.user.delete({ where: { id: user.id } });
  });

  it('sendMail reports console/no-smtp outcomes', async () => {
    const res = await sendMail({ to: 'a@b.c', subject: 's', text: 't', html: '<p>t</p>' });
    expect(res.sent).toBe(true); // MAIL_TO_CONSOLE=true in this file
  });
});

describe('TOTP and recovery codes', () => {
  it('sets up, confirms, regenerates and disables TOTP', async () => {
    const user = await mkUser(`t.${Date.now()}@test.dev`);
    const setup = await totpSetup(user.id);
    expect(setup.secret).toBeTruthy();

    await expect(totpConfirm(user.id, '000000')).rejects.toMatchObject({ code: 'BAD_TOTP' });

    const totp = moduleTotp;
    const code = await totp.generate({ secret: setup.secret });
    const confirmed = await totpConfirm(user.id, code);
    expect(confirmed.recoveryCodes.length).toBeGreaterThan(0);
    const enabled = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(enabled.totpEnabled).toBe(true);

    // Full MFA login: ceremony cookie + a fresh TOTP code.
    const cookies: Record<string, string> = {};
    const res = { cookie: (name: string, value: string) => (cookies[name] = value) } as never;
    await createMfaCeremony(res, user.id);
    // Reset the replay marker so a code from the same time step is accepted.
    await prisma.user.update({
      where: { id: user.id },
      data: { totpLastStep: null },
    });
    const code2 = await totp.generate({ secret: setup.secret });
    const req = { cookies: { vl_ceremony: cookies['vl_ceremony'] } } as unknown as Request;
    const mfa = await loginMfa(req, { code: code2, ip: '1.1.1.1' });
    expect(mfa.user.id).toBe(user.id);

    // A used recovery code cannot be reused.
    const rc = confirmed.recoveryCodes[0]!;
    expect(await consumeRecoveryCode(user.id, rc)).toBe(true);
    expect(await consumeRecoveryCode(user.id, rc)).toBe(false);

    const fresh = await regenerateRecoveryCodes(user.id);
    expect(fresh.recoveryCodes.length).toBeGreaterThan(0);

    await totpDisable(user.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).totpEnabled).toBe(
      false,
    );
    await prisma.user.delete({ where: { id: user.id } });
  });

  it('rejects wrong passwords without revealing details', async () => {
    const user = await mkUser(`w.${Date.now()}@test.dev`);
    await expect(
      login({ email: user.email, password: 'wrong-password', ip: '9.9.9.9' }),
    ).rejects.toMatchObject({ code: 'BAD_CREDENTIALS' });
    expect(await consumeRecoveryCode(user.id, 'not-a-code')).toBe(false);
    await prisma.user.delete({ where: { id: user.id } });
  });

  it('login routes through MFA when TOTP is enabled', async () => {
    const user = await mkUser(`m.${Date.now()}@test.dev`, { totpEnabled: true });
    const res = await login({
      email: user.email,
      password: 'correct-horse-battery',
      ip: '1.1.1.1',
    });
    expect(res.mfaRequired).toBe(true);
    expect(res.methods).toEqual(['totp', 'recovery_code']);

    // MFA without a ceremony cookie answers 401.
    const req = { headers: { cookie: '' } } as unknown as Request;
    await expect(loginMfa(req, { code: '123456', ip: '1.1.1.1' })).rejects.toMatchObject({
      code: 'MFA_EXPIRED',
    });
    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe('sessions and passkey ceremonies', () => {
  it('creates, lists, touches and revokes sessions', async () => {
    const user = await mkUser(`s.${Date.now()}@test.dev`);
    const a = await createSession(user.id, '1.2.3.4', 'ua');
    const b = await createSession(user.id, '5.6.7.8', 'ua2');
    const pub = publicUser(
      await prisma.user.update({
        where: { id: user.id },
        data: { suspendedAt: null, deletionRequestedAt: null, lockedAt: null, units: 'imperial' },
      }),
    );
    expect(pub.id).toBe(user.id);

    const sessions = await listSessions(user.id, a.sessionId);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.find((x) => x.id === a.sessionId)?.current).toBe(true);
    await touchSession(a.sessionId);
    await revokeAllOtherSessions(user.id, a.sessionId);
    const after = await listSessions(user.id);
    expect(after.some((s) => s.id === a.sessionId)).toBe(true);
    expect(after.some((s) => s.id === b.sessionId)).toBe(false);
    await prisma.user.delete({ where: { id: user.id } });
  });

  it('issues passkey options and rejects malformed registrations', async () => {
    const user = await mkUser(`p.${Date.now()}@test.dev`);
    const reg = await passkeyRegistrationOptions(user.id);
    expect(reg.challenge).toBeTruthy();
    const loginOpts = await passkeyLoginOptions();
    expect(loginOpts.challenge).toBeTruthy();
    const stepOpts = await passkeyStepUpOptions(user.id);
    expect(stepOpts.challenge).toBeTruthy();

    const req = {} as unknown as Request;
    await expect(verifyPasskeyRegistration(req, user.id, {} as never)).rejects.toThrow();
    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe('TOTP/session/passkey edge branches', () => {
  const cookie = (_name: string, _value: string) => {};
  function cookieJar() {
    const jar: Record<string, string> = {};
    const res = { cookie: (n: string, v: string) => (jar[n] = v) };
    return { jar, res };
  }
  void cookie;

  it('covers revoke/touch/delete NOT_FOUND and the anon throttle key', async () => {
    const user = await mkUser(`edge.${Date.now()}@test.dev`);
    await expect(revokeSession(user.id, 'does-not-exist')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(touchSession('does-not-exist')).resolves.toBeUndefined();
    await expect(deletePasskey(user.id, 'does-not-exist')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(userKey(user.id, undefined)).toMatch(/ip:anon$/);
    await prisma.user.delete({ where: { id: user.id } });
  });

  it('verifyTotpForUser guards against malformed/missing secrets', async () => {
    const user = await mkUser(`totp.${Date.now()}@test.dev`);
    expect(await verifyTotpForUser(user.id, 'abc')).toBe(false);
    expect(await verifyTotpForUser(user.id, '123456')).toBe(false);
    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecretSealed: 'garbage-not-an-envelope' },
    });
    expect(await verifyTotpForUser(user.id, '123456')).toBe(false);
    await prisma.user.delete({ where: { id: user.id } });
  });

  it('totpSetup/totpConfirm guard errors', async () => {
    const user = await mkUser(`tg.${Date.now()}@test.dev`);
    const { secret } = await totpSetup(user.id);
    const code = await moduleTotp.generate({ secret });
    await totpConfirm(user.id, code);
    await expect(totpSetup(user.id)).rejects.toMatchObject({ code: 'TOTP_ALREADY_ENABLED' });

    const other = await mkUser(`tg2.${Date.now()}@test.dev`);
    await expect(totpConfirm(other.id, '123456')).rejects.toMatchObject({ code: 'NO_TOTP' });
    await prisma.user.update({
      where: { id: other.id },
      data: {
        totpPendingSealed: 'garbage-not-an-envelope',
        totpPendingExpiresAt: new Date(Date.now() + 300_000),
      },
    });
    await expect(totpConfirm(other.id, '123456')).rejects.toMatchObject({ code: 'NO_TOTP' });
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } });
  });

  it('loginMfa consumes the ceremony after five bad codes', async () => {
    const user = await mkUser(`mfa.${Date.now()}@test.dev`);
    const { jar, res } = cookieJar();
    await createMfaCeremony(res as never, user.id);
    const req = { cookies: { vl_ceremony: jar['vl_ceremony'] } } as unknown as Request;
    for (let i = 0; i < 5; i++) {
      await expect(loginMfa(req, { code: '000000', ip: '1.1.1.1' })).rejects.toMatchObject({
        code: 'MFA_FAILED',
      });
    }
    await expect(loginMfa(req, { code: '000000', ip: '1.1.1.1' })).rejects.toMatchObject({
      code: 'MFA_EXPIRED',
    });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it('passkey login: unknown credential, success, and soft failure', async () => {
    const user = await mkUser(`pk.${Date.now()}@test.dev`);
    await expect(
      passkeyLogin(
        { cookies: {} } as unknown as Request,
        { response: { id: 'nope' } } as never,
        '1.1.1.1',
      ),
    ).rejects.toMatchObject({ code: 'PASSKEY_FAILED' });

    const cred = await prisma.passkeyCredential.create({
      data: {
        userId: user.id,
        credentialId: `cred-${randomId()}`,
        publicKey: isoBase64URL.fromBuffer(Buffer.from([1, 2, 3, 4, 5]), 'base64'),
        counter: 3n,
        transports: ['internal'],
        name: 'PK',
      },
    });
    const { jar, res } = cookieJar();
    await createCeremony(res as never, { purpose: 'passkey_login', challenge: 'authch1' });
    const req = { cookies: { vl_ceremony: jar['vl_ceremony'] } } as unknown as Request;

    wb.vAuth.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 9, credentialBackedUp: true },
    });
    const ok = await passkeyLogin(req, { response: { id: cred.credentialId } } as never, '1.1.1.1');
    expect(ok.token).toBeTruthy();
    expect(ok.user.id).toBe(user.id);
    const updated = await prisma.passkeyCredential.findUniqueOrThrow({ where: { id: cred.id } });
    expect(updated.counter).toBe(9n);
    expect(updated.backedUp).toBe(true);

    // Soft failure: a real assertion that does not verify.
    const { jar: jar2, res: res2 } = cookieJar();
    await createCeremony(res2 as never, { purpose: 'passkey_login', challenge: 'authch2' });
    wb.vAuth.mockResolvedValueOnce({
      verified: false,
      authenticationInfo: { newCounter: 9, credentialBackedUp: true },
    });
    await expect(
      passkeyLogin(
        { cookies: { vl_ceremony: jar2['vl_ceremony'] } } as unknown as Request,
        { response: { id: cred.credentialId } } as never,
        '1.1.1.1',
      ),
    ).rejects.toMatchObject({ code: 'PASSKEY_FAILED' });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it('passkey registration success and soft failures', async () => {
    const user = await mkUser(`pkreg.${Date.now()}@test.dev`);
    const { jar, res } = cookieJar();
    await createCeremony(res as never, {
      purpose: 'passkey_register',
      userId: user.id,
      challenge: 'regch1',
    });
    const req = { cookies: { vl_ceremony: jar['vl_ceremony'] } } as unknown as Request;
    wb.vReg.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: {
          id: `cred-new-${randomId()}`,
          publicKey: isoBase64URL.fromBuffer(Buffer.from([9, 8, 7]), 'base64'),
          counter: 0,
          transports: ['internal'],
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    });
    const body = { name: 'MyKey', response: { id: 'unused' } } as never;
    const pendingId = (wb.vReg.mock.calls[0] as never) === undefined ? '' : '';
    void pendingId;
    await verifyPasskeyRegistration(req, user.id, body);
    const created = await prisma.passkeyCredential.findFirst({ where: { userId: user.id } });
    expect(created?.name).toBe('MyKey');

    // verified:true but no registrationInfo hits the second guard.
    const { jar: jar2, res: res2 } = cookieJar();
    await createCeremony(res2 as never, {
      purpose: 'passkey_register',
      userId: user.id,
      challenge: 'regch2',
    });
    wb.vReg.mockResolvedValueOnce({ verified: true, registrationInfo: undefined });
    await expect(
      verifyPasskeyRegistration(
        { cookies: { vl_ceremony: jar2['vl_ceremony'] } } as unknown as Request,
        user.id,
        { response: { id: 'x' } } as never,
      ),
    ).rejects.toMatchObject({ code: 'PASSKEY_FAILED' });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it('step-up: passkey success, wrong owner, ceremony mismatch, recovery code, totp, and missing id', async () => {
    const user = await mkUser(`su.${Date.now()}@test.dev`);
    const other = await mkUser(`su2.${Date.now()}@test.dev`);
    const session = await createSession(user.id, '1.1.1.1');
    const actor = { kind: 'session', userId: user.id, sessionId: session.sessionId } as const;

    // passkey success
    const cred = await prisma.passkeyCredential.create({
      data: {
        userId: user.id,
        credentialId: `su-cred-${randomId()}`,
        publicKey: isoBase64URL.fromBuffer(Buffer.from([1, 2, 3]), 'base64'),
        counter: 1n,
        transports: ['internal'],
        name: 'SU',
      },
    });
    const { jar, res } = cookieJar();
    await createCeremony(res as never, {
      purpose: 'stepup_passkey',
      userId: user.id,
      sessionId: session.sessionId,
      challenge: 'stepch',
    });
    wb.vAuth.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 4, credentialBackedUp: false },
    });
    const up = await stepUp(
      actor,
      { cookies: { vl_ceremony: jar['vl_ceremony'] } } as unknown as Request,
      { method: 'passkey', response: { id: cred.credentialId } as never },
    );
    expect(up.stepUpUntil).toBeTruthy();

    // wrong owner
    const credV = await prisma.passkeyCredential.create({
      data: {
        userId: other.id,
        credentialId: `su-cred-${randomId()}`,
        publicKey: isoBase64URL.fromBuffer(Buffer.from([1]), 'base64'),
        counter: 1n,
        transports: ['internal'],
        name: 'SU-V',
      },
    });
    await expect(
      stepUp(actor, {} as unknown as Request, {
        method: 'passkey',
        response: { id: credV.credentialId } as never,
      }),
    ).rejects.toMatchObject({ code: 'PASSKEY_MISMATCH' });

    // ceremony bound to a different user
    const { jar: jar3, res: res3 } = cookieJar();
    await createCeremony(res3 as never, {
      purpose: 'stepup_passkey',
      userId: other.id,
      sessionId: session.sessionId,
      challenge: 'stepch3',
    });
    await expect(
      stepUp(actor, { cookies: { vl_ceremony: jar3['vl_ceremony'] } } as unknown as Request, {
        method: 'passkey',
        response: { id: cred.credentialId } as never,
      }),
    ).rejects.toMatchObject({ code: 'PASSKEY_MISMATCH' });

    // recovery code
    await prisma.recoveryCode.create({
      data: { userId: user.id, codeHash: recoveryCodeHash('ABCD-EFGH-IJKL-MNOP') },
    });
    await expect(
      stepUp(actor, {} as unknown as Request, {
        method: 'recovery_code',
        code: 'abcd-efgh-ijkl-mnop',
      }),
    ).resolves.toMatchObject({ stepUpUntil: expect.any(String) });

    // totp
    const { secret } = await totpSetup(user.id);
    const code = await moduleTotp.generate({ secret });
    await totpConfirm(user.id, code);
    await prisma.user.update({ where: { id: user.id }, data: { totpLastStep: null } });
    const code2 = await moduleTotp.generate({ secret });
    await expect(
      stepUp(actor, {} as unknown as Request, { method: 'totp', code: code2 }),
    ).resolves.toMatchObject({ stepUpUntil: expect.any(String) });

    // passkey without credential id
    await expect(
      stepUp(actor, {} as unknown as Request, { method: 'passkey' }),
    ).rejects.toMatchObject({ code: 'STEP_UP_FAILED' });

    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } });
  });

  it('setRegistrationMode writes the setting when SMTP is available', async () => {
    await setRegistrationMode('open');
    const row = await prisma.appSetting.findUniqueOrThrow({
      where: { key: 'instance.registrationMode' },
    });
    expect(row.value).toBe('open');
  });
});

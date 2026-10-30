// Auth routes: setup, registration, sign-in (password + MFA), passkeys,
// TOTP, recovery codes, step-up, sessions. All flows from guide 05 §1.4/§6.

import { Router } from 'express';
import { prisma } from '../core/db';
import { env } from '../core/env';
import {
  bootstrapInstanceAdmin,
  createMfaCeremony,
  createSession,
  deletePasskey,
  listPasskeys,
  listSessions,
  login,
  loginMfa,
  passkeyLogin,
  passkeyLoginOptions,
  passkeyRegistrationOptions,
  passkeyStepUpOptions,
  publicUser,
  regenerateRecoveryCodes,
  registerUser,
  requestPasswordReset,
  resetPassword,
  revokeAllOtherSessions,
  revokeSession,
  setRegistrationMode,
  setSessionCookie,
  setupStatus,
  stepUp,
  totpConfirm,
  totpDisable,
  totpSetup,
  verifyEmail,
  verifyPasskeyRegistration,
} from '../auth/service';
import { policyRouter, sessionActor } from '../authz/policy';
import { AccessDenied } from '../authz/errors';

export const authRouter = policyRouter('/api/v1/auth');

// ---- public: setup and registration (Z-OWNER) ----

authRouter.get('/setup-status', { auth: 'public', target: { kind: 'none' } }, async (_req, res) => {
  res.json({ data: await setupStatus() });
});

authRouter.post('/register', { auth: 'public', target: { kind: 'none' } }, async (req, res) => {
  const body = (req.body ?? {}) as { email?: string; name?: string; password?: string; setupToken?: string; inviteToken?: string };
  const status = await setupStatus();
  if (status.needsSetup) {
    if (typeof body.setupToken !== 'string' || !body.setupToken) {
      throw new AccessDenied('SETUP_REQUIRED', 'This instance needs first-run setup with the setup token.', 403);
    }
    const { user } = await bootstrapInstanceAdmin({
      email: String(body.email ?? ''),
      name: String(body.name ?? ''),
      password: String(body.password ?? ''),
      setupToken: body.setupToken,
    });
    const { token } = await createSession(user.id, req.ip, req.headers['user-agent'] as string | undefined);
    await setSessionCookie(res, token);
    res.status(201).json({ data: { user } });
    return;
  }
  const result = await registerUser({
    email: String(body.email ?? ''),
    name: String(body.name ?? ''),
    password: String(body.password ?? ''),
    inviteToken: typeof body.inviteToken === 'string' ? body.inviteToken : undefined,
  });
  if (result.kind === 'created') {
    const { token } = await createSession(result.user.id, req.ip, req.headers['user-agent'] as string | undefined);
    await setSessionCookie(res, token);
    res.status(201).json({ data: { user: result.user } });
    return;
  }
  res.status(202).json({ data: { status: 'check_email' } });
});

authRouter.post('/verify-email', { auth: 'public', target: { kind: 'none' } }, async (req, res) => {
  await verifyEmail(String((req.body as { token?: string }).token ?? ''));
  res.json({ data: { ok: true } });
});

authRouter.post('/resend-verification', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const actor = req.actor!;
  if (actor.kind !== 'session') throw new AccessDenied('API_KEY_NOT_ALLOWED', 'This endpoint requires an interactive session.', 403);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
  if (user.emailVerifiedAt) {
    res.json({ data: { ok: true, alreadyVerified: true } });
    return;
  }
  const { requestVerificationFor } = await import('../auth/service');
  await requestVerificationFor(user);
  res.json({ data: { ok: true } });
});

// ---- sign-in (A-TOTPLOGIN: /login/totp is gone; MFA completes at /login/mfa) ----

authRouter.post('/login', { auth: 'public', target: { kind: 'none' } }, async (req, res) => {
  const body = (req.body ?? {}) as { email?: string; password?: string };
  const result = await login({
    email: String(body.email ?? ''),
    password: String(body.password ?? ''),
    ip: req.ip,
    userAgent: req.headers['user-agent'] as string | undefined,
  });
  if (result.mfaRequired) {
    const u = await prisma.user.findUnique({ where: { email: String(body.email ?? '').trim().toLowerCase() } });
    await createMfaCeremony(res, u!.id);
    res.json({ data: { mfaRequired: true, methods: result.methods } });
    return;
  }
  const { token } = await createSession(result.user!.id, req.ip, req.headers['user-agent'] as string | undefined);
  await setSessionCookie(res, token);
  res.json({ data: { user: result.user } });
});

authRouter.post('/login/mfa', { auth: 'public', target: { kind: 'none' } }, async (req, res) => {
  const body = (req.body ?? {}) as { code?: string; recoveryCode?: string };
  const { token, user } = await loginMfa(req, {
    code: body.code,
    recoveryCode: body.recoveryCode,
    ip: req.ip,
    userAgent: req.headers['user-agent'] as string | undefined,
  });
  await setSessionCookie(res, token);
  res.json({ data: { user } });
});

// /auth/login/totp must be gone entirely: the 404 below makes the regression
// test explicit.
const gone = Router();
gone.all('/login/totp', (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
});
authRouter.router.use(gone);

authRouter.post('/logout', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const actor = req.actor!;
  if (actor.kind === 'session') {
    await prisma.userSession.updateMany({ where: { id: actor.sessionId }, data: { revokedAt: new Date() } });
  }
  res.clearCookie(env.SESSION_COOKIE, { path: '/' });
  res.json({ data: { ok: true } });
});

// ---- password reset (uniform responses, A-ENUM) ----

authRouter.post('/forgot-password', { auth: 'public', target: { kind: 'none' } }, async (req, res) => {
  await requestPasswordReset(String((req.body as { email?: string }).email ?? '').trim().toLowerCase());
  res.json({ data: { ok: true } });
});

authRouter.post('/reset-password', { auth: 'public', target: { kind: 'none' } }, async (req, res) => {
  await resetPassword(String((req.body as { token?: string }).token ?? ''), String((req.body as { password?: string }).password ?? ''));
  res.json({ data: { ok: true } });
});

// ---- sessions ----

authRouter.get('/sessions', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const actor = req.actor!;
  if (actor.kind !== 'session') throw new AccessDenied('API_KEY_NOT_ALLOWED', 'This endpoint requires an interactive session.', 403);
  res.json({ data: await listSessions(actor.userId, actor.sessionId) });
});

authRouter.post(
  '/sessions/:id/revoke',
  { auth: 'session', target: { kind: 'resource', resource: 'session', from: 'param:id', perm: 'org.read' } },
  async (req, res) => {
    const actor = req.actor!;
    if (actor.kind !== 'session') throw new AccessDenied('API_KEY_NOT_ALLOWED', 'This endpoint requires an interactive session.', 403);
    await revokeSession(actor.userId, String(req.params.id));
    res.json({ data: { ok: true } });
  },
);

authRouter.post('/sessions/revoke-others', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const actor = req.actor!;
  if (actor.kind !== 'session') throw new AccessDenied('API_KEY_NOT_ALLOWED', 'This endpoint requires an interactive session.', 403);
  await revokeAllOtherSessions(actor.userId, actor.sessionId);
  res.json({ data: { ok: true } });
});

// ---- TOTP (A-TOTPSETUP: setup requires step-up; active secret untouched
// until confirmation) ----

authRouter.post('/mfa/totp/setup', { auth: 'session', stepUp: {}, target: { kind: 'none' } }, async (req, res) => {
  const actor = req.actor!;
  if (actor.kind !== 'session') throw new AccessDenied('API_KEY_NOT_ALLOWED', 'This endpoint requires an interactive session.', 403);
  res.json({ data: await totpSetup(actor.userId) });
});

authRouter.post('/mfa/totp/confirm', { auth: 'session', stepUp: {}, target: { kind: 'none' } }, async (req, res) => {
  const actor = req.actor!;
  if (actor.kind !== 'session') throw new AccessDenied('API_KEY_NOT_ALLOWED', 'This endpoint requires an interactive session.', 403);
  const { recoveryCodes } = await totpConfirm(actor.userId, String((req.body as { code?: string }).code ?? ''));
  res.json({ data: { recoveryCodes } });
});

authRouter.post('/mfa/totp/disable', { auth: 'session', stepUp: { possession: true }, target: { kind: 'none' } }, async (req, res) => {
  const actor = req.actor!;
  if (actor.kind !== 'session') throw new AccessDenied('API_KEY_NOT_ALLOWED', 'This endpoint requires an interactive session.', 403);
  await totpDisable(actor.userId);
  res.json({ data: { ok: true } });
});

authRouter.post(
  '/mfa/recovery-codes/regenerate',
  { auth: 'session', stepUp: { possession: true }, target: { kind: 'none' } },
  async (req, res) => {
    const actor = req.actor!;
    if (actor.kind !== 'session') throw new AccessDenied('API_KEY_NOT_ALLOWED', 'This endpoint requires an interactive session.', 403);
    const { recoveryCodes } = await regenerateRecoveryCodes(actor.userId);
    res.json({ data: { recoveryCodes } });
  },
);

// ---- step-up (A-STEPUP): the server-side window bound to this session ----

authRouter.post('/step-up', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const actor = req.actor!;
  if (actor.kind !== 'session') throw new AccessDenied('API_KEY_NOT_ALLOWED', 'This endpoint requires an interactive session.', 403);
  const body = (req.body ?? {}) as { method?: string; password?: string; code?: string; response?: never };
  const result = await stepUp(actor, req, {
    method: (body.method as 'password' | 'totp' | 'recovery_code' | 'passkey') ?? 'password',
    password: body.password,
    code: body.code,
    response: body.response,
  });
  res.json({ data: result });
});

// ---- passkeys (A-PASSKEY, A-PASSKEYDEL, NEW-04) ----

authRouter.get('/passkeys', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const actor = req.actor!;
  if (actor.kind !== 'session') throw new AccessDenied('API_KEY_NOT_ALLOWED', 'This endpoint requires an interactive session.', 403);
  res.json({ data: await listPasskeys(actor.userId) });
});

authRouter.post('/passkeys/options', { auth: 'session', stepUp: {}, target: { kind: 'none' } }, async (req, res) => {
  const actor = req.actor!;
  if (actor.kind !== 'session') throw new AccessDenied('API_KEY_NOT_ALLOWED', 'This endpoint requires an interactive session.', 403);
  const options = await passkeyRegistrationOptions(actor.userId);
  const { createCeremony } = await import('../auth/ceremony');
  await createCeremony(res, { purpose: 'passkey_register', userId: actor.userId, sessionId: actor.sessionId, challenge: options.challenge });
  res.json({ data: options });
});

authRouter.post('/passkeys', { auth: 'session', stepUp: {}, target: { kind: 'none' } }, async (req, res) => {
  const actor = req.actor!;
  if (actor.kind !== 'session') throw new AccessDenied('API_KEY_NOT_ALLOWED', 'This endpoint requires an interactive session.', 403);
  const body = (req.body ?? {}) as { name?: string; response?: never };
  await verifyPasskeyRegistration(req, actor.userId, { name: body.name, response: body.response as never });
  res.status(201).json({ data: { ok: true } });
});

authRouter.delete(
  '/passkeys/:id',
  { auth: 'session', stepUp: { possession: true }, target: { kind: 'resource', resource: 'passkey', from: 'param:id', perm: 'org.read' } },
  async (req, res) => {
    const actor = req.actor!;
    if (actor.kind !== 'session') throw new AccessDenied('API_KEY_NOT_ALLOWED', 'This endpoint requires an interactive session.', 403);
    await deletePasskey(actor.userId, String(req.params.id));
    res.json({ data: { ok: true } });
  },
);

// deprecated alias, kept for one release (A-PASSKEYDEL) — same policy as the
// DELETE route: possession step-up plus a self-owned resource target.
authRouter.post(
  '/passkeys/:id/delete',
  { auth: 'session', stepUp: { possession: true }, target: { kind: 'resource', resource: 'passkey', from: 'param:id', perm: 'org.read' } },
  async (req, res) => {
    const actor = sessionActor(req);
    await deletePasskey(actor.userId, String(req.params.id));
    res.json({ data: { ok: true } });
  },
);

authRouter.get('/passkey/login/options', { auth: 'public', target: { kind: 'none' } }, async (_req, res) => {
  const options = await passkeyLoginOptions();
  const { createCeremony } = await import('../auth/ceremony');
  const { webauthnRelyingParty } = await import('../auth/service');
  void webauthnRelyingParty;
  await createCeremony(res, { purpose: 'passkey_login', challenge: options.challenge });
  res.json({ data: options });
});

authRouter.post('/passkey/login/verify', { auth: 'public', target: { kind: 'none' } }, async (req, res) => {
  const { token, user } = await passkeyLogin(req, { response: (req.body as { response: never }).response }, req.ip, req.headers['user-agent'] as string | undefined);
  await setSessionCookie(res, token);
  res.json({ data: { user } });
});

authRouter.get('/step-up/passkey/options', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const actor = req.actor!;
  if (actor.kind !== 'session') throw new AccessDenied('API_KEY_NOT_ALLOWED', 'This endpoint requires an interactive session.', 403);
  const options = await passkeyStepUpOptions(actor.userId);
  const { createCeremony } = await import('../auth/ceremony');
  await createCeremony(res, { purpose: 'stepup_passkey', userId: actor.userId, sessionId: actor.sessionId, challenge: options.challenge });
  res.json({ data: options });
});

// ---- me (the access layer fills req.actor) ----

authRouter.get('/me', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const actor = req.actor!;
  if (actor.kind !== 'session') throw new AccessDenied('API_KEY_NOT_ALLOWED', 'This endpoint requires an interactive session.', 403);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, include: { _count: { select: { passkeys: true } } } });
  const memberships = await prisma.membership.findMany({ where: { userId: actor.userId, status: 'ACTIVE' }, include: { organization: true } });
  const { ROLE_PERMISSIONS } = await import('@voltlink/shared');
  res.json({
    data: {
      user: { ...publicUser(user), passkeyEnabled: user._count.passkeys > 0 },
      isInstanceAdmin: actor.isInstanceAdmin,
      memberships: memberships.map((m) => ({
        organizationId: m.organizationId,
        name: m.organization.name,
        kind: m.organization.kind,
        role: m.role,
        permissions: ROLE_PERMISSIONS[m.role],
      })),
    },
  });
});

// ---- instance settings (admin page): registration mode ----

authRouter.patch('/instance/registration-mode', { auth: 'session', stepUp: {}, target: { kind: 'instanceAdmin' } }, async (req, res) => {
  const mode = String((req.body as { mode?: string }).mode ?? '');
  if (!['invite', 'open', 'closed'].includes(mode)) {
    throw new AccessDenied('BAD_REQUEST', 'mode must be invite, open or closed.', 400);
  }
  await setRegistrationMode(mode as 'invite' | 'open' | 'closed');
  res.json({ data: { ok: true } });
});

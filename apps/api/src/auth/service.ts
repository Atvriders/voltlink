// VoltLink authentication service: registration (setup/invite/open/closed),
// sign-in with a server-side MFA challenge, TOTP (otplib v13, sealed secrets,
// replay-safe), recovery codes, passkeys (SimpleWebAuthn v14), step-up,
// sessions and the dev/SMTP mailer.

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import { generateSecret, generateURI, verify } from 'otplib';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { prisma } from '../core/db';
import { env } from '../core/env';
import { hashPassword, verifyPassword, sha256hex, randomToken, randomId } from '../core/crypto';
import { seal, open } from '../core/keyring';
import { audit, getSetting, setSetting } from '../core/settings';
import { AuthError, AccessDenied } from '../authz/errors';
import { createCeremony, consumeCeremony, readCeremony } from './ceremony';
import { assertNotThrottled, clearFailures, recordFailure } from './throttle';
import type { Request } from 'express';
import type { UserPublic, SessionInfo } from '@voltlink/shared';

// ---------------------------------------------------------------------------
// Tokens and cookies
// ---------------------------------------------------------------------------

export interface JwtPayload {
  sub: string;
  sid: string;
}

export function signSessionJwt(userId: string, sessionId: string, expiresSec: number): string {
  return jwt.sign({ sub: userId, sid: sessionId }, env.JWT_SECRET(), { expiresIn: expiresSec });
}

export function verifySessionJwt(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_SECRET()) as JwtPayload;
}

export function tokenHash(token: string): string {
  return sha256hex(token);
}

export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function publicUser(u: {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: Date | null;
  totpEnabled: boolean;
  timezone: string;
  units: string;
  theme: string;
  demoEnabled: boolean;
  presentationMode: boolean;
  createdAt: Date;
}): UserPublic {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: '',
    emailVerified: !!u.emailVerifiedAt,
    totpEnabled: u.totpEnabled,
    passkeyEnabled: false,
    timezone: u.timezone,
    units: u.units === 'imperial' ? 'imperial' : 'metric',
    theme: u.theme,
    demoEnabled: u.demoEnabled,
    presentationMode: u.presentationMode,
    createdAt: u.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Mailer (A-TOKENLOG, A-EMAILVERIFY: links are HTML-escaped and only echoed in
// development with the explicit dev flag and a localhost PUBLIC_URL)
// ---------------------------------------------------------------------------

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;
function getTransporter(): ReturnType<typeof nodemailer.createTransport> | null {
  if (!env.SMTP_URL) return null;
  if (!transporter) transporter = nodemailer.createTransport(env.SMTP_URL);
  return transporter;
}

export async function sendMail(opts: { to: string; subject: string; text: string; html: string }): Promise<{ sent: boolean; detail: string }> {
  const t = getTransporter();
  if (t) {
    await t.sendMail({ from: env.MAIL_FROM, to: opts.to, subject: opts.subject, text: opts.text, html: opts.html });
    return { sent: true, detail: 'smtp' };
  }
  return { sent: false, detail: 'no-smtp' };
}

const ECHO_OK =
  env.DEV_ECHO_TOKENS &&
  env.NODE_ENV === 'development' &&
  ['localhost', '127.0.0.1'].includes(publicHost());

function publicHost(): string {
  try {
    return new URL(env.PUBLIC_URL).hostname;
  } catch {
    return 'localhost';
  }
}

function echoableToken(token: string): void {
  if (ECHO_OK) {
    console.log(`[mail:dev] token echoed (dev only): ${token}`);
  }
}

// ---------------------------------------------------------------------------
// Registration and bootstrap (Z-OWNER, A-ENUM)
// ---------------------------------------------------------------------------

export async function setupStatus(): Promise<{ needsSetup: boolean; registrationMode: string }> {
  const bootstrapped = await getSetting('instance.bootstrappedAt');
  const mode = (await getSetting('instance.registrationMode')) || (bootstrapped ? 'invite' : 'setup');
  return { needsSetup: !bootstrapped, registrationMode: bootstrapped ? mode : 'setup' };
}


async function verifySetupToken(input: string): Promise<void> {
  const configured = process.env.VL_SETUP_TOKEN;
  if (configured) {
    if (configured.length < 32) throw new AuthError('SETUP_TOKEN_REQUIRED', 'VL_SETUP_TOKEN must be at least 32 characters.', 500);
    const a = Buffer.from(sha256hex(input));
    const b = Buffer.from(sha256hex(configured));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new AuthError('SETUP_TOKEN_INVALID', 'The setup token is incorrect.', 401);
    return;
  }
  const row = await prisma.appSetting.findUnique({ where: { key: 'instance.setupTokenHash' } });
  if (!row) throw new AuthError('SETUP_TOKEN_REQUIRED', 'No setup token is available on this instance.', 500);
  const a = Buffer.from(sha256hex(input));
  const b = Buffer.from(row.value, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new AuthError('SETUP_TOKEN_INVALID', 'The setup token is incorrect.', 401);
}

export async function bootstrapInstanceAdmin(input: { email: string; name: string; password: string; setupToken: string }): Promise<{ user: UserPublic }> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError('INVALID_EMAIL', 'Enter a valid email address.');
  if (input.password.length < 10) throw new AuthError('WEAK_PASSWORD', 'Password must be at least 10 characters.');
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new AuthError('EMAIL_TAKEN', 'An account with this email already exists.', 409);
  await verifySetupToken(input.setupToken);
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await prisma.$transaction(async (tx) => {
      await tx.appSetting.create({ data: { key: 'instance.bootstrappedAt', value: new Date().toISOString() } });
      const created = await tx.user.create({
        data: {
          email,
          name: input.name.trim() || (email.split('@')[0] ?? 'VoltLink user'),
          passwordHash,
          isInstanceAdmin: true,
          emailVerifiedAt: new Date(),
          webauthnUserId: randomToken(32),
        },
      });
      const org = await tx.organization.create({
        data: { kind: 'OPERATOR', name: 'VoltLink operators', createdById: created.id, memberships: { create: { userId: created.id, role: 'OWNER' } } },
      });
      await tx.appSetting.create({ data: { key: 'instance.operatorOrgId', value: org.id } });
      await tx.appSetting.upsert({
        where: { key: 'instance.registrationMode' },
        update: { value: 'invite' },
        create: { key: 'instance.registrationMode', value: 'invite' },
      });
      await tx.appSetting.deleteMany({ where: { key: 'instance.setupTokenHash' } });
      return created;
    });
    await audit({ actorId: user.id, action: 'auth.bootstrap', entityType: 'user', entityId: user.id });
    return { user: publicUser(user) };
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      throw new AuthError('SETUP_COMPLETE', 'This instance is already set up.', 409);
    }
    throw e;
  }
}

export type RegistrationResult = { kind: 'created'; user: UserPublic } | { kind: 'check_email' } | { kind: 'closed' };

export async function registerUser(input: { email: string; name: string; password: string; inviteToken?: string }): Promise<RegistrationResult> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError('INVALID_EMAIL', 'Enter a valid email address.');
  if (input.password.length < 10) throw new AuthError('WEAK_PASSWORD', 'Password must be at least 10 characters.');
  const { needsSetup, registrationMode } = await setupStatus();
  if (needsSetup) throw new AuthError('SETUP_REQUIRED', 'This instance needs first-run setup.', 403);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (registrationMode === 'invite') {
    // The secret invitation token from the email link is required; the email
    // alone never grants entry (a bearer of the link is the invitee).
    if (!input.inviteToken) throw new AuthError('INVITE_REQUIRED', 'An invitation token is required to register on this instance.', 403);
    const invitation = await prisma.invitation.findUnique({ where: { tokenHash: sha256hex(input.inviteToken) } });
    if (
      !invitation ||
      invitation.kind !== 'membership' ||
      invitation.email !== email ||
      invitation.revokedAt ||
      invitation.acceptedAt ||
      invitation.expiresAt <= new Date()
    ) {
      throw new AuthError('INVITE_REQUIRED', 'This invitation is invalid, expired or already used.', 403);
    }
    if (existing) throw new AuthError('EMAIL_TAKEN', 'An account with this email already exists.', 409);
    const passwordHash = await hashPassword(input.password);
    const user = await prisma.user.create({
      data: { email, name: input.name.trim() || (email.split('@')[0] ?? 'VoltLink user'), passwordHash, emailVerifiedAt: new Date(), webauthnUserId: randomToken(32) },
    });
    await prisma.$transaction([
      prisma.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } }),
      prisma.membership.create({ data: { organizationId: invitation.organizationId, userId: user.id, role: invitation.role ?? 'VIEWER', invitedById: invitation.invitedById } }),
    ]);
    await audit({ actorId: user.id, action: 'auth.register_invite', entityType: 'user', entityId: user.id });
    return { kind: 'created', user: publicUser(user) };
  }
  if (registrationMode === 'closed') {
    throw new AuthError('REGISTRATION_CLOSED', 'Registration is closed on this instance.', 403);
  }
  // open mode: uniform 202 check_email answer for new and existing emails.
  if (!env.SMTP_URL) {
    throw new AuthError('REGISTRATION_UNAVAILABLE', 'Open registration requires SMTP configuration.', 503);
  }
  if (!existing) {
    const passwordHash = await hashPassword(input.password);
    const user = await prisma.user.create({
      data: { email, name: input.name.trim() || (email.split('@')[0] ?? 'VoltLink user'), passwordHash, webauthnUserId: randomToken(32) },
    });
    await prisma.organization.create({ data: { kind: 'PERSONAL', name: user.name, createdById: user.id, memberships: { create: { userId: user.id, role: 'OWNER' } } } });
    await requestVerificationFor(user);
    await audit({ actorId: user.id, action: 'auth.register', entityType: 'user', entityId: user.id });
  } else {
    await sendMail({
      to: email,
      subject: 'VoltLink account notice',
      text: 'Someone tried to register this email address, which already has an account. If that was you, use the password reset instead.',
      html: '<p>Someone tried to register this email address, which already has an account. If that was you, use the password reset instead.</p>',
    });
  }
  return { kind: 'check_email' };
}

// ---------------------------------------------------------------------------
// Email verification (A-EMAILVERIFY)
// ---------------------------------------------------------------------------

export async function createVerification(userId: string): Promise<{ token: string; link: string }> {
  const token = randomToken();
  await prisma.emailVerification.create({
    data: { userId, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 24 * 3600 * 1000) },
  });
  const link = `${env.PUBLIC_URL}/verify-email?token=${encodeURIComponent(token)}`;
  return { token, link };
}

export async function requestVerificationFor(user: { id: string; email: string; name: string }): Promise<void> {
  const { token, link } = await createVerification(user.id);
  await sendMail({
    to: user.email,
    subject: 'Verify your VoltLink email address',
    text: `Hi ${user.name},\n\nVerify your VoltLink account by opening this link:\n${link}\n\nThis link expires in 24 hours.`,
    html: `<p>Hi ${escapeHtml(user.name)},</p><p>Verify your VoltLink account:</p><p><a href="${escapeHtml(link)}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
  });
  echoableToken(token);
}

export async function verifyEmail(token: string): Promise<void> {
  const row = await prisma.emailVerification.findUnique({ where: { tokenHash: tokenHash(token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) throw new AuthError('INVALID_TOKEN', 'This verification link is invalid or expired.');
  await prisma.$transaction([
    prisma.emailVerification.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } }),
  ]);
  await audit({ actorId: row.userId, action: 'auth.verify_email', entityType: 'user', entityId: row.userId });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(userId: string, ip?: string, userAgent?: string, label?: string): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const sessionId = randomId();
  const token = signSessionJwt(userId, sessionId, env.JWT_EXPIRES_SEC);
  const session = await prisma.userSession.create({
    data: {
      id: sessionId,
      userId,
      tokenHash: tokenHash(token),
      ip: ip?.slice(0, 64),
      userAgent: userAgent?.slice(0, 256),
      label: label?.slice(0, 64),
      expiresAt: new Date(Date.now() + env.JWT_EXPIRES_SEC * 1000),
    },
  });
  return { token, sessionId: session.id, expiresAt: session.expiresAt };
}

export async function setSessionCookie(res: { cookie: (name: string, value: string, opts: unknown) => void }, token: string): Promise<void> {
  res.cookie(env.SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(env.PUBLIC_URL).protocol === 'https:',
    sameSite: 'lax',
    path: '/',
    maxAge: env.JWT_EXPIRES_SEC * 1000,
  });
}

export async function listSessions(userId: string, currentSessionId?: string): Promise<SessionInfo[]> {
  const rows = await prisma.userSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    current: r.id === currentSessionId,
    ip: r.ip ?? '',
    userAgent: r.userAgent ?? '',
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: r.lastSeenAt?.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  }));
}

export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const row = await prisma.userSession.findUnique({ where: { id: sessionId } });
  if (!row || row.userId !== userId) throw new AuthError('NOT_FOUND', 'Session not found.', 404);
  await prisma.userSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  await audit({ actorId: userId, action: 'auth.revoke_session', entityType: 'session', entityId: sessionId });
}

export async function revokeAllOtherSessions(userId: string, currentSessionId: string): Promise<void> {
  await prisma.userSession.updateMany({
    where: { userId, revokedAt: null, id: { not: currentSessionId } },
    data: { revokedAt: new Date() },
  });
  await audit({ actorId: userId, action: 'auth.revoke_all_other_sessions' });
}

export async function touchSession(sessionId: string): Promise<void> {
  await prisma.userSession.update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Sign-in (A-TOTPLOGIN: the password step always runs first; MFA is a
// server-side challenge tied to a cookie)
// ---------------------------------------------------------------------------

let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(randomToken(32));
  return dummyHashPromise;
}

export async function login(input: { email: string; password: string; ip?: string; userAgent?: string }): Promise<{
  user?: UserPublic;
  mfaRequired: boolean;
  methods: string[];
}> {
  const email = input.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  const key = user ? `user:${user.id}` : `email:${sha256hex(email)}`;
  await assertNotThrottled(key);
  const ok = await verifyPassword(user?.passwordHash ?? (await dummyHash()), input.password);
  if (!user || !ok || user.lockedAt || user.suspendedAt || user.deletionRequestedAt) {
    await recordFailure(key);
    throw new AuthError('BAD_CREDENTIALS', 'Invalid email or password.', 401);
  }
  if (user.totpEnabled) {
    return { mfaRequired: true, methods: ['totp', 'recovery_code'] };
  }
  await clearFailures(key);
  return { user: publicUser(user), mfaRequired: false, methods: [] };
}

/** Complete the MFA step with a TOTP or recovery code. Returns the session. */
export async function loginMfa(req: Request, input: { code?: string; recoveryCode?: string; ip?: string; userAgent?: string }): Promise<{ token: string; user: UserPublic }> {
  const ceremony = await readCeremonyFromReq(req);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ceremony.userId! } });
  await assertNotThrottled(`user:${user.id}`);
  let ok = false;
  if (input.code) ok = await verifyTotpForUser(user.id, input.code);
  else if (input.recoveryCode) ok = await consumeRecoveryCode(user.id, input.recoveryCode);
  if (!ok) {
    await recordFailure(`user:${user.id}`);
    const attempts = await prisma.authChallenge.update({ where: { id: ceremony.id }, data: { attempts: { increment: 1 } } });
    if (attempts.attempts >= 5) {
      await prisma.authChallenge.update({ where: { id: ceremony.id }, data: { consumedAt: new Date() } });
    }
    throw new AuthError('MFA_FAILED', 'The code was not accepted.', 401);
  }
  await consumeCeremonyFrom(ceremony.id);
  await clearFailures(`user:${user.id}`);
  const { token } = await createSession(user.id, input.ip, input.userAgent);
  await audit({ actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, ip: input.ip });
  return { token, user: publicUser(user) };
}

// ---------------------------------------------------------------------------
// Password reset (uniform response; throttled in routes)
// ---------------------------------------------------------------------------

export async function requestPasswordReset(email: string): Promise<{ ok: true }> {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) return { ok: true }; // do not reveal account existence
  const token = randomToken();
  await prisma.passwordReset.create({ data: { userId: user.id, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 3600_000) } });
  const link = `${env.PUBLIC_URL}/reset-password?token=${encodeURIComponent(token)}`;
  await sendMail({
    to: user.email,
    subject: 'Reset your VoltLink password',
    text: `A password reset was requested for your VoltLink account.\nOpen this link to choose a new password:\n${link}\n\nIf you did not request this, you can ignore this email.`,
    html: `<p>A password reset was requested for your VoltLink account.</p><p><a href="${escapeHtml(link)}">Choose a new password</a></p><p>If you did not request this, ignore this email.</p>`,
  });
  echoableToken(token);
  return { ok: true };
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  if (newPassword.length < 10) throw new AuthError('WEAK_PASSWORD', 'Password must be at least 10 characters.');
  const row = await prisma.passwordReset.findUnique({ where: { tokenHash: tokenHash(token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) throw new AuthError('INVALID_TOKEN', 'This reset link is invalid or expired.');
  await prisma.$transaction([
    prisma.passwordReset.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash: await hashPassword(newPassword), lockedAt: null } }),
    prisma.userSession.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await clearFailures(`user:${row.userId}`);
  await audit({ actorId: row.userId, action: 'auth.password_reset', entityType: 'user', entityId: row.userId });
}

// ---------------------------------------------------------------------------
// TOTP (otplib v13; sealed secret; replay-safe via totpLastStep)
// ---------------------------------------------------------------------------

export async function verifyTotpForUser(userId: string, token: string): Promise<boolean> {
  if (!/^\d{6}$/.test(token)) return false;
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { totpSecretSealed: true, totpLastStep: true } });
  if (!u.totpSecretSealed) return false;
  let secret: string;
  try {
    secret = open(u.totpSecretSealed, `totp:${userId}`);
  } catch {
    return false;
  }
  const r = await verify({
    secret,
    token,
    epochTolerance: 30,
    afterTimeStep: u.totpLastStep === null ? undefined : Number(u.totpLastStep),
  });
  if (!r.valid || !('timeStep' in r)) return false;
  const advanced = await prisma.user.updateMany({
    where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: BigInt(r.timeStep) } }] },
    data: { totpLastStep: BigInt(r.timeStep) },
  });
  return advanced.count === 1;
}

export async function totpSetup(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.totpEnabled) throw new AuthError('TOTP_ALREADY_ENABLED', 'TOTP is already enabled; disable it first to replace it.', 409);
  const secret = generateSecret();
  await prisma.user.update({
    where: { id: userId },
    data: { totpPendingSealed: seal(secret, `totp-pending:${userId}`).ciphertext, totpPendingExpiresAt: new Date(Date.now() + 600_000) },
  });
  const otpauthUrl = generateURI({ issuer: env.TOTP_ISSUER, label: user.email, secret });
  return { secret, otpauthUrl };
}

export async function totpConfirm(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.totpPendingSealed || !user.totpPendingExpiresAt || user.totpPendingExpiresAt < new Date()) {
    throw new AuthError('NO_TOTP', 'Start TOTP setup first.');
  }
  let secret: string;
  try {
    secret = open(user.totpPendingSealed, `totp-pending:${userId}`);
  } catch {
    throw new AuthError('NO_TOTP', 'Start TOTP setup first.');
  }
  const r = await verify({ secret, token: code, epochTolerance: 30 });
  if (!r.valid || !('timeStep' in r)) throw new AuthError('BAD_TOTP', 'Invalid authentication code.');
  const recoveryCodes = generateRecoveryCodes();
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        totpSecretSealed: seal(secret, `totp:${userId}`).ciphertext,
        totpPendingSealed: null,
        totpPendingExpiresAt: null,
        totpLastStep: BigInt(r.timeStep),
        totpEnabled: true,
        totpEnabledAt: new Date(),
      },
    }),
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.recoveryCode.createMany({
      data: recoveryCodes.map((code) => ({ userId, codeHash: recoveryCodeHash(code) })),
    }),
  ]);
  await audit({ actorId: userId, action: 'auth.enable_totp', entityType: 'user', entityId: userId });
  return { recoveryCodes };
}

export async function totpDisable(userId: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.totpEnabled) throw new AuthError('NO_TOTP', 'TOTP is not enabled.', 400);
  const passkeys = await prisma.passkeyCredential.count({ where: { userId } });
  await prisma.user.update({ where: { id: userId }, data: { totpEnabled: false, totpSecretSealed: null, totpLastStep: null, totpEnabledAt: null } });
  if (passkeys === 0) await prisma.recoveryCode.deleteMany({ where: { userId } });
  await audit({ actorId: userId, action: 'auth.disable_totp', entityType: 'user', entityId: userId });
}

// ---------------------------------------------------------------------------
// Recovery codes (single use, stored hashed)
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = Array.from({ length: 16 }, () => CROCKFORD[crypto.randomInt(32)]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replaceAll('O', '0')
    .replaceAll('I', '1')
    .replaceAll('L', '1');
}

export function recoveryCodeHash(code: string): string {
  return sha256hex(`voltlink-recovery:${normalizeRecoveryCode(code)}`);
}

export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const hash = recoveryCodeHash(code);
  const consumed = await prisma.recoveryCode.updateMany({ where: { userId, codeHash: hash, usedAt: null }, data: { usedAt: new Date() } });
  return consumed.count === 1;
}

export async function regenerateRecoveryCodes(userId: string): Promise<{ recoveryCodes: string[] }> {
  const codes = generateRecoveryCodes();
  await prisma.$transaction([
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.recoveryCode.createMany({ data: codes.map((code) => ({ userId, codeHash: recoveryCodeHash(code) })) }),
  ]);
  await audit({ actorId: userId, action: 'auth.regenerate_recovery_codes', entityType: 'user', entityId: userId });
  return { recoveryCodes: codes };
}

// ---------------------------------------------------------------------------
// Passkeys (SimpleWebAuthn v14; challenges via AuthChallenge ceremonies)
// ---------------------------------------------------------------------------

export function webauthnRelyingParty() {
  const rpID = env.WEBAUTHN_RP_ID || new URL(env.PUBLIC_URL).hostname;
  const origin = new URL(env.PUBLIC_URL).origin;
  return { rpID, origin };
}

export async function passkeyRegistrationOptions(userId: string) {
  const { rpID, origin } = webauthnRelyingParty();
  void origin;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const creds = await prisma.passkeyCredential.findMany({ where: { userId } });
  const options = await generateRegistrationOptions({
    rpName: env.WEBAUTHN_RP_NAME,
    rpID,
    userName: user.email,
    userDisplayName: user.name,
    userID: isoBase64URL.toBuffer(user.webauthnUserId!),
    attestationType: 'none',
    excludeCredentials: creds.map((c) => ({ id: c.credentialId, transports: (c.transports as string[]) ?? [] })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  return options;
}

export async function verifyPasskeyRegistration(req: Request, userId: string, body: { name?: string; response: RegistrationResponseJSON }): Promise<void> {
  const { rpID, origin } = webauthnRelyingParty();
  const ch = await consumeCeremony(req, 'passkey_register');
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: ch.challenge ?? '',
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    throw new AuthError('PASSKEY_FAILED', 'Passkey registration failed.', 400);
  }
  if (!verification.verified || !verification.registrationInfo) throw new AuthError('PASSKEY_FAILED', 'Passkey registration failed.', 400);
  const { credential } = verification.registrationInfo;
  await prisma.passkeyCredential.create({
    data: {
      userId,
      credentialId: credential.id,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey, 'base64'),
      counter: BigInt(credential.counter),
      transports: JSON.parse(JSON.stringify(credential.transports ?? [])),
      deviceType: verification.registrationInfo.credentialDeviceType,
      backedUp: verification.registrationInfo.credentialBackedUp,
      name: (body.name ?? 'Passkey').trim().slice(0, 60) || 'Passkey',
    },
  });
  await audit({ actorId: userId, action: 'auth.add_passkey', entityType: 'user', entityId: userId });
}

export async function passkeyLoginOptions() {
  const { rpID } = webauthnRelyingParty();
  return generateAuthenticationOptions({ rpID, userVerification: 'required' });
}

export async function passkeyStepUpOptions(userId: string) {
  const { rpID } = webauthnRelyingParty();
  const creds = await prisma.passkeyCredential.findMany({ where: { userId } });
  return generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: (c.transports as string[]) ?? [] })) });
}

async function verifyPasskeyAssertion(
  req: Request,
  purpose: 'passkey_login' | 'stepup_passkey',
  body: { response: AuthenticationResponseJSON },
  credentialId: string,
  actor?: { kind: 'session'; userId: string; sessionId: string },
): Promise<{ verified: boolean; newCounter: number; backedUp: boolean }> {
  const { rpID, origin } = webauthnRelyingParty();
  const cred = await prisma.passkeyCredential.findUnique({ where: { credentialId } });
  if (!cred) throw new AuthError('PASSKEY_FAILED', 'Passkey sign-in failed.', 401); // same answer as a bad signature
  // Step-up is bound to this session: the passkey must belong to the session's
  // user, and a wrong-account attempt counts toward the step-up throttle.
  if (purpose === 'stepup_passkey') {
    if (!actor || cred.userId !== actor.userId) {
      await recordFailure(`user:${actor?.userId ?? cred.userId}`);
      throw new AccessDenied('PASSKEY_MISMATCH', 'This passkey does not belong to your account.', 403);
    }
  }
  await assertNotThrottled(`user:${cred.userId}`);
  const ch = await consumeCeremony(req, purpose);
  // The ceremony must have been created for this user and session.
  if (purpose === 'stepup_passkey') {
    if (ch.userId !== actor!.userId || ch.sessionId !== actor!.sessionId) {
      await recordFailure(`user:${actor!.userId}`);
      throw new AccessDenied('PASSKEY_MISMATCH', 'This step-up session does not belong to your account.', 403);
    }
  }
  try {
    const v = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: ch.challenge ?? '',
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: cred.credentialId,
        publicKey: isoBase64URL.toBuffer(cred.publicKey, 'base64'),
        counter: Number(cred.counter),
        transports: (cred.transports as string[]) ?? [],
      },
    });
    return { verified: v.verified, newCounter: v.authenticationInfo.newCounter, backedUp: v.authenticationInfo.credentialBackedUp };
  } catch {
    await recordFailure(`user:${cred.userId}`);
    throw new AuthError('PASSKEY_FAILED', 'Passkey sign-in failed.', 401);
  }
}

export async function passkeyLogin(req: Request, body: { response: AuthenticationResponseJSON }, ip?: string, userAgent?: string) {
  const credentialId = body.response?.id;
  if (!credentialId) throw new AuthError('PASSKEY_FAILED', 'Passkey sign-in failed.', 401);
  const result = await verifyPasskeyAssertion(req, 'passkey_login', body, credentialId);
  if (!result.verified) throw new AuthError('PASSKEY_FAILED', 'Passkey sign-in failed.', 401);
  const cred = await prisma.passkeyCredential.findUniqueOrThrow({ where: { credentialId } });
  await prisma.passkeyCredential.update({
    where: { id: cred.id },
    data: { counter: BigInt(result.newCounter), backedUp: result.backedUp, lastUsedAt: new Date() },
  });
  await clearFailures(`user:${cred.userId}`);
  const { token } = await createSession(cred.userId, ip, userAgent);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: cred.userId } });
  await audit({ actorId: cred.userId, action: 'auth.passkey_login', entityType: 'user', entityId: cred.userId, ip });
  return { token, user: publicUser(user) };
}

export async function listPasskeys(userId: string) {
  const rows = await prisma.passkeyCredential.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  return rows.map((r) => ({ id: r.id, name: r.name, backedUp: r.backedUp, lastUsedAt: r.lastUsedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() }));
}

export async function deletePasskey(userId: string, passkeyId: string): Promise<void> {
  const row = await prisma.passkeyCredential.findUnique({ where: { id: passkeyId } });
  if (!row || row.userId !== userId) throw new AuthError('NOT_FOUND', 'Passkey not found.', 404);
  await prisma.passkeyCredential.delete({ where: { id: passkeyId } });
  await audit({ actorId: userId, action: 'auth.remove_passkey', entityType: 'user', entityId: userId });
}

// ---------------------------------------------------------------------------
// Step-up (a server-side window bound to the session)
// ---------------------------------------------------------------------------

export async function stepUp(
  actor: { kind: 'session'; userId: string; sessionId: string },
  req: Request,
  input: { method: 'password' | 'totp' | 'recovery_code' | 'passkey'; password?: string; code?: string; response?: AuthenticationResponseJSON },
): Promise<{ stepUpUntil: string }> {
  await assertNotThrottled(`user:${actor.userId}`);
  let ok = false;
  const method = input.method;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
  if (input.method === 'password') {
    ok = await verifyPassword(user.passwordHash, input.password ?? '');
  } else if (input.method === 'totp') {
    ok = await verifyTotpForUser(actor.userId, input.code ?? '');
  } else if (input.method === 'recovery_code') {
    ok = await consumeRecoveryCode(actor.userId, input.code ?? '');
  } else if (input.method === 'passkey') {
    const credentialId = input.response?.id;
    if (!credentialId) ok = false;
    else {
      const result = await verifyPasskeyAssertion(req, 'stepup_passkey', { response: input.response! }, credentialId, actor);
      ok = result.verified;
    }
  }
  if (!ok) {
    await recordFailure(`user:${actor.userId}`);
    await audit({ actorId: actor.userId, action: 'auth.step_up_failed', entityType: 'session', entityId: actor.sessionId });
    throw new AuthError('STEP_UP_FAILED', 'Confirmation failed.', 401);
  }
  await clearFailures(`user:${actor.userId}`);
  const until = new Date(Date.now() + env.STEPUP_WINDOW_SEC * 1000);
  await prisma.userSession.update({ where: { id: actor.sessionId }, data: { stepUpAt: new Date(), stepUpMethod: method } });
  await audit({ actorId: actor.userId, action: 'auth.step_up', entityType: 'session', entityId: actor.sessionId });
  void method;
  return { stepUpUntil: until.toISOString() };
}

// ---------------------------------------------------------------------------
// Registration-mode admin helpers (Z-RETENTION / instance settings)
// ---------------------------------------------------------------------------

export async function setRegistrationMode(mode: 'invite' | 'open' | 'closed'): Promise<void> {
  if (mode === 'open' && !env.SMTP_URL) {
    throw new AuthError('SMTP_REQUIRED', 'Open registration requires an SMTP server (SMTP_URL).', 400);
  }
  await setSetting('instance.registrationMode', mode);
  await audit({ action: `admin.registration_mode_${mode}`, entityType: 'instance', entityId: 'registrationMode' });
}

// ceremony helpers used by routes
export async function readCeremonyFromReq(req: Request) {
  return readCeremony(req, 'mfa_login');
}

export async function createMfaCeremony(
  res: { cookie: (name: string, value: string, opts: unknown) => void },
  userId: string,
): Promise<void> {
  await createCeremony(res as Parameters<typeof createCeremony>[0], { purpose: 'mfa_login', userId });
}

export async function consumeCeremonyFrom(id: string): Promise<void> {
  await prisma.authChallenge.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: new Date() } });
}

// Provider routes: listing, readiness diagnostics, demo connection, Tesla OAuth
// flow, Tessie token connection, vehicle import, disconnection, and webhook
// ingestion (provider push where supported).

import crypto from 'node:crypto';
import { policyRouter, sessionActor } from '../authz/policy';
import { prisma } from '../core/db';
import { sha256hex, randomToken, sealJson, openJson } from '../core/crypto';
import { audit } from '../core/settings';
import {
  buildContext,
  connectDemoAccount,
  getProvider,
  removeCredentials,
  saveCredentials,
  listProviders,
} from '../providers/registry';
import { env } from '../core/env';
import { teslaAuthorizeUrl, teslaExchangeCode } from '../providers/tesla/oauth';
import { seedDemoWorld } from '../telemetry/seed';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { ingestVehicleState } from '../telemetry/ingest';
import { getQueue } from '../core/queue';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { validateWebhookUrl } from '../notifications/simpleWebhooks';

export const providersRouter = policyRouter('/api/v1/providers');

providersRouter.get('/', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const accounts = await prisma.providerAccount.findMany({
    where: {
      organization: {
        memberships: { some: { userId: sessionActor(req).userId, status: 'ACTIVE' } },
      },
    },
    include: { vehicles: { select: { id: true } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json({
    data: accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      label: a.label,
      status: a.status,
      demo: a.demo,
      lastSyncAt: a.lastSyncAt?.toISOString(),
      lastError: a.lastError ?? undefined,
      vehicleCount: a.vehicles.length,
      scopes: (a.scopes ?? []) as string[],
    })),
  });
});

providersRouter.get(
  '/readiness',
  { auth: 'session', target: { kind: 'none' } },
  async (req, res) => {
    const accounts = await prisma.providerAccount.findMany({
      where: {
        organization: {
          memberships: { some: { userId: sessionActor(req).userId, status: 'ACTIVE' } },
        },
      },
    });
    const out = [];
    for (const p of listProviders()) {
      if (!p.enabled && p.id !== 'mock') continue;
      const provider = getProvider(p.id);
      const account = accounts.find((a) => a.provider === p.id);
      const ctx = account ? await buildContext(account) : null;
      const readiness = ctx
        ? await provider.readiness(ctx).catch(() => ({
            ok: false,
            checks: [{ name: 'error', ok: false, detail: 'Readiness check failed.' }],
          }))
        : await provider
            .readiness({
              accountId: '',
              userId: sessionActor(req).userId,
              credentials: {},
              meta: { provider: p.id, label: p.label, demo: false, scopes: [] },
            })
            .catch(() => ({
              ok: false,
              checks: [{ name: 'error', ok: false, detail: 'Readiness check failed.' }],
            }));
      out.push({
        provider: p.id,
        label: p.label,
        configured: !!account,
        ok: readiness.ok,
        checks: readiness.checks,
        accountId: account?.id,
      });
    }
    res.json({ data: out });
  },
);

providersRouter.post(
  '/demo/connect',
  { auth: 'session', target: { kind: 'none' } },
  async (req, res) => {
    const actor = sessionActor(req);
    const membership = await prisma.membership.findFirst({
      where: { userId: actor.userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'No organization available.' } });
      return;
    }
    const { accountId, vehiclesImported } = await connectDemoAccount(
      membership.organizationId,
      actor.userId,
    );
    const vehicles = await prisma.vehicle.findMany({
      where: { providerAccountId: accountId },
      select: { id: true, providerVehicleId: true },
    });
    await seedDemoWorld(membership.organizationId, actor.userId, vehicles);
    res.json({
      data: {
        accountId,
        vehiclesImported,
        demo: true,
        note: 'Demo mode uses fictional data and never contacts real services.',
      },
    });
  },
);

// ---- Tesla OAuth ----

providersRouter.get(
  '/tesla/authorize',
  { auth: 'session', target: { kind: 'none' } },
  async (req, res) => {
    if (!env.TESLA_CLIENT_ID || !env.TESLA_CLIENT_SECRET) {
      res.status(503).json({
        error: {
          code: 'NOT_CONFIGURED',
          message:
            'Tesla OAuth is not configured. Set TESLA_CLIENT_ID, TESLA_CLIENT_SECRET, and TESLA_REDIRECT_URI (docs/TESLA_SETUP.md).',
        },
      });
      return;
    }
    const actor = sessionActor(req);
    const membership = await prisma.membership.findFirst({
      where: { userId: actor.userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'No organization available.' } });
      return;
    }
    const pending = await prisma.oAuthState.count({
      where: { sessionId: actor.sessionId, expiresAt: { gt: new Date() } },
    });
    if (pending >= 5) {
      res
        .status(429)
        .json({ error: { code: 'RATE_LIMITED', message: 'Too many pending Tesla sign-ins.' } });
      return;
    }
    // Z-TESLASTATE: a server-stored random state bound to this user AND this
    // session; the callback never reads a user id out of the state. PKCE S256.
    const verifier = randomToken(32);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = randomToken(24);
    await prisma.oAuthState.create({
      data: {
        stateHash: sha256hex(state),
        provider: 'tesla',
        userId: actor.userId,
        sessionId: actor.sessionId,
        organizationId: membership.organizationId,
        verifierSealed: sealJson({ verifier }).ciphertext,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    res.json({ data: { url: teslaAuthorizeUrl(state, challenge) } });
  },
);

providersRouter.get(
  '/tesla/callback',
  { auth: 'session', target: { kind: 'none' } },
  async (req, res) => {
    const code = String(req.query.code ?? '');
    const stateRaw = String(req.query.state ?? '');
    const fail = () => res.redirect(`${env.PUBLIC_URL}/providers?tesla_error=invalid_state`);
    if (!code || !stateRaw) return fail();
    // Single-use, session-bound state: an atomic delete makes a foreign session,
    // a reused state or an expired state fail with no account created.
    const row = await prisma.oAuthState.findUnique({ where: { stateHash: sha256hex(stateRaw) } });
    if (
      !row ||
      row.provider !== 'tesla' ||
      row.sessionId !== sessionActor(req).sessionId ||
      row.expiresAt <= new Date()
    )
      return fail();
    await prisma.oAuthState.delete({ where: { stateHash: row.stateHash } }).catch(() => undefined);
    // Re-check the org permission: a member who lost providers.manage since
    // authorize gets no account either.
    const membership = await prisma.membership.findUnique({
      where: { organizationId_userId: { organizationId: row.organizationId, userId: row.userId } },
    });
    if (!membership || membership.status !== 'ACTIVE') return fail();
    const { orgPermissions } = await import('../authz/access');
    const perms = await orgPermissions(sessionActor(req), row.organizationId);
    if (!perms.has('providers.manage')) return fail();
    try {
      const verifier = openJson<{ verifier: string }>(row.verifierSealed).verifier;
      const tokens = await teslaExchangeCode(code, verifier);
      // P-TESLAREGION: persist the discovered region + base URL per account.
      const { discoverRegion } = await import('../providers/tesla/region');
      const region = await discoverRegion(tokens.accessToken).catch(() => null);
      const account = await prisma.providerAccount.create({
        data: {
          organizationId: row.organizationId,
          connectedById: row.userId,
          provider: 'tesla',
          label: 'Tesla',
          status: 'connected',
          region: region?.region,
          fleetApiBaseUrl: region?.baseUrl,
          tokenExpiresAt: new Date(tokens.expiresAt),
          scopes: JSON.parse(JSON.stringify(tokens.scopes)),
        },
      });
      await saveCredentials(account.id, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: String(tokens.expiresAt),
        scopes: tokens.scopes,
      });
      await audit({
        actorId: row.userId,
        organizationId: row.organizationId,
        action: 'provider.connect_tesla',
        entityType: 'provider',
        entityId: account.id,
      });
      res.redirect(`/providers?connected=tesla&account=${account.id}`);
    } catch {
      res.redirect(`${env.PUBLIC_URL}/providers?tesla_error=exchange_failed`);
    }
  },
);

// ---- Tessie (optional) ----

providersRouter.post(
  '/tessie/connect',
  { auth: 'session', target: { kind: 'none' } },
  async (req, res) => {
    const { token, label } = (req.body ?? {}) as { token?: string; label?: string };
    if (!token || token.length < 8) {
      res
        .status(400)
        .json({ error: { code: 'VALIDATION', message: 'A valid Tessie API token is required.' } });
      return;
    }
    const actor = sessionActor(req);
    const membership = await prisma.membership.findFirst({
      where: { userId: actor.userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'No organization available.' } });
      return;
    }
    // G-05: verify the token against Tessie before storing it, and store the
    // account as 'connected' so Import is available right away.
    const tessieBase = process.env.TESSIE_BASE_URL || 'https://api.tessie.com';
    try {
      const check = await fetch(`${tessieBase}/vins`, {
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!check.ok) {
        res.status(400).json({
          error: { code: 'INVALID_TOKEN', message: `Tessie rejected the token (${check.status}).` },
        });
        return;
      }
    } catch (err) {
      res.status(502).json({
        error: {
          code: 'UNREACHABLE',
          message: `Could not reach Tessie: ${(err as Error).message.slice(0, 100)}`,
        },
      });
      return;
    }
    const account = await prisma.providerAccount.create({
      data: {
        organizationId: membership.organizationId,
        connectedById: actor.userId,
        provider: 'tessie',
        label: label?.slice(0, 60) || 'Tessie',
        status: 'connected',
        scopes: JSON.parse('["user_token"]'),
      },
    });
    await saveCredentials(account.id, { token });
    await audit({
      actorId: sessionActor(req).userId,
      action: 'provider.connect_tessie',
      entityType: 'provider',
      entityId: account.id,
    });
    res.status(201).json({ data: { accountId: account.id, status: 'connected' } });
  },
);

// ---- Import vehicles for a connected account ----

providersRouter.post(
  '/:accountId/import',
  {
    auth: 'session',
    target: {
      kind: 'resource',
      resource: 'providerAccount',
      from: 'param:accountId',
      perm: 'providers.manage',
    },
  },
  async (req, res) => {
    const account = await prisma.providerAccount.findUnique({
      where: { id: String(req.params.accountId) },
      include: { vehicles: true },
    });
    const membership = await prisma.membership.findFirst({
      where: {
        userId: sessionActor(req).userId,
        status: 'ACTIVE',
        organizationId: account?.organizationId,
      },
    });
    if (!account || !membership) {
      res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'Provider account not found.' } });
      return;
    }
    try {
      const ctx = await buildContext(account);
      const provider = getProvider(account.provider);
      const descriptors = await provider.listVehicles(ctx);
      let imported = 0;
      for (const d of descriptors) {
        const existing = await prisma.vehicle.findUnique({
          where: {
            provider_providerVehicleId_providerAccountId: {
              provider: account.provider,
              providerVehicleId: d.providerVehicleId,
              providerAccountId: account.id,
            },
          },
        });
        if (existing) continue;
        await prisma.vehicle.create({
          data: {
            organizationId: account.organizationId,
            addedById: sessionActor(req).userId,
            providerAccountId: account.id,
            provider: account.provider,
            providerVehicleId: d.providerVehicleId,
            displayName: d.displayName,
            make: d.make,
            model: d.model,
            year: d.year,
            vehicleClass: d.vehicleClass,
            exteriorColor: d.exteriorColor ?? '#8b9bb4',
            wheelStyle: d.wheelStyle,
            vinLast4: d.vinLast4,
            capabilities: JSON.parse(JSON.stringify(d.capabilities)),
            demo: account.demo,
          },
        });
        imported++;
        await getQueue().enqueue('telemetry', {
          accountId: account.id,
          vehicleId: (
            await prisma.vehicle.findUniqueOrThrow({
              where: {
                provider_providerVehicleId_providerAccountId: {
                  provider: account.provider,
                  providerVehicleId: d.providerVehicleId,
                  providerAccountId: account.id,
                },
              },
            })
          ).id,
          providerVehicleId: d.providerVehicleId,
        });
      }
      await prisma.providerAccount.update({
        where: { id: account.id },
        data: { status: 'connected', lastSyncAt: new Date(), lastError: null },
      });
      await audit({
        actorId: sessionActor(req).userId,
        action: 'provider.import_vehicles',
        entityType: 'provider',
        entityId: account.id,
        details: { imported },
      });
      res.json({ data: { imported, total: descriptors.length } });
    } catch (err) {
      await prisma.providerAccount.update({
        where: { id: account.id },
        data: { status: 'error', lastError: (err as Error).message.slice(0, 500) },
      });
      res
        .status(502)
        .json({ error: { code: 'IMPORT_FAILED', message: (err as Error).message.slice(0, 300) } });
    }
  },
);

// ---- Disconnect: revoke vehicles + remove encrypted credentials ----

providersRouter.post(
  '/:accountId/disconnect',
  {
    auth: 'session',
    target: {
      kind: 'resource',
      resource: 'providerAccount',
      from: 'param:accountId',
      perm: 'providers.manage',
    },
  },
  async (req, res) => {
    const account = await prisma.providerAccount.findUnique({
      where: { id: String(req.params.accountId) },
    });
    const membership = await prisma.membership.findFirst({
      where: {
        userId: sessionActor(req).userId,
        status: 'ACTIVE',
        organizationId: account?.organizationId,
      },
    });
    if (!account || !membership) {
      res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'Provider account not found.' } });
      return;
    }
    await prisma.vehicle.updateMany({
      where: { providerAccountId: account.id },
      data: { active: false },
    });
    await removeCredentials(account.id);
    await prisma.providerAccount.update({ where: { id: account.id }, data: { status: 'revoked' } });
    await audit({
      actorId: sessionActor(req).userId,
      action: 'provider.disconnect',
      entityType: 'provider',
      entityId: account.id,
    });
    res.json({
      data: {
        ok: true,
        note: 'Stored credentials were removed. Revoke access on the provider side as well.',
      },
    });
  },
);

// ---- Provider webhook ingestion (for providers that support push) ----

providersRouter.post(
  '/:provider/webhook',
  { auth: 'session', target: { kind: 'none' } },
  async (req, res) => {
    const provider = String(req.params.provider);
    // Z-INBOUNDWH (Tessie part) + guide 01 §14: Tessie has no webhook API
    // and Tesla telemetry arrives another way — only the demo hook remains.
    if (!['demo'].includes(provider)) {
      res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'This provider has no webhook.' } });
      return;
    }
    // Demo webhook: manual state injection for demo/test purposes only.
    if (provider === 'demo') {
      const body = (req.body ?? {}) as {
        vehicleId?: string;
        type?: string;
        payload?: Record<string, unknown>;
      };
      const vehicle = await prisma.vehicle.findFirst({ where: { id: body.vehicleId, demo: true } });
      if (vehicle) {
        if (body.type === 'trigger') {
          const { dispatchTrigger } = await import('../automations/engine');
          await dispatchTrigger({
            type: (body.payload?.type ?? 'webhook') as never,
            userId: sessionActor(req).userId,
            vehicleId: vehicle.id,
            data: body.payload ?? {},
          });
        }
      }
    }
    res.json({ data: { ok: true } });
  },
);

// ---- Demo provider degradation toggle (demo/testing) ----

// Z-DEMOSCOPE: demo degradation is scoped to the provider account's
// organization, never process-global.
providersRouter.post(
  '/:accountId/demo-degraded',
  {
    auth: 'session',
    target: {
      kind: 'resource',
      resource: 'providerAccount',
      from: 'param:accountId',
      perm: 'providers.manage',
    },
  },
  async (req, res) => {
    const account = await prisma.providerAccount.findUnique({
      where: { id: String(req.params.accountId) },
    });
    if (!account || account.provider !== 'demo') {
      res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'Demo provider account not found.' } });
      return;
    }
    const { degraded } = (req.body ?? {}) as { degraded?: boolean };
    if (typeof degraded !== 'boolean') {
      res
        .status(400)
        .json({ error: { code: 'VALIDATION', message: 'degraded boolean required.' } });
      return;
    }
    await prisma.organization.update({
      where: { id: account.organizationId },
      data: { demoDegraded: degraded },
    });
    await audit({
      actorId: sessionActor(req).userId,
      organizationId: account.organizationId,
      action: 'provider.demo_degraded',
      entityType: 'provider',
      entityId: account.id,
      details: { degraded },
    });
    res.json({ data: { degraded } });
  },
);

// Provider routes: listing, readiness diagnostics, demo connection, Tesla OAuth
// flow, Tessie token connection, vehicle import, disconnection, and webhook
// ingestion (provider push where supported).

import { policyRouter, sessionActor } from '../authz/policy';
import { prisma } from '../core/db';
import { audit } from '../core/settings';
import { buildContext, connectDemoAccount, getProvider, removeCredentials, saveCredentials, listProviders } from '../providers/registry';
import { env } from '../core/env';
import { teslaAuthorizeUrl, teslaExchangeCode } from '../providers/tesla';
import { seedDemoWorld } from '../telemetry/seed';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { ingestVehicleState } from '../telemetry/ingest';
import { getQueue } from '../core/queue';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { validateWebhookUrl } from '../notifications/simpleWebhooks';

export const providersRouter = policyRouter('/api/v1/providers');

providersRouter.get('/', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const accounts = await prisma.providerAccount.findMany({
    where: { organization: { memberships: { some: { userId: sessionActor(req).userId, status: 'ACTIVE' } } } },
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

providersRouter.get('/readiness', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const accounts = await prisma.providerAccount.findMany({
    where: { organization: { memberships: { some: { userId: sessionActor(req).userId, status: 'ACTIVE' } } } },
  });
  const out = [];
  for (const p of listProviders()) {
    if (!p.enabled && p.id !== 'mock') continue;
    const provider = getProvider(p.id);
    const account = accounts.find((a) => a.provider === p.id);
    const ctx = account ? await buildContext(account) : null;
    const readiness = ctx ? await provider.readiness(ctx).catch(() => ({ ok: false, checks: [{ name: 'error', ok: false, detail: 'Readiness check failed.' }] })) : await provider.readiness({ accountId: '', userId: sessionActor(req).userId, credentials: {}, meta: { provider: p.id, label: p.label, demo: false, scopes: [] } }).catch(() => ({ ok: false, checks: [{ name: 'error', ok: false, detail: 'Readiness check failed.' }] }));
    out.push({ provider: p.id, label: p.label, configured: !!account, ok: readiness.ok, checks: readiness.checks, accountId: account?.id });
  }
  res.json({ data: out });
});

providersRouter.post('/demo/connect', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const actor = sessionActor(req);
  const membership = await prisma.membership.findFirst({ where: { userId: actor.userId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  if (!membership) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'No organization available.' } });
    return;
  }
  const { accountId, vehiclesImported } = await connectDemoAccount(membership.organizationId, actor.userId);
  const vehicles = await prisma.vehicle.findMany({ where: { providerAccountId: accountId }, select: { id: true, providerVehicleId: true } });
  await seedDemoWorld(membership.organizationId, actor.userId, vehicles);
  res.json({ data: { accountId, vehiclesImported, demo: true, note: 'Demo mode uses fictional data and never contacts real services.' } });
});

// ---- Tesla OAuth ----

providersRouter.get('/tesla/authorize', { auth: 'session', target: { kind: 'none' } }, (req, res) => {
  if (!env.TESLA_CLIENT_ID || !env.TESLA_CLIENT_SECRET) {
    res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'Tesla OAuth is not configured. Set TESLA_CLIENT_ID, TESLA_CLIENT_SECRET, and TESLA_REDIRECT_URI (docs/TESLA_SETUP.md).' } });
    return;
  }
  const state = encodeURIComponent(JSON.stringify({ u: sessionActor(req).userId }));
  res.json({ data: { url: teslaAuthorizeUrl(state) } });
});

providersRouter.get('/tesla/callback', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const code = String(req.query.code ?? '');
  const stateRaw = String(req.query.state ?? '{}');
  let state: { u?: string } = {};
  try {
    state = JSON.parse(decodeURIComponent(stateRaw));
  } catch {
    /* invalid state */
  }
  if (!code || !state.u) {
    res.status(400).send('Invalid OAuth callback. Return to the app and try again.');
    return;
  }
  try {
    const tokens = await teslaExchangeCode(code);
    const membership = await prisma.membership.findFirst({ where: { userId: state.u, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
    if (!membership) {
      res.status(403).send('No organization available for this account. Return to the app and try again.');
      return;
    }
    const account = await prisma.providerAccount.create({
      data: {
        organizationId: membership.organizationId,
        connectedById: state.u,
        provider: 'tesla',
        label: 'Tesla',
        status: 'connected',
        scopes: JSON.parse(JSON.stringify(tokens.scope ? String(tokens.scope).split(' ') : ['vehicle_device_data', 'vehicle_cmds'])),
      },
    });
    await saveCredentials(account.id, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? '',
      tokenType: tokens.token_type,
      expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : undefined,
      scopes: account.scopes as string[],
      regionBase: env.TESLA_BASE_URL,
    });
    await audit({ actorId: state.u, action: 'provider.connect_tesla', entityType: 'provider', entityId: account.id });
    res.redirect(`/providers?connected=tesla&account=${account.id}`);
  } catch (err) {
    res.status(502).send(`Tesla connection failed: ${(err as Error).message}`);
  }
});

// ---- Tessie (optional) ----

providersRouter.post('/tessie/connect', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const { token, label } = (req.body ?? {}) as { token?: string; label?: string };
  if (!token || token.length < 8) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'A valid Tessie API token is required.' } });
    return;
  }
  const actor = sessionActor(req);
  const membership = await prisma.membership.findFirst({ where: { userId: actor.userId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  if (!membership) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'No organization available.' } });
    return;
  }
  const account = await prisma.providerAccount.create({
    data: { organizationId: membership.organizationId, connectedById: actor.userId, provider: 'tessie', label: label?.slice(0, 60) || 'Tessie', status: 'pending', scopes: JSON.parse('["user_token"]') },
  });
  await saveCredentials(account.id, { token });
  await audit({ actorId: sessionActor(req).userId, action: 'provider.connect_tessie', entityType: 'provider', entityId: account.id });
  res.status(201).json({ data: { accountId: account.id, status: 'pending' } });
});

// ---- Import vehicles for a connected account ----

providersRouter.post('/:accountId/import', { auth: 'session', target: { kind: 'resource', resource: 'providerAccount', from: 'param:accountId', perm: 'providers.manage' } }, async (req, res) => {
  const account = await prisma.providerAccount.findUnique({ where: { id: String(req.params.accountId) }, include: { vehicles: true } });
  const membership = await prisma.membership.findFirst({ where: { userId: sessionActor(req).userId, status: 'ACTIVE', organizationId: account?.organizationId } });
  if (!account || !membership) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Provider account not found.' } });
    return;
  }
  try {
    const ctx = await buildContext(account);
    const provider = getProvider(account.provider);
    const descriptors = await provider.listVehicles(ctx);
    let imported = 0;
    for (const d of descriptors) {
      const existing = await prisma.vehicle.findUnique({
        where: { provider_providerVehicleId_providerAccountId: { provider: account.provider, providerVehicleId: d.providerVehicleId, providerAccountId: account.id } },
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
      await getQueue().enqueue('telemetry', { accountId: account.id, vehicleId: (await prisma.vehicle.findUniqueOrThrow({ where: { provider_providerVehicleId_providerAccountId: { provider: account.provider, providerVehicleId: d.providerVehicleId, providerAccountId: account.id } } })).id, providerVehicleId: d.providerVehicleId });
    }
    await prisma.providerAccount.update({ where: { id: account.id }, data: { status: 'connected', lastSyncAt: new Date(), lastError: null } });
    await audit({ actorId: sessionActor(req).userId, action: 'provider.import_vehicles', entityType: 'provider', entityId: account.id, details: { imported } });
    res.json({ data: { imported, total: descriptors.length } });
  } catch (err) {
    await prisma.providerAccount.update({ where: { id: account.id }, data: { status: 'error', lastError: (err as Error).message.slice(0, 500) } });
    res.status(502).json({ error: { code: 'IMPORT_FAILED', message: (err as Error).message.slice(0, 300) } });
  }
});

// ---- Disconnect: revoke vehicles + remove encrypted credentials ----

providersRouter.post('/:accountId/disconnect', { auth: 'session', target: { kind: 'resource', resource: 'providerAccount', from: 'param:accountId', perm: 'providers.manage' } }, async (req, res) => {
  const account = await prisma.providerAccount.findUnique({ where: { id: String(req.params.accountId) } });
  const membership = await prisma.membership.findFirst({ where: { userId: sessionActor(req).userId, status: 'ACTIVE', organizationId: account?.organizationId } });
  if (!account || !membership) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Provider account not found.' } });
    return;
  }
  await prisma.vehicle.updateMany({ where: { providerAccountId: account.id }, data: { active: false } });
  await removeCredentials(account.id);
  await prisma.providerAccount.update({ where: { id: account.id }, data: { status: 'revoked' } });
  await audit({ actorId: sessionActor(req).userId, action: 'provider.disconnect', entityType: 'provider', entityId: account.id });
  res.json({ data: { ok: true, note: 'Stored credentials were removed. Revoke access on the provider side as well.' } });
});

// ---- Provider webhook ingestion (for providers that support push) ----

providersRouter.post('/:provider/webhook', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const provider = String(req.params.provider);
  if (!['tesla', 'tessie', 'demo'].includes(provider)) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown provider webhook.' } });
    return;
  }
  // Demo webhook: manual state injection for demo/test purposes only.
  if (provider === 'demo') {
    const body = (req.body ?? {}) as { vehicleId?: string; type?: string; payload?: Record<string, unknown> };
    const vehicle = await prisma.vehicle.findFirst({ where: { id: body.vehicleId, demo: true } });
    if (vehicle) {
      if (body.type === 'trigger') {
        const { dispatchTrigger } = await import('../automations/engine');
        await dispatchTrigger({ type: (body.payload?.type ?? 'webhook') as never, userId: sessionActor(req).userId, vehicleId: vehicle.id, data: body.payload ?? {} });
      }
    }
  }
  res.json({ data: { ok: true } });
});

// ---- Demo provider degradation toggle (demo/testing) ----

providersRouter.post('/demo/degraded', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const { degraded } = (req.body ?? {}) as { degraded?: boolean };
  const { setDemoDegraded } = await import('../providers/demo');
  setDemoDegraded(!!degraded);
  res.json({ data: { degraded: !!degraded } });
});

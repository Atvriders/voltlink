// Status routes: public status JSON/RSS/badge, incident management,
// maintenance windows, component overrides, and subscriptions.

import { Router } from 'express';
import { prisma } from '../core/db';
import { env } from '../core/env';
import { requireAuth, requireRole } from '../auth/middleware';
import { publicStatusBundle, runStatusChecks, toIncidentDto, ensureComponents } from '../status/service';
import { randomToken } from '../core/crypto';

const statusPublicUrl = `${env.PUBLIC_URL}/status`;

export const statusRouter = Router();

// ---- Public endpoints (no auth) ----

statusRouter.get('/', async (_req, res) => {
  await ensureComponents();
  res.json({ data: await publicStatusBundle() });
});

statusRouter.get('/rss', async (_req, res) => {
  const bundle = (await publicStatusBundle()) as { incidents: { id: string; title: string; severity: string; status: string; updates: { message: string; createdAt: string }[] }[]; updatedAt: string };
  const items = bundle.incidents
    .slice(0, 20)
    .map(
      (i) => `<item><title>${escapeXml(i.title)}</title><link>${statusPublicUrl}</link><guid>${i.id}</guid><pubDate>${new Date(bundle.updatedAt).toUTCString()}</pubDate><description>${escapeXml(i.updates[0]?.message ?? i.status)}</description></item>`,
    )
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>VoltLink Status</title><link>${statusPublicUrl}</link><description>VoltLink platform status updates</description>${items}</channel></rss>`;
  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(xml);
});

statusRouter.get('/badge.svg', async (_req, res) => {
  const bundle = (await publicStatusBundle()) as { overall: string };
  const labels: Record<string, [string, string]> = {
    operational: ['Operational', '#2e7d32'],
    degraded: ['Degraded', '#f9a825'],
    partial_outage: ['Partial outage', '#ef6c00'],
    major_outage: ['Major outage', '#c62828'],
    maintenance: ['Maintenance', '#1565c0'],
    unknown: ['Unknown', '#607d8b'],
  };
  const [label, color] = (labels[bundle.overall] ?? labels.unknown) as [string, string];
  const width = 24 + label.length * 7 + 10;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20"><rect width="${width}" height="20" rx="4" fill="#424242"/><rect x="${width / 2}" width="${width / 2}" height="20" rx="0" fill="${color}"/><text x="6" y="14" font-family="Arial" font-size="11" fill="#fff">VoltLink</text><text x="${width / 2 + 6}" y="14" font-family="Arial" font-size="11" fill="#fff">${label}</text></svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.send(svg);
});

statusRouter.post('/subscribe', async (req, res) => {
  const { email } = (req.body ?? {}) as { email?: string };
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Valid email required.' } });
    return;
  }
  const token = randomToken(16);
  await prisma.statusSubscription.upsert({
    where: { email: email.toLowerCase() },
    update: {},
    create: { email: email.toLowerCase(), token },
  });
  res.json({ data: { ok: true, note: 'Subscription recorded. (Confirmation email requires SMTP configuration.)' } });
});

statusRouter.get('/subscriptions/confirm/:token', async (req, res) => {
  const sub = await prisma.statusSubscription.findUnique({ where: { token: req.params.token } });
  if (!sub) {
    res.status(404).send('Invalid confirmation token.');
    return;
  }
  await prisma.statusSubscription.update({ where: { id: sub.id }, data: { confirmed: true } });
  res.send('Subscription confirmed.');
});

// ---- Authenticated management ----

statusRouter.use(requireAuth);

statusRouter.get('/checks/history', async (req, res) => {
  const key = typeof req.query.key === 'string' ? req.query.key : undefined;
  const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24));
  const from = new Date(Date.now() - hours * 3600000);
  const rows = await prisma.statusCheck.findMany({
    where: { at: { gte: from }, ...(key ? { componentKey: String(key) } : {}) },
    orderBy: { at: 'desc' },
    take: 2000,
  });
  res.json({ data: rows.map((r) => ({ at: r.at.toISOString(), componentKey: r.componentKey, ok: r.ok, latencyMs: r.latencyMs ?? undefined, detail: r.detail ?? undefined })) });
});

statusRouter.post('/checks/run', requireRole('STATUS_MANAGER'), async (_req, res) => {
  await runStatusChecks();
  res.json({ data: { ok: true } });
});

statusRouter.patch('/components/:key', requireRole('STATUS_MANAGER'), async (req, res) => {
  const component = await prisma.statusComponent.findUnique({ where: { key: String(req.params.key) } });
  if (!component) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Component not found.' } });
    return;
  }
  const { status, manualOverride } = (req.body ?? {}) as { status?: string; manualOverride?: boolean };
  const valid = ['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance', 'unknown'];
  if (status && !valid.includes(status)) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid component status.' } });
    return;
  }
  await prisma.statusComponent.update({
    where: { key: component.key },
    data: { ...(status ? { status } : {}), ...(typeof manualOverride === 'boolean' ? { manualOverride } : {}), updatedAt: new Date() },
  });
  res.json({ data: { ok: true } });
});

// ---- Incidents ----

statusRouter.get('/incidents', async (_req, res) => {
  const incidents = await prisma.incident.findMany({ include: { updates: { orderBy: { createdAt: 'asc' } } }, orderBy: { createdAt: 'desc' } });
  res.json({ data: incidents.map(toIncidentDto) });
});

statusRouter.post('/incidents', requireRole('STATUS_MANAGER'), async (req, res) => {
  const { title, severity, components, public: isPublic, message } = (req.body ?? {}) as { title?: string; severity?: string; components?: string[]; public?: boolean; message?: string };
  if (!title) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Incident title required.' } });
    return;
  }
  const incident = await prisma.incident.create({
    data: {
      title: title.slice(0, 160),
      severity: ['minor', 'major', 'critical', 'maintenance'].includes(severity ?? '') ? severity : 'minor',
      status: 'investigating',
      phases: JSON.parse(JSON.stringify({ investigating: new Date().toISOString(), identified: null, monitoring: null, resolved: null })),
      components: JSON.parse(JSON.stringify(Array.isArray(components) ? components.slice(0, 20) : [])),
      public: isPublic !== false,
    },
  });
  if (message) {
    await prisma.incidentUpdate.create({ data: { incidentId: incident.id, phase: 'investigating', message: message.slice(0, 2000), author: req.user!.name } });
  }
  // reflect incident on components
  for (const key of (components ?? []).slice(0, 20)) {
    const c = await prisma.statusComponent.findUnique({ where: { key } });
    if (c && !c.manualOverride) {
      const sev = severity === 'critical' ? 'major_outage' : severity === 'major' ? 'partial_outage' : 'degraded';
      await prisma.statusComponent.update({ where: { key }, data: { status: sev, updatedAt: new Date() } });
    }
  }
  res.status(201).json({ data: { id: incident.id } });
});

statusRouter.post('/incidents/:id/updates', requireRole('STATUS_MANAGER'), async (req, res) => {
  const incident = await prisma.incident.findUnique({ where: { id: String(req.params.id) } });
  if (!incident) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Incident not found.' } });
    return;
  }
  const { phase, message } = (req.body ?? {}) as { phase?: string; message?: string };
  const phases = ['investigating', 'identified', 'monitoring', 'resolved'];
  if (!phases.includes(phase ?? '') || !message) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'phase and message required.' } });
    return;
  }
  const ph = phase as string;
  await prisma.incidentUpdate.create({ data: { incidentId: incident.id, phase: ph, message: message.slice(0, 2000), author: req.user!.name } });
  const current = (incident.phases ?? {}) as Record<string, string | null>;
  current[ph] = new Date().toISOString();
  await prisma.incident.update({ where: { id: incident.id }, data: { phases: current as never, status: ph } });
  if (ph === 'resolved') {
    // restore components that were degraded by this incident
    for (const key of (incident.components ?? []) as string[]) {
      const c = await prisma.statusComponent.findUnique({ where: { key } });
      if (c && !c.manualOverride) {
        await prisma.statusComponent.update({ where: { key }, data: { status: 'operational', updatedAt: new Date() } });
      }
    }
  }
  res.status(201).json({ data: { ok: true } });
});

statusRouter.patch('/incidents/:id', requireRole('STATUS_MANAGER'), async (req, res) => {
  const incident = await prisma.incident.findUnique({ where: { id: String(req.params.id) } });
  if (!incident) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Incident not found.' } });
    return;
  }
  const body = (req.body ?? {}) as { public?: boolean; title?: string };
  const data: Record<string, unknown> = {};
  if (typeof body.public === 'boolean') data.public = body.public;
  if (typeof body.title === 'string') data.title = body.title.slice(0, 160);
  await prisma.incident.update({ where: { id: incident.id }, data });
  res.json({ data: { ok: true } });
});

// ---- Maintenance windows ----

statusRouter.get('/maintenance', async (_req, res) => {
  const rows = await prisma.maintenanceWindow.findMany({ orderBy: { startsAt: 'desc' }, take: 30 });
  res.json({ data: rows.map((m) => ({ ...m, startsAt: m.startsAt.toISOString(), endsAt: m.endsAt.toISOString(), components: m.components ?? [] })) });
});

statusRouter.post('/maintenance', requireRole('STATUS_MANAGER'), async (req, res) => {
  const { title, description, startsAt, endsAt, components } = (req.body ?? {}) as Record<string, unknown>;
  if (!title || !startsAt || !endsAt) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'title, startsAt, endsAt required.' } });
    return;
  }
  const m = await prisma.maintenanceWindow.create({
    data: {
      title: String(title).slice(0, 160),
      description: typeof description === 'string' ? description.slice(0, 1000) : null,
      startsAt: new Date(String(startsAt)),
      endsAt: new Date(String(endsAt)),
      components: JSON.parse(JSON.stringify(Array.isArray(components) ? components.slice(0, 20) : [])),
    },
  });
  for (const key of (Array.isArray(components) ? components.slice(0, 20) : []) as string[]) {
    const c = await prisma.statusComponent.findUnique({ where: { key } });
    if (c && !c.manualOverride) await prisma.statusComponent.update({ where: { key }, data: { status: 'maintenance', updatedAt: new Date() } });
  }
  res.status(201).json({ data: { id: m.id } });
});

statusRouter.patch('/maintenance/:id', requireRole('STATUS_MANAGER'), async (req, res) => {
  const m = await prisma.maintenanceWindow.findUnique({ where: { id: String(req.params.id) } });
  if (!m) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Maintenance window not found.' } });
    return;
  }
  const { status } = (req.body ?? {}) as { status?: string };
  await prisma.maintenanceWindow.update({ where: { id: m.id }, data: { status: ['scheduled', 'in_progress', 'completed'].includes(status ?? '') ? status : m.status } });
  if (status === 'completed') {
    for (const key of (m.components ?? []) as string[]) {
      const c = await prisma.statusComponent.findUnique({ where: { key } });
      if (c && !c.manualOverride) await prisma.statusComponent.update({ where: { key }, data: { status: 'operational', updatedAt: new Date() } });
    }
  }
  res.json({ data: { ok: true } });
});

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

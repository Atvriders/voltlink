// Private status administration: components, automated checks, incident
// manager, maintenance windows, subscriptions.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ExternalLink, Plus, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { Badge, Button, Card, Field, Input, Modal, Select } from '../components/ui';
import { fmtClock } from '../lib/format';
import type { Incident, PublicStatus, StatusComponent, StatusCheckHistory } from '@voltlink/shared';

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'info' | 'neutral'> = {
  operational: 'ok',
  degraded: 'warn',
  partial_outage: 'warn',
  major_outage: 'danger',
  maintenance: 'info',
  unknown: 'neutral',
};

export default function StatusAdminPage() {
  const qc = useQueryClient();
  const { data: bundle } = useQuery({
    queryKey: ['public-status'],
    queryFn: () => api<PublicStatus>('/api/v1/status'),
    refetchInterval: 30000,
  });
  const { data: history } = useQuery({
    queryKey: ['status-history'],
    queryFn: () => api<StatusCheckHistory[]>('/api/v1/status/checks/history?hours=24'),
  });
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [maintOpen, setMaintOpen] = useState(false);
  const [updateFor, setUpdateFor] = useState<Incident | null>(null);

  const runChecks = useMutation({
    mutationFn: () => api('/api/v1/status/checks/run', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['public-status'] });
      qc.invalidateQueries({ queryKey: ['status-history'] });
    },
  });

  const uptime30 = bundle?.uptime30dPct ?? 100;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-extrabold">Status</h1>
        <Badge tone={STATUS_TONE[bundle?.overall ?? 'unknown']}>
          {bundle?.overall.replace('_', ' ') ?? 'loading'}
        </Badge>
        <span className="text-xs text-faint">30-day uptime: {uptime30}%</span>
        <div className="ml-auto flex gap-2">
          <Link
            to="/status"
            className="flex items-center gap-1 text-xs text-accent hover:underline"
          >
            <ExternalLink size={12} /> Public status page
          </Link>
          <Button
            variant="secondary"
            loading={runChecks.isPending}
            onClick={() => runChecks.mutate()}
          >
            <RefreshCw size={13} /> Run checks
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <Card title="Components" subtitle="Manual overrides take priority over automated checks">
            <div className="grid gap-2 sm:grid-cols-2">
              {(bundle?.components ?? []).map((c) => (
                <ComponentRow key={c.key} component={c} />
              ))}
            </div>
          </Card>

          <Card
            title="Incidents"
            actions={
              <Button onClick={() => setIncidentOpen(true)}>
                <Plus size={13} /> New incident
              </Button>
            }
          >
            <IncidentList />
          </Card>
        </div>

        <div className="space-y-4">
          <Card
            title="Maintenance windows"
            actions={
              <Button variant="secondary" onClick={() => setMaintOpen(true)}>
                <CalendarClock size={13} /> Schedule
              </Button>
            }
          >
            <ul className="space-y-2">
              {(bundle?.maintenance ?? []).map((m) => (
                <li
                  key={m.id}
                  className="rounded-lg border border-line bg-panel2 px-3 py-2 text-sm"
                >
                  <p className="font-medium">{m.title}</p>
                  <p className="text-xs text-subtle">
                    {new Date(m.startsAt).toLocaleString()} → {new Date(m.endsAt).toLocaleString()}
                  </p>
                </li>
              ))}
              {(bundle?.maintenance ?? []).length === 0 && (
                <p className="py-2 text-sm text-faint">No scheduled maintenance.</p>
              )}
            </ul>
          </Card>

          <Card title="Response times (24h)" subtitle="Automated check latency">
            <ResponseChart history={history ?? []} />
          </Card>
        </div>
      </div>

      <IncidentModal open={incidentOpen} onClose={() => setIncidentOpen(false)} />
      <MaintenanceModal open={maintOpen} onClose={() => setMaintOpen(false)} />
      <IncidentUpdateModal incident={updateFor} onClose={() => setUpdateFor(null)} />
    </div>
  );
}

function ComponentRow({ component }: { component: StatusComponent }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string>(component.status);
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/status/components/${component.key}`, {
        method: 'PATCH',
        body: { status, manualOverride: true },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['public-status'] });
      setOpen(false);
    },
  });
  const clear = useMutation({
    mutationFn: () =>
      api(`/api/v1/status/components/${component.key}`, {
        method: 'PATCH',
        body: { manualOverride: false },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['public-status'] });
    },
  });
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-panel2 px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{component.name}</p>
        <p className="text-[10px] uppercase tracking-wide text-faint">{component.group}</p>
      </div>
      <div className="flex items-center gap-2">
        {component.manualOverride && <Badge tone="warn">manual</Badge>}
        <Badge tone={STATUS_TONE[component.status]}>{component.status.replace('_', ' ')}</Badge>
        <button
          className="text-xs text-accent hover:underline"
          onClick={() => {
            setOpen(true);
            setStatus(component.status);
          }}
        >
          edit
        </button>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title={`Override ${component.name}`}>
        <div className="space-y-3">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              {[
                'operational',
                'degraded',
                'partial_outage',
                'major_outage',
                'maintenance',
                'unknown',
              ].map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            {component.manualOverride && (
              <Button variant="ghost" onClick={() => clear.mutate()}>
                Clear override
              </Button>
            )}
            <Button onClick={() => save.mutate()}>Apply</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function IncidentList() {
  const qc = useQueryClient();
  const { data: incidents } = useQuery({
    queryKey: ['incidents'],
    queryFn: () => api<Incident[]>('/api/v1/status/incidents'),
  });
  const [updateFor, setUpdateFor] = useState<Incident | null>(null);
  const togglePublic = useMutation({
    mutationFn: (i: Incident) =>
      api(`/api/v1/status/incidents/${i.id}`, { method: 'PATCH', body: { public: !i.public } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['incidents'] }),
  });
  return (
    <>
      <ul className="space-y-2">
        {(incidents ?? []).map((i) => (
          <li key={i.id} className="rounded-lg border border-line bg-panel2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{i.title}</span>
              <Badge
                tone={
                  i.severity === 'critical' ? 'danger' : i.severity === 'major' ? 'warn' : 'info'
                }
              >
                {i.severity}
              </Badge>
              <Badge tone={i.status === 'resolved' ? 'ok' : 'warn'}>{i.status}</Badge>
              <Badge tone="neutral">{i.public ? 'public' : 'private'}</Badge>
              <div className="ml-auto flex gap-1">
                {i.status !== 'resolved' && (
                  <Button
                    variant="secondary"
                    className="px-2 py-1 text-xs"
                    onClick={() => setUpdateFor(i)}
                  >
                    Update
                  </Button>
                )}
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  onClick={() => togglePublic.mutate(i)}
                >
                  Make {i.public ? 'private' : 'public'}
                </Button>
              </div>
            </div>
            <ul className="mt-2 space-y-1">
              {i.updates.map((u) => (
                <li key={u.id} className="text-xs text-subtle">
                  <span className="font-semibold capitalize">{u.phase}</span> ·{' '}
                  {fmtClock(u.createdAt)} — {u.message}
                </li>
              ))}
            </ul>
          </li>
        ))}
        {(incidents ?? []).length === 0 && (
          <p className="py-2 text-sm text-faint">No incidents recorded.</p>
        )}
      </ul>
      <IncidentUpdateModal incident={updateFor} onClose={() => setUpdateFor(null)} />
    </>
  );
}

function IncidentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('minor');
  const [message, setMessage] = useState('');
  const [components, setComponents] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api('/api/v1/status/incidents', {
        method: 'POST',
        body: {
          title,
          severity,
          message,
          components: components
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          public: true,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['incidents'] });
      qc.invalidateQueries({ queryKey: ['public-status'] });
      onClose();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title="Create incident">
      <div className="space-y-3">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Severity">
          <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {['minor', 'major', 'critical', 'maintenance'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Initial update (optional)">
          <Input value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <Field
          label="Affected component keys (comma-separated)"
          hint="web, api, postgres, redis, workers, scheduler, telemetry, commands, automations, notifications, realtime, maps, tesla, tessie, demo"
        >
          <Input value={components} onChange={(e) => setComponents(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!title} loading={create.isPending} onClick={() => create.mutate()}>
            Create incident
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function IncidentUpdateModal({
  incident,
  onClose,
}: {
  incident: Incident | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState('investigating');
  const [message, setMessage] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/status/incidents/${incident!.id}/updates`, {
        method: 'POST',
        body: { phase, message },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['incidents'] });
      qc.invalidateQueries({ queryKey: ['public-status'] });
      onClose();
    },
  });
  return (
    <Modal open={!!incident} onClose={onClose} title={`Update — ${incident?.title ?? ''}`}>
      <div className="space-y-3">
        <Field label="Phase">
          <Select value={phase} onChange={(e) => setPhase(e.target.value)}>
            <option value="investigating">Investigating</option>
            <option value="identified">Identified</option>
            <option value="monitoring">Monitoring</option>
            <option value="resolved">Resolved</option>
          </Select>
        </Field>
        <Field label="Update message">
          <Input value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!message} loading={save.isPending} onClick={() => save.mutate()}>
            Post update
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function MaintenanceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [components, setComponents] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api('/api/v1/status/maintenance', {
        method: 'POST',
        body: {
          title,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          components: components
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['public-status'] });
      onClose();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title="Schedule maintenance">
      <div className="space-y-3">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Starts">
            <Input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </Field>
          <Field label="Ends">
            <Input
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Components">
          <Input
            value={components}
            onChange={(e) => setComponents(e.target.value)}
            placeholder="postgres, workers"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!title || !startsAt || !endsAt}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Schedule
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ResponseChart({ history }: { history: StatusCheckHistory[] }) {
  const points = history.filter((h) => h.latencyMs !== undefined).slice(-60);
  if (points.length === 0) return <p className="py-2 text-sm text-faint">No latency data.</p>;
  const max = Math.max(...points.map((p) => p.latencyMs ?? 0), 1);
  return (
    <div className="flex h-16 items-end gap-0.5" role="img" aria-label="Response time chart">
      {points.map((p, i) => (
        <div
          key={i}
          className="flex-1 rounded-t-sm bg-accent/60"
          style={{ height: `${Math.max(4, ((p.latencyMs ?? 0) / max) * 100)}%` }}
          title={`${p.latencyMs} ms`}
        />
      ))}
    </div>
  );
}

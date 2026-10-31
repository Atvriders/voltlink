// Public status page: components, incidents, maintenance, subscription, and
// the RSS/JSON endpoints. Served without authentication.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity, CheckCircle2, Mail, Wrench } from 'lucide-react';
import { api } from '../api/client';
import { Badge, Button, Card, EmptyState, Input, Spinner } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import type { PublicStatus } from '@voltlink/shared';

const STATUS_META: Record<
  string,
  { label: string; tone: 'ok' | 'warn' | 'danger' | 'info'; dot: string }
> = {
  operational: { label: 'All systems operational', tone: 'ok', dot: 'bg-ok' },
  degraded: { label: 'Degraded performance', tone: 'warn', dot: 'bg-warn' },
  partial_outage: { label: 'Partial outage', tone: 'warn', dot: 'bg-warn' },
  major_outage: { label: 'Major outage', tone: 'danger', dot: 'bg-danger' },
  maintenance: { label: 'Scheduled maintenance', tone: 'info', dot: 'bg-info' },
  unknown: { label: 'Status unknown', tone: 'info', dot: 'bg-faint' },
};

export default function PublicStatusPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['public-status'],
    queryFn: () => api<PublicStatus>('/api/v1/status'),
    refetchInterval: 30000,
  });
  const [email, setEmail] = useState('');
  const [subscribed, setSubscribed] = useState(false);

  if (isLoading)
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner size={22} />
      </div>
    );
  if (!data)
    return (
      <EmptyState icon={<Activity size={28} className="text-faint" />} title="Status unavailable" />
    );

  const overall = (STATUS_META[data.overall] ?? STATUS_META.unknown)!;
  const groups = [...new Set(data.components.map((c) => c.group))];

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="" className="h-8 w-8 rounded-lg" />
            <span className="font-extrabold">VoltLink</span>
            <Badge tone="neutral">Status</Badge>
          </div>
          <Link to="/login" className="text-sm text-subtle hover:text-accent">
            App →
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-4 p-4">
        {/* Overall banner */}
        <div className="card flex flex-wrap items-center gap-3 p-5">
          <span
            className={`h-3 w-3 rounded-full ${overall.dot} ${overall.tone !== 'ok' ? 'pulse' : ''}`}
            aria-hidden
          />
          <div className="flex-1">
            <h1 className="text-lg font-extrabold">{overall.label}</h1>
            <p className="text-xs text-faint">
              Updated {fmtDateTime(data.updatedAt)} · 30-day uptime {data.uptime30dPct}%
            </p>
          </div>
          <div className="flex gap-2 text-xs">
            <a
              className="text-accent hover:underline"
              href="/api/v1/status"
              target="_blank"
              rel="noreferrer"
            >
              JSON
            </a>
            <a
              className="text-accent hover:underline"
              href="/api/v1/status/rss"
              target="_blank"
              rel="noreferrer"
            >
              RSS
            </a>
          </div>
        </div>

        {/* Components */}
        {groups.map((group) => (
          <Card key={group} title={group} pad={false}>
            <ul className="divide-y divide-line">
              {data.components
                .filter((c) => c.group === group)
                .map((c) => {
                  const m = (STATUS_META[c.status] ?? STATUS_META.unknown)!;
                  return (
                    <li
                      key={c.key}
                      className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                    >
                      <span>{c.name}</span>
                      <span className="flex items-center gap-2">
                        {c.manualOverride && <Badge tone="warn">manual</Badge>}
                        <span className={`h-2 w-2 rounded-full ${m.dot}`} aria-hidden />
                        <span className="text-subtle">{c.status.replace('_', ' ')}</span>
                        <span className="hidden text-xs text-faint sm:inline">
                          {c.uptime90dPct}% uptime
                        </span>
                      </span>
                    </li>
                  );
                })}
            </ul>
          </Card>
        ))}

        {/* Incidents */}
        <Card title="Incidents" pad={false}>
          {data.incidents.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<CheckCircle2 size={26} className="text-ok" />}
                title="No incidents"
                body="Nothing to report — everything is running smoothly."
              />
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {data.incidents.map((i) => (
                <li key={i.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{i.title}</span>
                    <Badge
                      tone={
                        i.severity === 'critical'
                          ? 'danger'
                          : i.severity === 'major'
                            ? 'warn'
                            : 'info'
                      }
                    >
                      {i.severity}
                    </Badge>
                    <Badge tone={i.status === 'resolved' ? 'ok' : 'warn'}>{i.status}</Badge>
                  </div>
                  <ul className="mt-1.5 space-y-1">
                    {i.updates.map((u) => (
                      <li key={u.id} className="text-xs text-subtle">
                        <span className="font-semibold capitalize">{u.phase}</span> ·{' '}
                        {fmtDateTime(u.createdAt)} — {u.message}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Maintenance */}
        <Card title="Scheduled maintenance" pad={false}>
          {data.maintenance.length === 0 ? (
            <p className="px-4 py-3 text-sm text-faint">No maintenance scheduled.</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.maintenance.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                  <Wrench size={14} className="text-info" />
                  <span className="font-medium">{m.title}</span>
                  <span className="text-xs text-subtle">
                    {fmtDateTime(m.startsAt)} → {fmtDateTime(m.endsAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Subscribe */}
        <Card title="Get incident updates by email">
          {subscribed ? (
            <p className="flex items-center gap-2 text-sm text-ok">
              <CheckCircle2 size={15} /> Subscribed. Confirmation email follows when SMTP is
              configured.
            </p>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                await api('/api/v1/status/subscribe', { method: 'POST', body: { email } });
                setSubscribed(true);
              }}
            >
              <Input
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-label="Email"
              />
              <Button type="submit">
                <Mail size={14} /> Subscribe
              </Button>
            </form>
          )}
        </Card>

        <footer className="pb-6 text-center text-xs text-faint">
          VoltLink status page · served by the dedicated status process · genuinely independent
          uptime monitoring requires an external monitor outside this host
        </footer>
      </main>
    </div>
  );
}

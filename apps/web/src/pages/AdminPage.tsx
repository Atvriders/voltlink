// Administration: users & roles, instance settings, retention, health,
// and the emergency command-disable switches.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, Database, RefreshCw, Users } from 'lucide-react';
import { api } from '../api/client';
import { Badge, Button, Card, Field, Input, Select, Spinner, Stat } from '../components/ui';
import type { HealthInfo } from '@voltlink/shared';

export default function AdminPage() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => api<Record<string, string> & { appVersion: string }>('/api/v1/admin/settings'),
  });
  const { data: users } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () =>
      api<
        {
          id: string;
          email: string;
          name: string;
          role: string;
          emailVerified: boolean;
          vehicleCount: number;
          createdAt: string;
        }[]
      >('/api/v1/admin/users'),
  });
  const { data: health } = useQuery({
    queryKey: ['admin-health'],
    queryFn: () => api<HealthInfo>('/api/v1/admin/health'),
    refetchInterval: 15000,
  });
  const { data: switches } = useQuery({
    queryKey: ['command-switches'],
    queryFn: () =>
      api<{
        globalReadOnly: boolean;
        commandsEnabled: boolean;
        providerCommandsEnabled: boolean;
        vehicleCommandsEnabled: boolean;
      }>('/api/v1/commands/switches/status'),
  });
  const { data: deadJobs } = useQuery({
    queryKey: ['dead-jobs'],
    queryFn: () =>
      api<{ id: string; queue: string; error: string; attempts: number }[]>(
        '/api/v1/admin/queue/dead',
      ),
    refetchInterval: 20000,
  });

  const [retentionDays, setRetentionDays] = useState('');
  const saveRetention = useMutation({
    mutationFn: () =>
      api('/api/v1/admin/settings', {
        method: 'PATCH',
        body: { telemetryRetentionDays: retentionDays },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-settings'] }),
  });
  const runRetention = useMutation({
    mutationFn: () => api('/api/v1/admin/retention/run', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-health'] }),
  });
  const setRole = useMutation({
    mutationFn: (p: { id: string; role: string }) =>
      api(`/api/v1/admin/users/${p.id}/role`, { method: 'PATCH', body: { role: p.role } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
  const setSwitch = useMutation({
    mutationFn: (p: { key: string; value: boolean }) =>
      api('/api/v1/commands/switches', { method: 'POST', body: { [p.key]: p.value } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['command-switches'] }),
  });
  const requeue = useMutation({
    mutationFn: (queue: string) => api(`/api/v1/admin/queue/${queue}/flush`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dead-jobs'] }),
  });

  if (isLoading)
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner size={22} />
      </div>
    );

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-extrabold">Administration</h1>

      {/* Health */}
      <Card title="Platform health" subtitle={`VoltLink v${settings?.appVersion}`}>
        {health && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Database"
              value={health.database === 'ok' ? 'Healthy' : 'Error'}
              tone={health.database === 'ok' ? 'text-ok' : 'text-danger'}
            />
            <Stat
              label="Redis"
              value={
                health.redis === 'unused'
                  ? 'Postgres queue'
                  : health.redis === 'ok'
                    ? 'Healthy'
                    : 'Error'
              }
              tone={health.redis !== 'error' ? 'text-ok' : 'text-danger'}
            />
            <Stat
              label="Migrations"
              value={health.migrationsCurrent ? 'Current' : 'Outdated'}
              tone={health.migrationsCurrent ? 'text-ok' : 'text-danger'}
            />
            <Stat
              label="Workers"
              value={health.workersActive ? 'Active' : 'Idle'}
              tone="text-info"
            />
            <Stat label="Queue depth" value={String(health.queueDepth)} />
            <Stat
              label="Telemetry"
              value={health.telemetryFresh ? 'Fresh' : 'Stale'}
              tone={health.telemetryFresh ? 'text-ok' : 'text-warn'}
            />
            <Stat label="Uptime" value={`${Math.floor(health.uptimeSec / 3600)}h`} />
            <Stat label="Memory" value={`${health.memoryMb} MB`} />
          </div>
        )}
      </Card>

      {/* Safety switches */}
      <Card
        title="Command safety switches"
        subtitle="Emergency controls — disabled switches immediately reject new commands"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <SwitchRow
            label="Emergency global command-disable"
            description="Stops all vehicle commands instance-wide."
            on={!(switches?.commandsEnabled ?? true)}
            onToggle={(v) => setSwitch.mutate({ key: 'commandsEnabled', value: !v })}
          />
          <SwitchRow
            label="Global read-only mode"
            description="Blocks every mutating vehicle action."
            on={switches?.globalReadOnly ?? false}
            onToggle={(v) => setSwitch.mutate({ key: 'globalReadOnly', value: v })}
          />
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Users */}
        <Card title="Users & roles" subtitle={`${users?.length ?? 0} accounts`}>
          <div className="max-h-80 space-y-2 overflow-auto">
            {users?.map((u) => (
              <div
                key={u.id}
                className="flex items-center gap-2 rounded-lg border border-line bg-panel2 px-3 py-2 text-sm"
              >
                <Users size={14} className="shrink-0 text-subtle" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{u.name}</p>
                  <p className="truncate text-xs text-faint">
                    {u.email} · {u.vehicleCount} vehicles ·{' '}
                    {u.emailVerified ? 'verified' : 'unverified'}
                  </p>
                </div>
                <Select
                  aria-label={`Role for ${u.name}`}
                  value={u.role}
                  onChange={(e) => setRole.mutate({ id: u.id, role: e.target.value })}
                  className="max-w-40 py-1 text-xs"
                >
                  {[
                    'OWNER',
                    'ADMIN',
                    'FLEET_MANAGER',
                    'DRIVER',
                    'VIEWER',
                    'STATUS_MANAGER',
                    'SUPPORT',
                  ].map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        </Card>

        {/* Retention + dead jobs */}
        <div className="space-y-4">
          <Card title="Data retention">
            <div className="flex items-end gap-2">
              <Field label="Telemetry retention (days)">
                <Input
                  type="number"
                  min={7}
                  max={3650}
                  defaultValue={settings?.telemetryRetentionDays ?? '365'}
                  onChange={(e) => setRetentionDays(e.target.value)}
                />
              </Field>
              <Button
                loading={saveRetention.isPending}
                disabled={!retentionDays}
                onClick={() => saveRetention.mutate()}
              >
                Save
              </Button>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="secondary"
                loading={runRetention.isPending}
                onClick={() => runRetention.mutate()}
              >
                <Database size={14} /> Run retention now
              </Button>
              <span className="text-xs text-faint">
                Telemetry partitions and old route points are pruned per policy.
              </span>
            </div>
          </Card>

          <Card title="Failed background jobs">
            <ul className="max-h-52 space-y-1.5 overflow-auto text-sm">
              {(deadJobs ?? []).map((j) => (
                <li key={j.id} className="rounded-lg border border-danger/40 bg-danger/5 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <Badge tone="danger">{j.queue}</Badge>
                    <span className="text-xs text-faint">{j.attempts} attempts</span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-subtle">{j.error}</p>
                </li>
              ))}
              {(deadJobs ?? []).length === 0 && (
                <p className="py-2 text-sm text-faint">No failed jobs.</p>
              )}
            </ul>
            {(deadJobs ?? []).length > 0 && (
              <Button
                variant="secondary"
                className="mt-2"
                onClick={() => {
                  if (confirm('Requeue all failed jobs?')) requeue.mutate('vehicle-commands');
                }}
              >
                <RefreshCw size={13} /> Requeue command jobs
              </Button>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function SwitchRow({
  label,
  description,
  on,
  onToggle,
}: {
  label: string;
  description: string;
  on: boolean;
  onToggle: (v: boolean) => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border p-3 ${on ? 'border-danger/50 bg-danger/10' : 'border-line bg-panel2'}`}
    >
      {on && <AlertOctagon size={18} className="shrink-0 text-danger" />}
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-xs text-subtle">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={on}
        onClick={() => onToggle(!on)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? 'bg-danger' : 'bg-faint'}`}
        aria-label={label}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? 'left-[22px]' : 'left-0.5'}`}
        />
      </button>
    </div>
  );
}

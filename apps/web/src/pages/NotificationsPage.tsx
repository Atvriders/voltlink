// Notification center: in-app notifications, delivery preferences, webhook
// endpoints, and external channels (ntfy/Gotify/Discord/Teams).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellRing, CheckCheck, Plus, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Spinner } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { enable, pushSupport } from '../lib/push';
import { EVENT_TYPES, type AppNotification, type NotificationPreference } from '@voltlink/shared';

const SEVERITY_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'info'> = {
  info: 'info',
  success: 'ok',
  warning: 'warn',
  critical: 'danger',
};

export default function NotificationsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'inbox' | 'preferences' | 'webhooks'>('inbox');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['notifications', page],
    queryFn: () =>
      api<{ items: AppNotification[]; total: number; unread: number }>(
        `/api/v1/notifications?page=${page}&pageSize=20`,
      ),
  });
  const readAll = useMutation({
    mutationFn: () => api('/api/v1/notifications/read-all', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const readOne = useMutation({
    mutationFn: (id: string) => api(`/api/v1/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-extrabold">Notifications</h1>
        {data?.unread ? <Badge tone="danger">{data.unread} unread</Badge> : null}
        <div
          className="ml-auto flex rounded-lg border border-line bg-panel p-0.5 text-sm"
          role="tablist"
        >
          {(['inbox', 'preferences', 'webhooks'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1.5 capitalize ${tab === t ? 'bg-panel2 text-ink' : 'text-subtle'}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {tab === 'inbox' && (
        <Card
          pad={false}
          title="Inbox"
          actions={
            <Button
              variant="secondary"
              className="text-xs"
              loading={readAll.isPending}
              onClick={() => readAll.mutate()}
            >
              <CheckCheck size={13} /> Mark all read
            </Button>
          }
        >
          {isLoading ? (
            <div className="flex h-40 items-center justify-center">
              <Spinner size={22} />
            </div>
          ) : (data?.items.length ?? 0) === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<BellRing size={26} className="text-faint" />}
                title="You're all caught up"
                body="Notifications about your vehicles appear here."
              />
            </div>
          ) : (
            <>
              <ul className="divide-y divide-line">
                {data!.items.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => !n.readAt && readOne.mutate(n.id)}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-panel2 ${n.readAt ? 'opacity-70' : ''}`}
                    >
                      <Bell
                        size={15}
                        className={`mt-0.5 ${n.readAt ? 'text-faint' : 'text-accent'}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold">{n.title}</span>
                          <Badge tone={SEVERITY_TONE[n.severity] ?? 'info'}>{n.severity}</Badge>
                          {n.vehicleName && (
                            <span className="text-xs text-faint">{n.vehicleName}</span>
                          )}
                        </div>
                        <p className="text-sm text-subtle">{n.body}</p>
                        <p className="mt-0.5 text-[11px] text-faint">{fmtDateTime(n.createdAt)}</p>
                      </div>
                      {!n.readAt && (
                        <span
                          className="h-2 w-2 shrink-0 rounded-full bg-accent"
                          aria-label="unread"
                        />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-sm">
                <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <span className="text-xs text-faint">{data?.total ?? 0} total</span>
                <Button
                  variant="ghost"
                  disabled={(data?.items.length ?? 0) < 20}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </Card>
      )}

      {tab === 'preferences' && <PreferencesTab />}
      {tab === 'webhooks' && <WebhooksTab />}
    </div>
  );
}

const CHANNELS = ['in_app', 'email', 'push', 'webhook', 'ntfy', 'gotify', 'discord', 'teams'];

function PreferencesTab() {
  const qc = useQueryClient();
  const [pushMsg, setPushMsg] = useState<string>('');
  const [pushBusy, setPushBusy] = useState(false);
  const [support] = useState(() => pushSupport());
  const { data, isLoading } = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () =>
      api<{ prefs: NotificationPreference[]; channelUrls: Record<string, string> }>(
        '/api/v1/notifications/preferences',
      ),
  });
  const update = useMutation({
    mutationFn: (p: { channel: string; event: string; severity: string; enabled: boolean }) =>
      api('/api/v1/notifications/preferences', { method: 'PUT', body: p }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-preferences'] }),
  });
  const [urls, setUrls] = useState<Record<string, string>>({});
  const saveUrls = useMutation({
    mutationFn: () => api('/api/v1/notifications/channel-urls', { method: 'PUT', body: urls }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-preferences'] }),
  });

  if (isLoading)
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner size={22} />
      </div>
    );

  const enabledMap = new Set(
    (data?.prefs ?? [])
      .filter((p) => p.enabled)
      .map((p) => `${p.channel}:${p.event}:${p.severity}`),
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Event preferences" subtitle="Toggle which events reach which channels">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-faint">
                <th className="pb-2 font-semibold">Event</th>
                {CHANNELS.map((c) => (
                  <th key={c} className="pb-2 text-center font-semibold capitalize">
                    {c.replace('_', ' ')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {EVENT_TYPES.map((event) => (
                <tr key={event} className="border-t border-line">
                  <td className="py-1.5 pr-2 font-medium">{event.replace(/_/g, ' ')}</td>
                  {CHANNELS.map((channel) => {
                    const on = enabledMap.has(`${channel}:${event}:info`);
                    return (
                      <td key={channel} className="py-1.5 text-center">
                        <input
                          type="checkbox"
                          aria-label={`${event} via ${channel}`}
                          checked={on}
                          onChange={(e) =>
                            update.mutate({
                              channel,
                              event,
                              severity: 'info',
                              enabled: e.target.checked,
                            })
                          }
                          className="h-4 w-4 accent-[var(--vl-accent)]"
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Browser push notifications" subtitle="Web Push (N-PUSH)">
        <div className="space-y-3">
          {support === 'insecure-context' && (
            <p className="rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-xs text-warn">
              Push notifications require HTTPS. This instance is served over plain http, so browser
              push is unavailable here.
            </p>
          )}
          {support === 'needs-home-screen' && (
            <p className="rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-xs text-warn">
              On iPhone/iPad: Share → Add to Home Screen, then open VoltLink from the Home Screen
              and enable notifications here.
            </p>
          )}
          {support === 'unsupported' && (
            <p className="text-xs text-faint">This browser does not support push notifications.</p>
          )}
          {support === 'supported' && (
            <>
              <p className="text-xs text-subtle">
                Receive vehicle alerts even when VoltLink is closed. Subscriptions are per-device
                and per-user.
              </p>
              {pushMsg && <p className="text-xs text-ok">{pushMsg}</p>}
              <div className="flex justify-end">
                <Button
                  loading={pushBusy}
                  onClick={() => {
                    setPushBusy(true);
                    enable()
                      .then(() => setPushMsg('Push notifications enabled.'))
                      .catch((err: Error) => setPushMsg(err.message))
                      .finally(() => setPushBusy(false));
                  }}
                >
                  Enable push notifications
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>

      <Card title="External channels" subtitle="ntfy, Gotify, Discord and Teams endpoints">
        <div className="space-y-3">
          {(['ntfyUrl', 'gotifyUrl', 'discordWebhook', 'teamsWebhook'] as const).map((key) => (
            <Field key={key} label={key.replace('Url', '').replace('Webhook', ' webhook')}>
              <Input
                placeholder="https://…"
                defaultValue={data?.channelUrls[key] ?? ''}
                onChange={(e) => setUrls((u) => ({ ...u, [key]: e.target.value }))}
              />
            </Field>
          ))}
          <div className="flex justify-end">
            <Button loading={saveUrls.isPending} onClick={() => saveUrls.mutate()}>
              Save channels
            </Button>
          </div>
          <p className="text-xs text-faint">
            URLs are validated as http(s) and never exposed to other users. Delivery is rate-limited
            per channel.
          </p>
        </div>
      </Card>
    </div>
  );
}

function WebhooksTab() {
  const qc = useQueryClient();
  const { data: webhooks } = useQuery({
    queryKey: ['webhooks'],
    queryFn: () =>
      api<
        { id: string; name: string; displayHint: string; enabled: boolean; lastStatus?: number }[]
      >('/api/v1/notifications/webhooks'),
  });
  const [add, setAdd] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [rotatingId, setRotatingId] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api<{ secret: string }>('/api/v1/notifications/webhooks', {
        method: 'POST',
        body: { name, url },
      }),
    onSuccess: (d) => {
      setSecret(d.secret ?? '');
      qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });
  const rotate = useMutation({
    mutationFn: (id: string) =>
      api<{ secret: string }>(`/api/v1/notifications/webhooks/${id}/rotate-secret`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (d) => {
      setRotatingId('');
      setSecret(d.secret ?? '');
      qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });
  const toggle = useMutation({
    mutationFn: (w: { id: string; enabled: boolean }) =>
      api(`/api/v1/notifications/webhooks/${w.id}`, {
        method: 'PATCH',
        body: { enabled: !w.enabled },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/notifications/webhooks/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });

  return (
    <Card
      title="Outgoing webhooks"
      actions={
        <Button
          onClick={() => {
            setAdd(true);
            setSecret('');
          }}
        >
          <Plus size={13} /> Add webhook
        </Button>
      }
    >
      <ul className="space-y-2">
        {(webhooks ?? []).map((w) => (
          <li
            key={w.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel2 px-3 py-2 text-sm"
          >
            <span className="font-medium">{w.name}</span>
            <span className="max-w-xs truncate text-xs text-subtle">{w.displayHint}</span>
            {w.lastStatus !== undefined && (
              <Badge tone={w.lastStatus >= 200 && w.lastStatus < 300 ? 'ok' : 'danger'}>
                HTTP {w.lastStatus}
              </Badge>
            )}
            <div className="ml-auto flex gap-2">
              <Button
                variant="secondary"
                className="px-2 py-1 text-xs"
                onClick={() => toggle.mutate(w)}
              >
                {w.enabled ? 'Disable' : 'Enable'}
              </Button>
              <Button
                variant="secondary"
                className="px-2 py-1 text-xs"
                loading={rotate.isPending && rotatingId === w.id}
                onClick={() => {
                  setRotatingId(w.id);
                  rotate.mutate(w.id);
                }}
              >
                Rotate secret
              </Button>
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs text-danger"
                onClick={() => {
                  if (confirm('Delete webhook?')) remove.mutate(w.id);
                }}
              >
                <Trash2 size={12} />
              </Button>
            </div>
          </li>
        ))}
        {(webhooks ?? []).length === 0 && (
          <p className="py-2 text-sm text-faint">No webhooks configured.</p>
        )}
      </ul>

      <Modal open={add} onClose={() => setAdd(false)} title="Add webhook endpoint">
        <div className="space-y-3">
          {secret && (
            <div className="rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-xs text-warn">
              Webhook created. Store this secret — it is shown only once and is stored hashed:{' '}
              <code className="break-all">{secret}</code>
            </div>
          )}
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="URL (http/https)">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/hook"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdd(false)}>
              Cancel
            </Button>
            <Button
              loading={create.isPending}
              disabled={!name || !url}
              onClick={() => create.mutate()}
            >
              Create
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

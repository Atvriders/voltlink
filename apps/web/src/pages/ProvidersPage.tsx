// Providers page: account list, provider-readiness diagnostics, demo mode,
// Tesla OAuth flow, optional Tessie token, vehicle import, disconnection.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FlaskConical, Import, PlugZap, Trash2, XCircle } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Spinner } from '../components/ui';
import type { ProviderInfo, ProviderReadiness } from '@voltlink/shared';

export default function ProvidersPage() {
  const qc = useQueryClient();
  const { data: accounts, isLoading } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api<ProviderInfo[]>('/api/v1/providers'),
  });
  const { data: readiness, isLoading: readinessLoading } = useQuery({
    queryKey: ['provider-readiness'],
    queryFn: () => api<ProviderReadiness[]>('/api/v1/providers/readiness'),
  });
  const [tessieOpen, setTessieOpen] = useState(false);
  const [tessieToken, setTessieToken] = useState('');
  const [error, setError] = useState('');

  const connectDemo = useMutation({
    mutationFn: () =>
      api<{ vehiclesImported: number }>('/api/v1/providers/demo/connect', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] });
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['vehicles'] });
      }, 1500);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Demo connect failed'),
  });

  const importVehicles = useMutation({
    mutationFn: (accountId: string) =>
      api<{ imported: number }>(`/api/v1/providers/${accountId}/import`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] });
      setTimeout(() => qc.invalidateQueries({ queryKey: ['vehicles'] }), 1200);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Import failed'),
  });

  const disconnect = useMutation({
    mutationFn: (accountId: string) =>
      api(`/api/v1/providers/${accountId}/disconnect`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['providers'] });
      qc.invalidateQueries({ queryKey: ['vehicles'] });
    },
  });

  const tessieConnect = useMutation({
    mutationFn: () =>
      api('/api/v1/providers/tessie/connect', {
        method: 'POST',
        body: { token: tessieToken, label: 'Tessie' },
      }),
    onSuccess: () => {
      setTessieOpen(false);
      setTessieToken('');
      qc.invalidateQueries({ queryKey: ['providers'] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Tessie connect failed'),
  });

  const startTesla = async () => {
    try {
      const { url } = await api<{ url: string }>('/api/v1/providers/tesla/authorize');
      window.location.href = url;
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 503
          ? 'Tesla isn’t configured on this server (TESLA_CLIENT_ID).'
          : e instanceof ApiError
            ? e.message
            : 'Could not start Tesla connection',
      );
    }
  };

  const demo = accounts?.find((a) => a.provider === 'demo');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-extrabold">Providers</h1>
        <span className="text-xs text-faint">
          Connect real vehicles or explore with the fictional demo fleet
        </span>
      </div>

      {error && (
        <div
          className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
          role="alert"
        >
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Spinner size={22} />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card
            title="Demo fleet"
            subtitle="Fictional data — clearly labeled, never contacts real services"
          >
            <p className="text-sm text-subtle">
              Explore VoltLink with five fictional vehicles (parked, driving, charging, sleeping,
              offline), 30 days of drives, charging sessions, automations, and fleet data.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button loading={connectDemo.isPending} onClick={() => connectDemo.mutate()}>
                <FlaskConical size={14} /> {demo ? 'Refresh demo fleet' : 'Enable demo mode'}
              </Button>
              {demo && <Badge tone="ok">{demo.vehicleCount} demo vehicles</Badge>}
            </div>
          </Card>

          <Card
            title="Tesla (official API)"
            subtitle="OAuth via developer.tesla.com — supported authorization path"
          >
            <p className="text-sm text-subtle">
              Connects through Tesla's official Fleet API with vehicle device data and command
              scopes. VoltLink never asks for your account password.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button onClick={startTesla}>
                <PlugZap size={14} /> Connect with Tesla
              </Button>
              <Button variant="secondary" onClick={() => setTessieOpen(true)}>
                Connect with Tessie token
              </Button>
            </div>
          </Card>
        </div>
      )}

      <Card
        title="Provider-readiness diagnostics"
        subtitle="What each provider needs before it can connect"
      >
        {readinessLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner size={20} />
          </div>
        ) : (
          <ul className="space-y-3">
            {(readiness ?? []).map((r) => (
              <li key={r.provider} className="rounded-xl border border-line bg-panel2 p-3">
                <div className="flex items-center gap-2">
                  <span className="font-semibold capitalize">{r.provider}</span>
                  {r.ok ? (
                    <Badge tone="ok">ready</Badge>
                  ) : (
                    <Badge tone="warn">needs configuration</Badge>
                  )}
                  {r.configured && <Badge tone="info">account connected</Badge>}
                </div>
                <ul className="mt-2 space-y-1">
                  {r.checks.map((c, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs">
                      {c.ok ? (
                        <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-ok" />
                      ) : (
                        <XCircle size={13} className="mt-0.5 shrink-0 text-danger" />
                      )}
                      <span className="text-subtle">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Connected accounts"
        subtitle="Disconnecting removes the stored (encrypted) credentials"
      >
        {(accounts ?? []).length === 0 ? (
          <EmptyState
            icon={<PlugZap size={26} className="text-faint" />}
            title="No provider accounts"
          />
        ) : (
          <ul className="space-y-2">
            {accounts!.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel2 px-3 py-2.5 text-sm"
              >
                <span className="font-semibold capitalize">{a.provider}</span>
                <span className="text-subtle">{a.label}</span>
                {a.demo && <Badge tone="accent">demo</Badge>}
                {a.status === 'connected' ? (
                  <Badge tone="ok">connected</Badge>
                ) : a.status === 'error' ? (
                  <Badge tone="danger">error</Badge>
                ) : (
                  <Badge tone="neutral">{a.status}</Badge>
                )}
                <span className="text-xs text-faint">{a.vehicleCount} vehicles</span>
                {a.lastSyncAt && (
                  <span className="text-xs text-faint">
                    synced {new Date(a.lastSyncAt).toLocaleString()}
                  </span>
                )}
                {a.lastError && (
                  <span className="max-w-xs truncate text-xs text-danger">{a.lastError}</span>
                )}
                <div className="ml-auto flex gap-2">
                  {a.status === 'connected' && (
                    <Button
                      variant="secondary"
                      className="px-2 py-1 text-xs"
                      loading={importVehicles.isPending}
                      onClick={() => importVehicles.mutate(a.id)}
                    >
                      <Import size={12} /> Import
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    className="px-2 py-1 text-xs text-danger"
                    onClick={() => {
                      if (confirm(`Disconnect ${a.provider}? Stored credentials will be removed.`))
                        disconnect.mutate(a.id);
                    }}
                  >
                    <Trash2 size={12} /> Disconnect
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={tessieOpen}
        onClose={() => setTessieOpen(false)}
        title="Connect Tessie (optional)"
      >
        <div className="space-y-3">
          <p className="text-sm text-subtle">
            Paste your Tessie API token (from tessie.com). It is stored with authenticated
            encryption and never sent to your browser after submission. See
            docs/OPTIONAL_TESSIE_PROVIDER.md.
          </p>
          <Field label="Tessie API token">
            <Input
              type="password"
              value={tessieToken}
              onChange={(e) => setTessieToken(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setTessieOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={tessieConnect.isPending}
              disabled={tessieToken.length < 8}
              onClick={() => tessieConnect.mutate()}
            >
              Connect
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

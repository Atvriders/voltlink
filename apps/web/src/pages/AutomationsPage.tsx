// Automations page: structured rule editor, human-readable summaries, dry
// run, manual trigger, execution history.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Plus, Power, Trash2, Zap } from 'lucide-react';
import { api } from '../api/client';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Spinner } from '../components/ui';
import { Webhook as WebhookIcon } from 'lucide-react';
import { fmtClock } from '../lib/format';
import { ACTION_TYPES, TRIGGER_TYPES, type ActionType, type Automation, type AutomationExecution, type TriggerType } from '@voltlink/shared';

const TRIGGER_LABELS: Record<string, string> = {
  scheduled: 'On schedule', enter_place: 'Entering a place', leave_place: 'Leaving a place',
  battery_threshold: 'Battery threshold', charging_started: 'Charging started', charging_stopped: 'Charging stopped',
  charging_completed: 'Charging completed', plug_connected: 'Cable connected', door_open: 'Door open',
  vehicle_parked: 'Vehicle parked', drive_started: 'Drive started', temperature_threshold: 'Temperature threshold',
  vehicle_online: 'Vehicle online', provider_reconnected: 'Provider reconnected', fault_detected: 'Fault detected',
  webhook: 'Incoming webhook',
};

const ACTION_LABELS: Record<string, string> = {
  notify_app: 'In-app notification', notify_email: 'Email', notify_push: 'Push notification', webhook: 'Webhook',
  climate_start: 'Start climate', climate_stop: 'Stop climate', set_temperature: 'Set temperature',
  charge_start: 'Start charging', charge_stop: 'Stop charging', set_charge_limit: 'Set charge limit',
  lock: 'Lock vehicle', sentry_mode: 'Security mode', flash_lights: 'Flash lights', honk_horn: 'Honk horn',
  tag_drive: 'Tag drive', create_incident: 'Create incident', generate_report: 'Generate report',
};

export default function AutomationsPage() {
  const qc = useQueryClient();
  const { data: automations, isLoading } = useQuery({ queryKey: ['automations'], queryFn: () => api<Automation[]>('/api/v1/automations') });
  const [editor, setEditor] = useState<{ mode: 'new'; automation?: Automation } | { mode: 'executions'; automation: Automation } | null>(null);
  const [hookFor, setHookFor] = useState<Automation | null>(null);

  const toggle = useMutation({
    mutationFn: (a: Automation) => api(`/api/v1/automations/${a.id}`, { method: 'PATCH', body: { enabled: !a.enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/automations/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-extrabold">Automations</h1>
        <div className="ml-auto">
          <Button onClick={() => setEditor({ mode: 'new' })}><Plus size={14} /> New automation</Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Spinner size={22} /></div>
      ) : (automations ?? []).length === 0 ? (
        <EmptyState icon={<Zap size={28} className="text-faint" />} title="No automations yet" body="Create a rule like “notify me when charging completes” and VoltLink runs it in the background." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {automations!.map((a) => (
            <Card key={a.id} className="flex flex-col" title={
              <span className="flex items-center gap-2">
                <Power size={14} className={a.enabled ? 'text-ok' : 'text-faint'} />
                {a.name}
              </span>
            }>
              <p className="text-xs text-subtle">{a.description ?? summarizeRule(a)}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                <Badge tone="accent">{TRIGGER_LABELS[a.trigger.type] ?? a.trigger.type}</Badge>
                <Badge tone="neutral">{a.actions.length} action{a.actions.length === 1 ? '' : 's'}</Badge>
                {a.vehicleId ? <Badge tone="info">one vehicle</Badge> : <Badge tone="neutral">all vehicles</Badge>}
                {!a.enabled && <Badge tone="warn">disabled</Badge>}
                {a.lastResult === 'failed' && <Badge tone="danger">last run failed</Badge>}
              </div>
              <p className="mt-1.5 text-[11px] text-faint">{a.runCount} runs · last {a.lastRunAt ? fmtClock(a.lastRunAt) : 'never'}</p>
              <div className="mt-3 flex gap-1.5 border-t border-line pt-3">
                <Button variant={a.enabled ? 'secondary' : 'primary'} className="px-2.5 py-1.5 text-xs" onClick={() => toggle.mutate(a)}>
                  <Power size={12} /> {a.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={() => setEditor({ mode: 'new', automation: a })}>
                  <FlaskConical size={12} /> Dry run
                </Button>
                <Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={() => setEditor({ mode: 'executions', automation: a })}>
                  History
                </Button>
                {a.trigger.type === 'webhook' && (
                  <Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={() => setHookFor(a)}>
                    <WebhookIcon size={12} /> Inbound URL
                  </Button>
                )}
                <Button variant="ghost" className="ml-auto px-2.5 py-1.5 text-xs text-danger" onClick={() => { if (confirm(`Delete automation "${a.name}"?`)) remove.mutate(a.id); }} aria-label={`Delete ${a.name}`}>
                  <Trash2 size={12} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <AutomationEditor key={editor?.automation?.id ?? editor?.mode ?? 'new'} open={!!editor && editor.mode === 'new'} automation={editor?.mode === 'new' ? editor.automation : undefined} onClose={() => setEditor(null)} />
      <ExecutionsModal automation={editor?.mode === 'executions' ? editor.automation : null} onClose={() => setEditor(null)} />
      <InboundHookModal automation={hookFor} onClose={() => setHookFor(null)} />
    </div>
  );
}

function summarizeRule(a: Automation): string {
  return `When ${(TRIGGER_LABELS[a.trigger.type] ?? a.trigger.type).toLowerCase()}, then ${a.actions.map((x) => (ACTION_LABELS[x.type] ?? x.type).toLowerCase()).join(' and ')}.`;
}

function AutomationEditor({ open, automation, onClose }: { open: boolean; automation?: Automation; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(automation?.name ?? '');
  const [description, setDescription] = useState(automation?.description ?? '');
  const [trigger, setTrigger] = useState<TriggerType>(automation?.trigger.type ?? 'charging_completed');
  const [vehicleId, setVehicleId] = useState(automation?.vehicleId ?? '');
  const [actionType, setActionType] = useState<ActionType>(automation?.actions[0]?.type ?? 'notify_app');
  const [actionMessage, setActionMessage] = useState(String((automation?.actions[0]?.params as Record<string, unknown>)?.message ?? ''));
  const [actionEndpoint, setActionEndpoint] = useState(String((automation?.actions[0]?.params as Record<string, unknown>)?.endpointId ?? ''));
  const [cooldownSec, setCooldownSec] = useState(automation?.cooldownSec ?? 0);
  const [dryResult, setDryResult] = useState<{ result: string; actionResults: { action: string; ok: boolean; detail: string }[] } | null>(null);
  const { data: vehicles } = useQuery({ queryKey: ['vehicles'], queryFn: () => api<{ id: string; displayName: string }[]>('/api/v1/vehicles') });
  const { data: webhooks } = useQuery({ queryKey: ['webhooks'], queryFn: () => api<{ id: string; name: string; displayHint: string }[]>('/api/v1/notifications/webhooks') });

  const save = useMutation({
    mutationFn: () =>
      api('/api/v1/automations', {
        method: 'POST',
        body: {
          name,
          description,
          enabled: true,
          vehicleId: vehicleId || null,
          trigger: { type: trigger, params: trigger === 'battery_threshold' ? { pct: 20 } : {} },
          conditions: [],
          actions: [{ type: actionType, params: { message: actionMessage, endpointId: actionEndpoint } }],
          cooldownSec,
          maxRetries: 1,
        },
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['automations'] }); onClose(); },
  });

  const dryRun = useMutation({
    mutationFn: (id: string) => api<{ result: string; actionResults: { action: string; ok: boolean; detail: string }[] }>(`/api/v1/automations/${id}/dry-run`, { method: 'POST', body: {} }),
    onSuccess: (d) => setDryResult(d),
  });

  return (
    <Modal open={open} onClose={onClose} title={automation ? 'Dry run automation' : 'New automation'}>
      <div className="space-y-3">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Charge-complete notification" /></Field>
        <Field label="Description (optional)"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Trigger">
            <Select value={trigger} onChange={(e) => setTrigger(e.target.value as TriggerType)}>
              {TRIGGER_TYPES.map((t) => <option key={t} value={t}>{TRIGGER_LABELS[t] ?? t}</option>)}
            </Select>
          </Field>
          <Field label="Applies to">
            <Select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              <option value="">All vehicles</option>
              {(vehicles ?? []).map((v) => <option key={v.id} value={v.id}>{v.displayName}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Action">
            <Select value={actionType} onChange={(e) => setActionType(e.target.value as ActionType)}>
              {ACTION_TYPES.map((t) => <option key={t} value={t}>{ACTION_LABELS[t] ?? t}</option>)}
            </Select>
          </Field>
          <Field label="Cooldown (seconds)"><Input type="number" min={0} value={cooldownSec} onChange={(e) => setCooldownSec(Number(e.target.value))} /></Field>
        </div>
        {(actionType === 'notify_app' || actionType === 'notify_email' || actionType === 'notify_push' || actionType === 'webhook') && (
          <Field label="Message"><Input value={actionMessage} onChange={(e) => setActionMessage(e.target.value)} placeholder="Your vehicle finished charging." /></Field>
        )}
        {actionType === 'webhook' && (
          <Field label="Webhook endpoint">
            <Select value={actionEndpoint} onChange={(e) => setActionEndpoint(e.target.value)}>
              <option value="">Select an endpoint…</option>
              {(webhooks ?? []).filter((w) => w.id).map((w) => <option key={w.id} value={w.id}>{w.name} ({w.displayHint})</option>)}
            </Select>
          </Field>
        )}
        <p className="rounded-lg border border-line bg-panel2 px-3 py-2 text-xs text-subtle" aria-live="polite">
          {name ? summarizeDraft({ trigger, actionType, name }) : 'Human-readable summary appears here.'}
        </p>
        {dryResult && (
          <div className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs">
            <p className="font-bold text-accent">Dry run result: {dryResult.result}</p>
            {dryResult.actionResults.map((r, i) => (
              <p key={i} className={r.ok ? 'text-ok' : 'text-danger'}>• {r.action}: {r.detail}</p>
            ))}
          </div>
        )}
        {automation ? (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button loading={dryRun.isPending} onClick={() => dryRun.mutate(automation.id)}><FlaskConical size={14} /> Run dry run</Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button loading={save.isPending} disabled={!name} onClick={() => save.mutate()}><Zap size={14} /> Create automation</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function summarizeDraft({ trigger, actionType, name }: { trigger: string; actionType: string; name: string }) {
  return `"${name}": when ${(TRIGGER_LABELS[trigger] ?? trigger).toLowerCase()}, ${(ACTION_LABELS[actionType] ?? actionType).toLowerCase()}.`;
}

function ExecutionsModal({ automation, onClose }: { automation: Automation | null; onClose: () => void }) {
  const { data: executions, isLoading } = useQuery({
    queryKey: ['automation-executions', automation?.id],
    queryFn: () => api<AutomationExecution[]>(`/api/v1/automations/${automation!.id}/executions`),
    enabled: !!automation,
  });
  return (
    <Modal open={!!automation} onClose={onClose} title={`Execution history — ${automation?.name ?? ''}`}>
      {isLoading ? (
        <div className="flex h-24 items-center justify-center"><Spinner size={20} /></div>
      ) : (
        <ul className="max-h-96 space-y-2 overflow-auto">
          {(executions ?? []).map((e) => (
            <li key={e.id} className="rounded-lg border border-line bg-panel2 px-3 py-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs text-subtle">{new Date(e.triggeredAt).toLocaleString()} · {e.triggerEvent}</span>
                <Badge tone={e.result === 'success' ? 'ok' : e.result === 'failed' ? 'danger' : 'neutral'}>{e.result}</Badge>
              </div>
              {!e.conditionsMet && <p className="mt-1 text-xs text-warn">Conditions not met — skipped.</p>}
              {e.actionResults?.map((r, i) => (
                <p key={i} className={`mt-0.5 text-xs ${r.ok ? 'text-ok' : 'text-danger'}`}>• {r.action}: {r.detail}</p>
              ))}
              {e.errorMessage && <p className="mt-0.5 text-xs text-danger">{e.errorMessage}</p>}
            </li>
          ))}
          {(executions ?? []).length === 0 && <p className="py-3 text-sm text-faint">No executions recorded yet.</p>}
        </ul>
      )}
    </Modal>
  );
}


function InboundHookModal({ automation, onClose }: { automation: Automation | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [created, setCreated] = useState<{ url: string; secret: string; publicId: string } | null>(null);
  const create = useMutation({
    mutationFn: () => api<{ url: string; secret: string; publicId: string }>(`/api/v1/automations/${automation!.id}/inbound-webhook`, { method: 'POST', body: {} }),
    onSuccess: (d) => { setCreated(d); qc.invalidateQueries({ queryKey: ['automations'] }); },
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/automations/${automation!.id}/inbound-webhook`, { method: 'DELETE' }),
    onSuccess: () => { setCreated(null); qc.invalidateQueries({ queryKey: ['automations'] }); },
  });
  return (
    <Modal open={!!automation} onClose={onClose} title={`Inbound webhook — ${automation?.name ?? ''}`}>
      <div className="space-y-3">
        <p className="text-xs text-subtle">
          An inbound webhook lets external systems trigger this automation. Sign POST bodies with the Standard Webhooks scheme
          (webhook-id, webhook-timestamp, webhook-signature) using the secret below.
        </p>
        {!created ? (
          <div className="flex justify-end">
            <Button loading={create.isPending} onClick={() => create.mutate()}><WebhookIcon size={13} /> Create inbound webhook</Button>
          </div>
        ) : (
          <>
            <Field label="Endpoint URL"><Input readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} /></Field>
            <div className="rounded-lg border border-warn/50 bg-warn/10 px-3 py-2 text-xs text-warn">
              Store this secret — it is shown only once: <code className="break-all">{created.secret}</code>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { navigator.clipboard?.writeText(created.url).catch(() => undefined); }}>Copy URL</Button>
              <Button variant="ghost" className="text-danger" loading={remove.isPending} onClick={() => { if (confirm('Delete this inbound webhook? External callers will get 404.')) remove.mutate(); }}>
                Delete
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

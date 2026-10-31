// Charging page: sessions with cost analytics, rate rules (flat/TOU/location),
// manual cost correction, and exports.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Zap } from 'lucide-react';
import { api, apiCsv } from '../api/client';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
} from '../components/ui';
import { fmtClock, fmtEnergy, fmtMoney } from '../lib/format';
import { useSelectedVehicle } from '../lib/vehicleSelection';
import type { ChargeSession, RateRule } from '@voltlink/shared';

export default function ChargingPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const { selectedId } = useSelectedVehicle();
  const [vehicleId, setVehicleId] = useState(selectedId ?? '');
  const [source, setSource] = useState('');
  const [addRule, setAddRule] = useState(false);
  const [editSession, setEditSession] = useState<ChargeSession | null>(null);
  const [manualCost, setManualCost] = useState('');

  const qs = new URLSearchParams({ page: String(page), pageSize: '15' });
  if (vehicleId) qs.set('vehicleId', vehicleId);
  if (source) qs.set('source', source);

  const { data, isLoading } = useQuery({
    queryKey: ['charging', qs.toString()],
    queryFn: () =>
      api<{ items: ChargeSession[]; total: number }>(`/api/v1/charging?${qs.toString()}`),
  });
  const { data: totals } = useQuery({
    queryKey: ['charging-totals'],
    queryFn: () =>
      api<{ count: number; energyKwh: number; cost: number }>('/api/v1/charging/totals'),
  });
  const { data: rules } = useQuery({
    queryKey: ['rate-rules'],
    queryFn: () => api<RateRule[]>('/api/v1/charging/rates/list'),
  });
  const { data: vehicles } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => api<{ id: string; displayName: string }[]>('/api/v1/vehicles'),
  });

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / 15));

  const download = async (fmt: 'csv' | 'json') => {
    const body = await apiCsv(`/api/v1/charging/export/${fmt}`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(
      new Blob([body], { type: fmt === 'csv' ? 'text/csv' : 'application/json' }),
    );
    a.download = `voltlink-charging.${fmt}`;
    a.click();
  };

  const saveManual = useMutation({
    mutationFn: () =>
      api(`/api/v1/charging/${editSession?.id}`, {
        method: 'PATCH',
        body: { manualCost: manualCost ? Number(manualCost) : null },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['charging'] });
      setEditSession(null);
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-extrabold">Charging</h1>
        {totals && (
          <span className="text-xs text-subtle">
            {totals.count} sessions · {fmtEnergy(totals.energyKwh)} · {fmtMoney(totals.cost)}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={() => download('csv')}>
            <Download size={14} /> CSV
          </Button>
          <Button variant="secondary" onClick={() => download('json')}>
            <Download size={14} /> JSON
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card pad={false} title="Sessions">
            <div className="flex gap-2 border-b border-line p-3">
              <Select
                aria-label="Vehicle"
                value={vehicleId}
                onChange={(e) => {
                  setVehicleId(e.target.value);
                  setPage(1);
                }}
                className="max-w-44"
              >
                <option value="">All vehicles</option>
                {(vehicles ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.displayName}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Source"
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setPage(1);
                }}
                className="max-w-36"
              >
                <option value="">All sources</option>
                <option value="home">Home</option>
                <option value="work">Work</option>
                <option value="public">Public</option>
                <option value="fast">Fast</option>
              </Select>
            </div>
            {isLoading ? (
              <div className="flex h-40 items-center justify-center">
                <Spinner size={22} />
              </div>
            ) : (data?.items.length ?? 0) === 0 ? (
              <div className="p-4">
                <EmptyState
                  icon={<Zap size={28} className="text-faint" />}
                  title="No charging sessions"
                />
              </div>
            ) : (
              <>
                <ul className="divide-y divide-line">
                  {data!.items.map((s) => (
                    <li
                      key={s.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm"
                    >
                      <span className="w-28 font-medium">{s.vehicleName}</span>
                      <span className="w-40 text-subtle">
                        {fmtClock(s.startAt)} → {s.endAt ? fmtClock(s.endAt) : '…'}
                      </span>
                      <span className="w-24 text-subtle">{fmtEnergy(s.energyAddedKwh)}</span>
                      <span className="w-28 font-semibold">{fmtMoney(s.cost, s.currency)}</span>
                      <Badge
                        tone={s.source === 'fast' ? 'warn' : s.source === 'home' ? 'ok' : 'info'}
                      >
                        {s.source}
                      </Badge>
                      {s.rateName && <span className="text-xs text-faint">{s.rateName}</span>}
                      <button
                        onClick={() => {
                          setEditSession(s);
                          setManualCost(s.manualCost?.toString() ?? '');
                        }}
                        className="ml-auto text-xs text-accent hover:underline"
                      >
                        Adjust
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
                  <Button
                    variant="ghost"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Previous
                  </Button>
                  <span className="text-xs text-faint">
                    Page {page} of {totalPages}
                  </span>
                  <Button
                    variant="ghost"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card
            title="Electricity rates"
            actions={
              <Button variant="secondary" onClick={() => setAddRule(true)}>
                <Plus size={13} /> New rule
              </Button>
            }
          >
            <ul className="space-y-2">
              {(rules ?? []).map((r) => (
                <li
                  key={r.id}
                  className="rounded-lg border border-line bg-panel2 px-3 py-2 text-sm"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{r.name}</span>
                    <Badge tone={r.enabled ? 'accent' : 'neutral'}>{r.type}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-subtle">
                    {fmtMoney(r.pricePerKwh, r.currency)}/kWh
                    {Array.isArray(r.periods) && r.periods.length > 0
                      ? ` · ${r.periods.length} time-of-use periods`
                      : ''}
                  </p>
                </li>
              ))}
              {(rules ?? []).length === 0 && (
                <p className="py-2 text-sm text-faint">
                  No rate rules. Charging costs need a rule or manual values.
                </p>
              )}
            </ul>
            <p className="mt-2 text-xs text-faint">
              Home, workplace, public, and fast-charging costs are computed from these rules.
            </p>
          </Card>
        </div>
      </div>

      <RateRuleModal
        open={addRule}
        onClose={() => setAddRule(false)}
        onSaved={() => {
          setAddRule(false);
          qc.invalidateQueries({ queryKey: ['rate-rules'] });
        }}
      />

      <Modal
        open={!!editSession}
        onClose={() => setEditSession(null)}
        title="Correct charging cost"
      >
        <div className="space-y-3">
          <p className="text-sm text-subtle">
            Computed cost: <strong>{fmtMoney(editSession?.cost, editSession?.currency)}</strong> (
            {fmtEnergy(editSession?.energyAddedKwh)} at{' '}
            {editSession?.pricePerKwh ? fmtMoney(editSession.pricePerKwh) : 'n/a'}/kWh).
          </p>
          <Field label="Manual cost override (blank = use computed)">
            <Input
              type="number"
              step="0.01"
              min="0"
              value={manualCost}
              onChange={(e) => setManualCost(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditSession(null)}>
              Cancel
            </Button>
            <Button loading={saveManual.isPending} onClick={() => saveManual.mutate()}>
              Save
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function RateRuleModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState('flat');
  const [price, setPrice] = useState('0.25');
  const [tou, setTou] = useState('0.09,0.16,0.28,0.16');
  const save = useMutation({
    mutationFn: () =>
      api('/api/v1/charging/rates/list', {
        method: 'POST',
        body: {
          name,
          type,
          pricePerKwh: Number(price),
          periods:
            type === 'tou'
              ? tou.split(',').map((p, i) => ({
                  startMin: i * 360,
                  endMin: (i + 1) * 360,
                  pricePerKwh: Number(p),
                }))
              : [],
        },
      }),
    onSuccess: onSaved,
  });
  return (
    <Modal open={open} onClose={onClose} title="New electricity rate rule">
      <div className="space-y-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Home TOU" />
        </Field>
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="flat">Flat rate</option>
            <option value="tou">Time-of-use</option>
            <option value="location">Location-specific</option>
          </Select>
        </Field>
        <Field label="Price per kWh">
          <Input
            type="number"
            step="0.01"
            min="0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>
        {type === 'tou' && (
          <Field label="Period prices (6h blocks, comma-separated)" hint="e.g. 0.09,0.16,0.28,0.16">
            <Input value={tou} onChange={(e) => setTou(e.target.value)} />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!name} onClick={() => save.mutate()}>
            Create rule
          </Button>
        </div>
      </div>
    </Modal>
  );
}

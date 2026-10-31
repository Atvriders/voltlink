// Fleet management: overview, groups, drivers, departments, cost centers,
// assignments, maintenance, and exportable reports.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, Plus, Trash2, Users } from 'lucide-react';
import { api } from '../api/client';
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
import type {
  CostCenter,
  Department,
  Driver,
  FleetGroup,
  FleetVehicleRow,
  MaintenanceRecord,
  VehicleAssignment,
} from '@voltlink/shared';

export default function FleetPage() {
  const [tab, setTab] = useState<'overview' | 'groups' | 'drivers' | 'maintenance'>('overview');
  const { data: overview, isLoading } = useQuery({
    queryKey: ['fleet-overview'],
    queryFn: () =>
      api<{
        rows: FleetVehicleRow[];
        summary: {
          vehicles: number;
          charging: number;
          offline: number;
          attention: number;
          avgBatteryPct: number | null;
        };
      }>('/api/v1/fleet/overview'),
    refetchInterval: 20000,
  });

  const report = async () => {
    const res = await fetch('/api/v1/fleet/report', { credentials: 'same-origin' });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'voltlink-fleet-report.json';
    a.click();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-extrabold">Fleet</h1>
        {overview?.summary && (
          <span className="text-xs text-subtle">
            {overview.summary.vehicles} vehicles · {overview.summary.charging} charging ·{' '}
            {overview.summary.offline} offline · {overview.summary.attention} need attention
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <div className="flex rounded-lg border border-line bg-panel p-0.5 text-sm">
            {(['overview', 'groups', 'drivers', 'maintenance'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-3 py-1.5 capitalize ${tab === t ? 'bg-panel2 text-ink' : 'text-subtle'}`}
              >
                {t}
              </button>
            ))}
          </div>
          <Button variant="secondary" onClick={report}>
            <Download size={14} /> Report
          </Button>
        </div>
      </div>

      {tab === 'overview' && (
        <Card pad={false} title="Fleet status">
          {isLoading ? (
            <div className="flex h-40 items-center justify-center">
              <Spinner size={22} />
            </div>
          ) : (overview?.rows.length ?? 0) === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<Users size={28} className="text-faint" />}
                title="No fleet vehicles"
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-faint">
                    <th className="px-4 py-2.5">Vehicle</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Battery</th>
                    <th className="px-3 py-2.5">Odometer</th>
                    <th className="px-3 py-2.5">Driver</th>
                    <th className="px-3 py-2.5">Department</th>
                    <th className="px-3 py-2.5">Cost center</th>
                    <th className="px-3 py-2.5">Attention</th>
                  </tr>
                </thead>
                <tbody>
                  {overview!.rows.map((r) => (
                    <tr
                      key={r.vehicle.id}
                      className="border-b border-line last:border-0 hover:bg-panel2"
                    >
                      <td className="px-4 py-2.5 font-medium">{r.vehicle.name}</td>
                      <td className="px-3 py-2.5">
                        <Badge
                          tone={
                            r.status === 'offline'
                              ? 'danger'
                              : r.charging
                                ? 'charging'
                                : r.status === 'asleep'
                                  ? 'info'
                                  : 'ok'
                          }
                        >
                          {r.charging ? 'charging' : r.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        {r.batteryPct !== undefined ? `${Math.round(r.batteryPct)}%` : '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        {r.odometerKm ? `${Math.round(r.odometerKm).toLocaleString()} km` : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-subtle">{r.driver ?? '—'}</td>
                      <td className="px-3 py-2.5 text-subtle">{r.department ?? '—'}</td>
                      <td className="px-3 py-2.5 text-subtle">{r.costCenter ?? '—'}</td>
                      <td className="px-3 py-2.5">
                        {r.attention.length > 0 ? (
                          r.attention.map((a) => (
                            <Badge key={a} tone="warn">
                              {a}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'groups' && <GroupsTab />}
      {tab === 'drivers' && <DriversTab />}
      {tab === 'maintenance' && <MaintenanceTab />}
    </div>
  );
}

function GroupsTab() {
  const qc = useQueryClient();
  const { data: groups } = useQuery({
    queryKey: ['fleet-groups'],
    queryFn: () => api<FleetGroup[]>('/api/v1/fleet/groups'),
  });
  const { data: vehicles } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => api<{ id: string; displayName: string }[]>('/api/v1/vehicles'),
  });
  const [add, setAdd] = useState(false);
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api('/api/v1/fleet/groups', { method: 'POST', body: { name } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fleet-groups'] });
      setAdd(false);
      setName('');
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/fleet/groups/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fleet-groups'] }),
  });
  const setVehicles = useMutation({
    mutationFn: (g: { id: string; vehicleIds: string[] }) =>
      api(`/api/v1/fleet/groups/${g.id}/vehicles`, {
        method: 'PUT',
        body: { vehicleIds: g.vehicleIds },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fleet-groups'] }),
  });

  return (
    <Card
      title="Vehicle groups"
      actions={
        <Button onClick={() => setAdd(true)}>
          <Plus size={13} /> New group
        </Button>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        {(groups ?? []).map((g) => (
          <div key={g.id} className="rounded-xl border border-line bg-panel2 p-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">{g.name}</h3>
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs text-danger"
                onClick={() => {
                  if (confirm('Delete group?')) remove.mutate(g.id);
                }}
                aria-label={`Delete ${g.name}`}
              >
                <Trash2 size={12} />
              </Button>
            </div>
            <p className="mt-1 text-xs text-faint">{g.description ?? 'No description'}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {(vehicles ?? []).map((v) => {
                const inGroup = g.vehicleIds.includes(v.id);
                return (
                  <button
                    key={v.id}
                    onClick={() =>
                      setVehicles.mutate({
                        id: g.id,
                        vehicleIds: inGroup
                          ? g.vehicleIds.filter((x) => x !== v.id)
                          : [...g.vehicleIds, v.id],
                      })
                    }
                    className={`rounded-full border px-2 py-0.5 text-xs ${inGroup ? 'border-accent/60 bg-accent/15 text-accent' : 'border-line text-subtle hover:border-faint'}`}
                    aria-pressed={inGroup}
                  >
                    {v.displayName}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {(groups ?? []).length === 0 && (
          <p className="py-2 text-sm text-faint md:col-span-2">
            No groups. Create one to organize your fleet.
          </p>
        )}
      </div>
      <Modal open={add} onClose={() => setAdd(false)} title="New vehicle group">
        <div className="space-y-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdd(false)}>
              Cancel
            </Button>
            <Button disabled={!name} onClick={() => create.mutate()}>
              Create
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

function DriversTab() {
  const qc = useQueryClient();
  const { data: drivers } = useQuery({
    queryKey: ['drivers'],
    queryFn: () => api<Driver[]>('/api/v1/fleet/drivers'),
  });
  const { data: departments } = useQuery({
    queryKey: ['departments'],
    queryFn: () => api<Department[]>('/api/v1/fleet/departments'),
  });
  const { data: costCenters } = useQuery({
    queryKey: ['cost-centers'],
    queryFn: () => api<CostCenter[]>('/api/v1/fleet/cost-centers'),
  });
  const { data: assignments } = useQuery({
    queryKey: ['assignments'],
    queryFn: () =>
      api<(VehicleAssignment & { vehicleName: string })[]>('/api/v1/fleet/assignments'),
  });
  const { data: vehicles } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => api<{ id: string; displayName: string }[]>('/api/v1/vehicles'),
  });
  const [add, setAdd] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const create = useMutation({
    mutationFn: () => api('/api/v1/fleet/drivers', { method: 'POST', body: { name, email } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['drivers'] });
      setAdd(false);
      setName('');
      setEmail('');
    },
  });
  const removeDriver = useMutation({
    mutationFn: (id: string) => api(`/api/v1/fleet/drivers/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['drivers'] }),
  });

  const assign = useMutation({
    mutationFn: (p: { vehicleId: string; driverId: string }) =>
      api('/api/v1/fleet/assignments', { method: 'POST', body: p }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assignments'] }),
  });
  const unassign = useMutation({
    mutationFn: (id: string) => api(`/api/v1/fleet/assignments/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assignments'] }),
  });
  const [pendingVehicle, setPendingVehicle] = useState<Record<string, string>>({});

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card
        title="Drivers"
        actions={
          <Button onClick={() => setAdd(true)}>
            <Plus size={13} /> Add driver
          </Button>
        }
      >
        <ul className="space-y-2">
          {(drivers ?? []).map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between rounded-lg border border-line bg-panel2 px-3 py-2 text-sm"
            >
              <span>
                <span className="font-medium">{d.name}</span>
                {d.email && <span className="ml-2 text-xs text-faint">{d.email}</span>}
              </span>
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs text-danger"
                onClick={() => {
                  if (confirm('Remove driver?')) removeDriver.mutate(d.id);
                }}
              >
                <Trash2 size={12} />
              </Button>
            </li>
          ))}
          {(drivers ?? []).length === 0 && <p className="py-2 text-sm text-faint">No drivers.</p>}
        </ul>
        <p className="mt-2 text-xs text-faint">
          Departments: {(departments ?? []).map((d) => d.name).join(', ') || 'none'} · Cost centers:{' '}
          {(costCenters ?? []).map((c) => c.name).join(', ') || 'none'}
        </p>
      </Card>

      <Card title="Assignments">
        <ul className="space-y-2">
          {(assignments ?? []).map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between rounded-lg border border-line bg-panel2 px-3 py-2 text-sm"
            >
              <span>
                <span className="font-medium">{a.vehicleName}</span> → {a.driverName}
              </span>
              <Button
                variant="ghost"
                className="px-2 py-1 text-xs text-danger"
                onClick={() => unassign.mutate(a.id)}
              >
                <Trash2 size={12} />
              </Button>
            </li>
          ))}
          {(assignments ?? []).length === 0 && (
            <p className="py-2 text-sm text-faint">No assignments.</p>
          )}
        </ul>
        <div className="mt-3 flex gap-2">
          <Select
            aria-label="Vehicle to assign"
            value={pendingVehicle.vehicle ?? ''}
            onChange={(e) => setPendingVehicle((p) => ({ ...p, vehicle: e.target.value }))}
            className="flex-1 text-sm"
          >
            {' '}
            <option value="">Choose vehicle…</option>
            {(vehicles ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.displayName}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Driver"
            value={pendingVehicle.driver ?? ''}
            onChange={(e) => setPendingVehicle((p) => ({ ...p, driver: e.target.value }))}
            className="flex-1 text-sm"
          >
            <option value="">Choose driver…</option>
            {(drivers ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <Button
            disabled={!pendingVehicle.vehicle || !pendingVehicle.driver}
            onClick={() => {
              assign.mutate({
                vehicleId: pendingVehicle.vehicle!,
                driverId: pendingVehicle.driver!,
              });
              setPendingVehicle({});
            }}
          >
            Assign
          </Button>
        </div>
      </Card>

      <Modal open={add} onClose={() => setAdd(false)} title="Add driver">
        <div className="space-y-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email (optional)">
            <Input value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdd(false)}>
              Cancel
            </Button>
            <Button disabled={!name} onClick={() => create.mutate()}>
              Add driver
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function MaintenanceTab() {
  const qc = useQueryClient();
  const { data: records } = useQuery({
    queryKey: ['maintenance'],
    queryFn: () =>
      api<(MaintenanceRecord & { vehicleName: string })[]>('/api/v1/fleet/maintenance'),
  });
  const { data: vehicles } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => api<{ id: string; displayName: string }[]>('/api/v1/vehicles'),
  });
  const [add, setAdd] = useState(false);
  const [form, setForm] = useState({ vehicleId: '', title: '', kind: 'service', dueAt: '' });
  const create = useMutation({
    mutationFn: () => api('/api/v1/fleet/maintenance', { method: 'POST', body: form }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maintenance'] });
      setAdd(false);
    },
  });
  const complete = useMutation({
    mutationFn: (m: MaintenanceRecord) =>
      api(`/api/v1/fleet/maintenance/${m.id}`, {
        method: 'PATCH',
        body: { completedAt: m.completedAt ? null : new Date().toISOString() },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['maintenance'] }),
  });

  return (
    <Card
      title="Maintenance, registration & insurance"
      actions={
        <Button onClick={() => setAdd(true)}>
          <Plus size={13} /> Add record
        </Button>
      }
    >
      <ul className="space-y-2">
        {(records ?? []).map((m) => {
          const overdue = m.dueAt && new Date(m.dueAt) < new Date() && !m.completedAt;
          return (
            <li
              key={m.id}
              className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm ${overdue ? 'border-danger/50 bg-danger/10' : 'border-line bg-panel2'}`}
            >
              {overdue && <AlertTriangle size={14} className="text-danger" />}
              <span className="font-medium">{m.vehicleName}</span>
              <span className="text-subtle">{m.title}</span>
              <Badge tone="neutral">{m.kind}</Badge>
              {m.dueAt && (
                <span className="text-xs text-faint">
                  due {new Date(m.dueAt).toLocaleDateString()}
                </span>
              )}
              {m.dueOdometerKm && (
                <span className="text-xs text-faint">at {m.dueOdometerKm} km</span>
              )}
              <Button
                variant="secondary"
                className="ml-auto px-2 py-1 text-xs"
                onClick={() => complete.mutate(m)}
              >
                {m.completedAt ? 'Reopen' : 'Complete'}
              </Button>
            </li>
          );
        })}
        {(records ?? []).length === 0 && (
          <p className="py-2 text-sm text-faint">No maintenance records.</p>
        )}
      </ul>
      <Modal open={add} onClose={() => setAdd(false)} title="Add maintenance record">
        <div className="space-y-3">
          <Field label="Vehicle">
            <Select
              value={form.vehicleId}
              onChange={(e) => setForm((f) => ({ ...f, vehicleId: e.target.value }))}
            >
              <option value="">Choose…</option>
              {(vehicles ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title">
            <Input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Kind">
              <Select
                value={form.kind}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
              >
                {['service', 'registration', 'insurance', 'tires', 'inspection', 'other'].map(
                  (k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field label="Due date">
              <Input
                type="date"
                value={form.dueAt}
                onChange={(e) => setForm((f) => ({ ...f, dueAt: e.target.value }))}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdd(false)}>
              Cancel
            </Button>
            <Button disabled={!form.vehicleId || !form.title} onClick={() => create.mutate()}>
              Add record
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

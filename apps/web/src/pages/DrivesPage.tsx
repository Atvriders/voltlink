// Drives page: searchable, filterable, paginated drive history with totals
// and CSV/JSON export.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Gauge } from 'lucide-react';
import { api, apiCsv } from '../api/client';
import { Badge, Button, Card, EmptyState, Input, Select, Spinner } from '../components/ui';
import { fmtClock, fmtDist, fmtDuration, fmtEfficiency, fmtEnergy, fmtMoney } from '../lib/format';
import { useAuth } from '../auth/AuthContext';
import type { Drive } from '@voltlink/shared';

export default function DrivesPage() {
  const { user } = useAuth();
  const units = user?.units ?? 'metric';
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [classification, setClassification] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [sort, setSort] = useState('startAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const qs = new URLSearchParams({ page: String(page), pageSize: '20', sort, order });
  if (search) qs.set('search', search);
  if (classification) qs.set('classification', classification);
  if (vehicleId) qs.set('vehicleId', vehicleId);
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);

  const { data, isLoading } = useQuery({
    queryKey: ['drives', qs.toString()],
    queryFn: () =>
      api<{ items: Drive[]; total: number; page: number; pageSize: number }>(
        `/api/v1/drives?${qs.toString()}`,
      ),
  });
  const totalsQs = new URLSearchParams();
  if (from) totalsQs.set('from', from);
  if (to) totalsQs.set('to', to);
  const { data: totals } = useQuery({
    queryKey: ['drives-totals', totalsQs.toString()],
    queryFn: () =>
      api<{
        count: number;
        distanceKm: number;
        energyKwh: number;
        estCost: number;
        costPerKm: number;
      }>(`/api/v1/drives/totals?${totalsQs.toString()}`),
  });
  const { data: vehicles } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => api<{ id: string; displayName: string }[]>('/api/v1/vehicles'),
  });

  const download = async (fmt: 'csv' | 'json') => {
    const csv = await apiCsv(`/api/v1/drives/export/${fmt}`);
    const blob = new Blob([csv], { type: fmt === 'csv' ? 'text/csv' : 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `voltlink-drives.${fmt}`;
    a.click();
  };

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / 20));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-extrabold">Drives</h1>
        {totals && (
          <span className="text-xs text-subtle">
            {totals.count} drives · {fmtDist(totals.distanceKm, units, 0)} ·{' '}
            {fmtEnergy(totals.energyKwh)} · {fmtMoney(totals.estCost)} ({fmtMoney(totals.costPerKm)}
            /km)
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

      <Card pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <label className="flex items-center gap-1.5 text-xs text-subtle">
            From
            <Input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
              aria-label="From date"
              className="w-40"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-subtle">
            To
            <Input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
              aria-label="To date"
              className="w-40"
            />
          </label>
          <Input
            placeholder="Search address or driver…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="max-w-xs"
            aria-label="Search drives"
          />
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
            aria-label="Classification"
            value={classification}
            onChange={(e) => {
              setClassification(e.target.value);
              setPage(1);
            }}
            className="max-w-40"
          >
            <option value="">All types</option>
            <option value="business">Business</option>
            <option value="personal">Personal</option>
            <option value="unknown">Unknown</option>
          </Select>
          <Select
            aria-label="Sort"
            value={`${sort}:${order}`}
            onChange={(e) => {
              const [s, o] = e.target.value.split(':');
              if (s) setSort(s);
              setOrder(o === 'asc' ? 'asc' : 'desc');
            }}
            className="max-w-44"
          >
            <option value="startAt:desc">Newest first</option>
            <option value="startAt:asc">Oldest first</option>
            <option value="distanceKm:desc">Longest first</option>
            <option value="energyKwh:desc">Most energy</option>
            <option value="efficiencyWhPerKm:asc">Most efficient</option>
          </Select>
        </div>

        {isLoading ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner size={22} />
          </div>
        ) : (data?.items.length ?? 0) === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<Gauge size={28} className="text-faint" />}
              title="No drives found"
              body="Try different filters, or take a drive and it will appear here."
            />
          </div>
        ) : (
          <>
            <ul className="divide-y divide-line">
              {data!.items.map((d) => (
                <li key={d.id}>
                  <Link
                    to={`/drives/${d.id}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm hover:bg-panel2"
                  >
                    <span className="w-32 shrink-0 font-medium">{d.vehicleName}</span>
                    <span className="w-36 whitespace-nowrap text-subtle tabular-nums">
                      {fmtClock(d.startAt, user?.timezone)} → {fmtClock(d.endAt, user?.timezone)}
                    </span>
                    <span className="w-24">{fmtDist(d.distanceKm, units)}</span>
                    <span className="w-20 text-subtle">{fmtDuration(d.durationSec)}</span>
                    <span className="w-24 text-subtle">{fmtEnergy(d.energyKwh)}</span>
                    <span className="w-24 text-subtle">
                      {fmtEfficiency(d.efficiencyWhPerKm, units)}
                    </span>
                    <Badge
                      tone={
                        d.classification === 'business'
                          ? 'info'
                          : d.classification === 'personal'
                            ? 'neutral'
                            : 'warn'
                      }
                    >
                      {d.classification}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm">
              <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span className="text-faint">
                Page {page} of {totalPages} ({data?.total} total)
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
  );
}

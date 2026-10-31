// Drive detail: full metrics, map replay with play/pause, tags and notes.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pause, Play, RotateCcw, Tag } from 'lucide-react';
import { api } from '../api/client';
import MapView, { routeGeoJson } from '../components/MapView';
import { Badge, Button, Card, Field, Input, Select, Spinner, Stat } from '../components/ui';
import { fmtDist, fmtDuration, fmtEnergy, fmtSpeed, fmtTemp } from '../lib/format';
import { useAuth } from '../auth/AuthContext';
import type { Drive } from '@voltlink/shared';

export default function DriveDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const units = user?.units ?? 'metric';
  const qc = useQueryClient();
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [classification, setClassification] = useState('');
  const [notes, setNotes] = useState('');
  const timer = useRef<number | null>(null);

  const { data: drive, isLoading } = useQuery({
    queryKey: ['drive', id],
    queryFn: () => api<Drive>(`/api/v1/drives/${id}?route=true`),
  });

  useEffect(() => {
    if (drive) {
      setClassification(drive.classification);
      setNotes(drive.notes ?? '');
    }
  }, [drive]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api(`/api/v1/drives/${id}`, { method: 'PATCH', body: { classification, notes } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['drive', id] }),
  });

  const route = useMemo(() => drive?.route ?? [], [drive?.route]);
  const replayPoints = useMemo(
    () => route.slice(0, Math.max(1, Math.floor((progress / 100) * route.length))),
    [route, progress],
  );

  useEffect(() => {
    if (!playing || route.length === 0) return;
    timer.current = window.setInterval(() => {
      setProgress((p) => {
        if (p >= 100) {
          setPlaying(false);
          return 100;
        }
        return p + 2;
      });
    }, 200);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, route.length]);

  if (isLoading)
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner size={22} />
      </div>
    );
  if (!drive) return <p className="text-sm text-subtle">Drive not found.</p>;

  const layers = [
    { id: 'route', kind: 'route' as const, color: '#0ea5e9', feature: routeGeoJson(route) },
    ...(replayPoints.length > 1
      ? [
          {
            id: 'replay',
            kind: 'replay' as const,
            color: '#fbbf24',
            feature: routeGeoJson(replayPoints),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/drives"
          className="flex items-center gap-1 text-sm text-subtle hover:text-accent"
        >
          <ArrowLeft size={14} /> Drives
        </Link>
        <h1 className="text-lg font-extrabold">{drive.vehicleName} — drive</h1>
        <Badge tone={drive.classification === 'business' ? 'info' : 'neutral'}>
          {drive.classification}
        </Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card
            title="Route replay"
            actions={
              <div className="flex items-center gap-1">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setProgress(0);
                    setPlaying(false);
                  }}
                >
                  <RotateCcw size={14} />
                </Button>
                <Button
                  variant={playing ? 'secondary' : 'primary'}
                  onClick={() => {
                    if (progress >= 100) setProgress(0);
                    setPlaying((p) => !p);
                  }}
                >
                  {playing ? <Pause size={14} /> : <Play size={14} />}{' '}
                  {playing ? 'Pause' : 'Replay'}
                </Button>
              </div>
            }
          >
            <MapView layers={layers} height={380} />
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-panel2">
              <div className="h-full bg-warn transition-all" style={{ width: `${progress}%` }} />
            </div>
          </Card>

          <Card title="Classification & notes">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Classification">
                <Select value={classification} onChange={(e) => setClassification(e.target.value)}>
                  <option value="unknown">Unknown</option>
                  <option value="business">Business</option>
                  <option value="personal">Personal</option>
                </Select>
              </Field>
              <Field label="Notes">
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Add notes…"
                />
              </Field>
            </div>
            <div className="mt-3 flex justify-end">
              <Button loading={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                <Tag size={14} /> Save
              </Button>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Drive summary">
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Distance" value={fmtDist(drive.distanceKm, units)} />
              <Stat label="Duration" value={fmtDuration(drive.durationSec)} />
              <Stat label="Avg speed" value={fmtSpeed(drive.avgSpeedKmh, units)} />
              <Stat label="Max speed" value={fmtSpeed(drive.maxSpeedKmh, units)} />
              <Stat label="Energy" value={fmtEnergy(drive.energyKwh)} />
              <Stat label="Efficiency" value={`${Math.round(drive.efficiencyWhPerKm)} Wh/km`} />
            </div>
            <dl className="mt-3 space-y-1.5 text-sm">
              <SummaryRow
                k="Started"
                v={`${drive.startAddress ?? '—'} · ${new Date(drive.startAt).toLocaleString()}`}
              />
              <SummaryRow
                k="Ended"
                v={`${drive.endAddress ?? '—'} · ${new Date(drive.endAt).toLocaleString()}`}
              />
              {drive.elevationGainM !== undefined && (
                <SummaryRow k="Elevation gain" v={`${Math.round(drive.elevationGainM)} m`} />
              )}
              {drive.avgOutsideTempC !== undefined && (
                <SummaryRow k="Avg outside temp" v={fmtTemp(drive.avgOutsideTempC, units)} />
              )}
              {drive.driverName && <SummaryRow k="Driver" v={drive.driverName} />}
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-wider text-faint">{k}</dt>
      <dd className="text-sm">{v}</dd>
    </div>
  );
}

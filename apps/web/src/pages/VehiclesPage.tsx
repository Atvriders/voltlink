// Vehicles list page (F-NAVREDIRECT): the sidebar 'Vehicles' item leads here
// instead of redirecting to Overview.

import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { api } from '../api/client';
import { Badge, Card } from '../components/ui';
import { ErrorState, LoadingState } from '../components/QueryState';
import { STATUS_LABEL } from '../lib/format';
import type { VehicleWithState } from '@voltlink/shared';

export default function VehiclesPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => api<VehicleWithState[]>('/api/v1/vehicles'),
  });

  if (isLoading) return <LoadingState label="Loading vehicles…" />;
  if (error || !data)
    return (
      <ErrorState error={error ?? new Error('No vehicles found')} onRetry={() => void refetch()} />
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-extrabold">Vehicles</h1>
        <span className="text-xs text-faint">{data.length} total</span>
      </div>
      {data.length === 0 ? (
        <Card>
          <p className="py-2 text-sm text-faint">No vehicles yet.</p>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {data.map((v) => (
            <li key={v.id}>
              <Link
                to={`/vehicles/${v.id}`}
                className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 transition-colors hover:border-accent/60"
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: v.exteriorColor ?? '#475569' }}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{v.displayName}</span>
                  <span className="block truncate text-xs text-faint">
                    {v.providerVehicleId} · {v.provider}
                  </span>
                </span>
                {v.state && (
                  <Badge tone={(STATUS_LABEL[v.state.status] ?? STATUS_LABEL.unknown!).tone}>
                    {(STATUS_LABEL[v.state.status] ?? STATUS_LABEL.unknown!).label}
                  </Badge>
                )}
                <ChevronRight size={16} className="ml-auto shrink-0 text-faint" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

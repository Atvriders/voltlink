// Command history page (F-NAVREDIRECT): 'Full history' lands on a real,
// paginated list of commands for one vehicle.

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api/client';
import { Badge, Button, Card } from '../components/ui';
import { ErrorState, LoadingState } from '../components/QueryState';
import { COMMAND_STATUS_LABEL, fmtDateTime } from '../lib/format';
import { COMMAND_DEFINITIONS, type VehicleCommand, type VehicleWithState } from '@voltlink/shared';

export default function CommandHistoryPage() {
  const { id = '' } = useParams();
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const commands = useQuery({
    queryKey: ['commands', id, page],
    queryFn: () =>
      api<{ items: VehicleCommand[]; total: number }>(
        `/api/v1/commands?vehicleId=${id}&page=${page}&pageSize=${pageSize}`,
      ),
  });
  const vehicle = useQuery({
    queryKey: ['vehicle', id],
    queryFn: () => api<VehicleWithState>(`/api/v1/vehicles/${id}`),
  });

  if (commands.isLoading) return <LoadingState label="Loading command history…" />;
  if (commands.error)
    return <ErrorState error={commands.error} onRetry={() => void commands.refetch()} />;

  const total = commands.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link to={`/vehicles/${id}`} className="text-sm text-subtle hover:text-accent">
          {vehicle.data?.displayName ?? id}
        </Link>
        <span className="text-faint">/</span>
        <h1 className="text-lg font-extrabold">Command history</h1>
      </div>
      <Card>
        {commands.data && commands.data.items.length > 0 ? (
          <>
            <ul className="divide-y divide-line">
              {commands.data.items.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <Activity size={14} className="text-subtle" />
                  <span className="font-medium">
                    {COMMAND_DEFINITIONS[c.type]?.label ?? c.type}
                  </span>
                  <span className="whitespace-nowrap text-xs text-faint">
                    {fmtDateTime(c.createdAt)}
                  </span>
                  <span className="ml-auto">
                    <Badge tone={COMMAND_STATUS_LABEL[c.status]?.tone ?? 'neutral'}>
                      {(COMMAND_STATUS_LABEL[c.status] ?? { label: c.status }).label}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-line pt-3">
              <Button
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft size={14} /> Newer
              </Button>
              <span className="text-xs text-faint">
                Page {page} of {pages}
              </span>
              <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Older <ChevronRight size={14} />
              </Button>
            </div>
          </>
        ) : (
          <p className="py-2 text-sm text-faint">No commands issued for this vehicle yet.</p>
        )}
      </Card>
    </div>
  );
}

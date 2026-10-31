// F-ERRSTATES: shared loading / error / empty rendering for every useQuery
// that renders content. Errors are role="alert" with status-specific messages.
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { errorText } from '../lib/toast';
import { Button, Spinner } from './ui';

export function ErrorState({
  error,
  onRetry,
  title = 'Couldn’t load',
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-danger/40 bg-danger/10 p-4">
      <p className="text-sm font-semibold text-danger">{title}</p>
      <p className="text-sm text-foreground">{errorText(error)}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          <RefreshCw size={14} /> Retry
        </Button>
      )}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="flex h-32 items-center justify-center gap-2">
      <Spinner />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-control p-6 text-center">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {hint && <p className="mt-1 text-xs text-subtle">{hint}</p>}
    </div>
  );
}

export function QueryState<T>({
  query,
  isEmpty,
  empty,
  children,
}: {
  query: UseQueryResult<T>;
  isEmpty?: (d: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (query.data !== undefined && isEmpty?.(query.data)) return <>{empty}</>;
  if (query.data === undefined) return <LoadingState />;
  return <>{children(query.data)}</>;
}

// Error boundaries (guide 07 §2.2, F-WEBGLBLANK): a route or WebGL error must
// never blank the app — the Shell stays alive and a fallback is shown.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui';

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? 'Unknown error');
}

export function RouteErrorFallback({
  error,
  resetErrorBoundary,
}: {
  error: unknown;
  resetErrorBoundary: () => void;
}) {
  return (
    <section role="alert" className="card space-y-3 p-6">
      <h1 className="text-lg font-bold">This page hit an error</h1>
      <p className="text-sm text-subtle">{getErrorMessage(error)}</p>
      <div className="flex gap-2">
        <Button onClick={resetErrorBoundary}>Try again</Button>
        <Button variant="secondary" onClick={() => location.reload()}>
          Reload VoltLink
        </Button>
      </div>
    </section>
  );
}

export function RootErrorFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <section role="alert" className="card max-w-md space-y-3 p-6">
        <h1 className="text-lg font-bold">VoltLink could not load</h1>
        <p className="text-sm text-subtle">
          Something went wrong while starting the app. Reload to try again.
        </p>
        <Button onClick={() => location.reload()}>Reload</Button>
      </section>
    </div>
  );
}

interface BoundaryProps {
  children: ReactNode;
  fallback: (error: unknown, reset: () => void) => ReactNode;
}

interface BoundaryState {
  error: unknown;
}

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[voltlink] boundary caught:', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render(): ReactNode {
    if (this.state.error !== null) {
      return this.props.fallback(this.state.error, this.reset);
    }
    return this.props.children;
  }
}

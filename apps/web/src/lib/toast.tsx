// F-ERRSTATES: toast event bus + region. Errors stay until dismissed and are
// role="alert"; info toasts are role="status", dismiss after 6 s and pause
// while hovered or focused.
import * as React from 'react';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { ApiError } from '../api/client';

export type ToastTone = 'error' | 'info';

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

let nextId = 1;
const listeners = new Set<(t: ToastItem[]) => void>();
let items: ToastItem[] = [];

function emit() {
  for (const l of listeners) l([...items]);
}

function push(tone: ToastTone, message: string) {
  items = [...items, { id: nextId++, tone, message }];
  emit();
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  error: (message: string) => push('error', message),
  info: (message: string) => push('info', message),
  dismiss,
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const suffix = err.requestId ? ` (request ${err.requestId})` : '';
    if (err.status === 0) return 'Can’t reach the server';
    if (err.status === 403) return 'You don’t have access';
    if (err.status === 404) return 'Not found';
    return `${err.message}${suffix}`;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}

export function ToastRegion() {
  const [toasts, setToasts] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setToasts);
    return () => {
      listeners.delete(setToasts);
    };
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Notifications"
      className="fixed bottom-4 right-4 z-[70] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((t) => (
        <Toast key={t.id} item={t} />
      ))}
    </div>
  );
}

function Toast({ item }: { item: ToastItem }) {
  const [visible, setVisible] = useState(true);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pausedRef = React.useRef(false);

  const start = React.useCallback(() => {
    if (item.tone !== 'info') return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(false), 6000);
  }, [item.tone]);

  const pause = React.useCallback(() => {
    pausedRef.current = true;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  const resume = React.useCallback(() => {
    pausedRef.current = false;
    start();
  }, [start]);

  React.useEffect(() => {
    start();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [start]);

  if (!visible) return null;
  return (
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      data-tone={item.tone}
      onMouseEnter={pause}
      onFocus={pause}
      onMouseLeave={resume}
      onBlur={resume}
      className="flex items-start justify-between gap-3 rounded-lg border border-control bg-surface p-3 text-sm shadow-lg"
    >
      <span className="text-foreground">{item.message}</span>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => toast.dismiss(item.id)}
        className="rounded p-1 text-subtle hover:bg-muted hover:text-foreground"
      >
        <X size={14} />
      </button>
    </div>
  );
}

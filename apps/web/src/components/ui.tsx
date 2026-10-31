// VoltLink UI primitives — accessible, keyboard-friendly, theme-aware.

import {
  cloneElement,
  isValidElement,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  useEffect,
  type SelectHTMLAttributes,
} from 'react';
import { Loader2, X } from 'lucide-react';

const toneStyles: Record<string, string> = {
  ok: 'bg-ok/15 text-ok border-ok/30',
  warn: 'bg-warn/15 text-warn border-warn/30',
  danger: 'bg-danger/15 text-danger border-danger/30',
  info: 'bg-info/15 text-info border-info/30',
  neutral: 'bg-panel2 text-subtle border-line',
  accent: 'bg-accent/15 text-accent border-accent/30',
  charging: 'bg-charging/15 text-charging border-charging/30',
};

export function Badge({
  tone = 'neutral',
  children,
  pulse,
}: {
  tone?: string;
  children: ReactNode;
  pulse?: boolean;
}) {
  return (
    <span className={`chip ${toneStyles[tone] ?? toneStyles.neutral} ${pulse ? 'pulse' : ''}`}>
      {children}
    </span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="animate-spin" aria-label="Loading" />;
}

export function Button({
  variant = 'primary',
  loading,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
  loading?: boolean;
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[38px]';
  const variants: Record<string, string> = {
    primary: 'bg-accent text-onaccent hover:brightness-110',
    secondary: 'bg-panel2 text-ink border border-line hover:border-faint',
    ghost: 'bg-transparent text-subtle hover:text-ink hover:bg-panel2',
    danger: 'bg-danger/90 text-white hover:bg-danger',
    outline: 'border border-accent/60 text-accent hover:bg-accent/10',
  };
  return (
    <button
      className={`${base} ${variants[variant]} ${className}`}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-focus focus:outline-none min-h-[38px] ${className}`}
      {...rest}
    />
  );
}

export function Select({
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink focus:border-focus focus:outline-none min-h-[38px] ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1 block text-xs font-semibold uppercase tracking-wide text-subtle"
    >
      {children}
    </label>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<{ id?: string }>, { id })
        : children}
      {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
    </div>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
  pad = true,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h2 className="text-sm font-bold">{title}</h2>
            {subtitle && <p className="text-xs text-faint">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : 'Dialog'}
    >
      <div className="max-h-[92vh] w-full overflow-auto rounded-t-2xl border border-line bg-panel p-0 shadow-2xl sm:max-w-lg sm:rounded-2xl">
        <header className="sticky top-0 flex items-center justify-between border-b border-line bg-panel px-5 py-3">
          <h2 className="text-base font-bold">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-subtle hover:bg-panel2 hover:text-ink"
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </header>
        <div className="p-5">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-panel2 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">{label}</p>
      <p className={`mt-1 text-xl font-bold ${tone ? `text-${tone}` : ''}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-subtle">{sub}</p>}
    </div>
  );
}

export function ProgressBar({
  value,
  max = 100,
  tone = 'bg-charging',
}: {
  value: number;
  max?: number;
  tone?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-panel2"
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <div
        className={`h-full rounded-full ${tone} transition-all duration-500`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
}: {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line p-8 text-center">
      {icon}
      <h3 className="font-semibold">{title}</h3>
      {body && <p className="max-w-sm text-sm text-subtle">{body}</p>}
    </div>
  );
}

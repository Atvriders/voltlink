// Small shared utilities for routes.

export function csv(lines: string[][]): string {
  return lines
    .map((l) =>
      l
        .map((cell) => {
          let c = String(cell);
          // N-CSV: neutralize spreadsheet formula injection.
          if (/^[=+\-@\t\r]/.test(c)) c = `'${c}`;
          if (/[",\n]/.test(c)) {
            return `"${c.replace(/"/g, '""')}"`;
          }
          return c;
        })
        .join(','),
    )
    .join('\n');
}

export function toDateParam(v: unknown): Date | undefined {
  if (typeof v !== 'string') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return (v as T) ?? fallback;
}

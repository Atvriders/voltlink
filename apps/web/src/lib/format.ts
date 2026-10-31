// Formatting helpers: units, distances, times, and state labels.

export type Units = 'metric' | 'imperial';

export function fmtKm(km: number, units: Units): string {
  if (units === 'imperial') return `${Math.round(km * 0.621371).toLocaleString()} mi`;
  return `${Math.round(km).toLocaleString()} km`;
}

export function fmtDist(km: number, units: Units, digits = 1): string {
  if (units === 'imperial') return `${(km * 0.621371).toFixed(digits)} mi`;
  return `${km.toFixed(digits)} km`;
}

export function fmtSpeed(kmh: number, units: Units): string {
  if (units === 'imperial') return `${Math.round(kmh * 0.621371)} mph`;
  return `${Math.round(kmh)} km/h`;
}

export function fmtTemp(c: number | undefined, units: Units): string {
  if (c === undefined) return '—';
  if (units === 'imperial') return `${Math.round((c * 9) / 5 + 32)}°F`;
  return `${Math.round(c)}°C`;
}

export function fmtPower(kw: number | undefined): string {
  if (kw === undefined || kw === null) return '—';
  return `${kw.toFixed(1)} kW`;
}

export function fmtEnergy(kwh: number | undefined): string {
  if (kwh === undefined || kwh === null) return '—';
  return `${kwh.toFixed(1)} kWh`;
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function fmtClock(iso: string | undefined, tz?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: tz,
    });
  } catch {
    return '—';
  }
}

export function fmtDateTime(iso: string | undefined, tz?: string): string {
  if (!iso) return '—';
  try {
    // F-UIMISC: medium date + short time in the user's time zone; the wrapper
    // column gets whitespace-nowrap tabular-nums so times never wrap.
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: tz,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** Wh/km (metric) or Wh/mi (imperial); 0 means unknown. */
export function fmtEfficiency(whPerKm: number | undefined, units: Units): string {
  if (whPerKm === undefined || whPerKm === null || whPerKm <= 0) return '—';
  if (units === 'imperial') return `${Math.round(whPerKm * 1.609344)} Wh/mi`;
  return `${Math.round(whPerKm)} Wh/km`;
}

/** kPa (metric) or psi (imperial). */
export function fmtPressure(kpa: number | undefined, units: Units): string {
  if (kpa === undefined || kpa === null) return '—';
  if (units === 'imperial') return `${Math.round(kpa * 0.1450377)} psi`;
  return `${Math.round(kpa)} kPa`;
}

/** Metres (metric) or feet (imperial). */
export function fmtElevation(m: number | undefined, units: Units): string {
  if (m === undefined || m === null) return '—';
  if (units === 'imperial') return `${Math.round(m * 3.28084).toLocaleString()} ft`;
  return `${Math.round(m).toLocaleString()} m`;
}

export function fmtMoney(n: number | undefined, currency = 'USD'): string {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString(undefined, { style: 'currency', currency, maximumFractionDigits: 2 });
}

export function timeAgo(iso: string | undefined): string {
  if (!iso) return '—';
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

export const FRESHNESS_LABEL: Record<
  string,
  { label: string; tone: 'ok' | 'warn' | 'danger' | 'info' }
> = {
  live: { label: 'Live', tone: 'ok' },
  recent: { label: 'Recently updated', tone: 'info' },
  stale: { label: 'Stale', tone: 'warn' },
  last_known: { label: 'Last known', tone: 'danger' },
};

export const STATUS_LABEL: Record<
  string,
  { label: string; tone: 'ok' | 'warn' | 'danger' | 'info' }
> = {
  online: { label: 'Online', tone: 'ok' },
  asleep: { label: 'Asleep', tone: 'info' },
  offline: { label: 'Offline', tone: 'danger' },
  charging: { label: 'Charging', tone: 'ok' },
  driving: { label: 'Driving', tone: 'info' },
  parked: { label: 'Parked', tone: 'ok' },
  unknown: { label: 'Unknown', tone: 'warn' },
};

export const COMMAND_STATUS_LABEL: Record<
  string,
  { label: string; tone: 'ok' | 'warn' | 'danger' | 'info' }
> = {
  queued: { label: 'Queued', tone: 'info' },
  submitted: { label: 'Submitted', tone: 'info' },
  accepted: { label: 'Provider accepted', tone: 'info' },
  confirmed: { label: 'Confirmed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  rejected: { label: 'Rejected', tone: 'danger' },
  unsupported: { label: 'Unsupported', tone: 'warn' },
  timed_out: { label: 'Timed out', tone: 'warn' },
  canceled: { label: 'Canceled', tone: 'warn' },
};

export function pct(n: number | undefined): string {
  return n === undefined || n === null ? '—' : `${Math.round(n)}%`;
}

export function batteryTone(n: number | undefined): 'ok' | 'warn' | 'danger' {
  if (n === undefined) return 'ok';
  if (n <= 20) return 'danger';
  if (n <= 40) return 'warn';
  return 'ok';
}

// core/metrics.ts — in-process Prometheus text exposition (spec L1642-L1647).
// Counters and gauges are process-local (per-role); a scraper aggregates
// across replicas by instance label.

type Labeled = Map<string, number>;

const counters: Map<string, Labeled> = new Map();
const gauges: Map<string, Labeled> = new Map();
const histograms: Map<string, { count: number; sum: number }> = new Map();

export function metricInc(name: string, label = ''): void {
  const m = counters.get(name) ?? new Map<string, number>();
  m.set(label, (m.get(label) ?? 0) + 1);
  counters.set(name, m);
}

export function metricSet(name: string, value: number, label = ''): void {
  const m = gauges.get(name) ?? new Map<string, number>();
  m.set(label, value);
  gauges.set(name, m);
}

export function metricObserve(name: string, valueMs: number): void {
  const h = histograms.get(name) ?? { count: 0, sum: 0 };
  h.count += 1;
  h.sum += valueMs;
  histograms.set(name, h);
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function metricsText(): string {
  const lines: string[] = [];
  for (const [name, labels] of counters) {
    lines.push(`# TYPE ${name} counter`);
    for (const [label, v] of labels) {
      const tag = label ? `{result="${esc(label)}"}` : '';
      lines.push(`${name}${tag} ${v}`);
    }
  }
  for (const [name, labels] of gauges) {
    lines.push(`# TYPE ${name} gauge`);
    for (const [label, v] of labels) lines.push(`${name}${label ? `{${esc(label)}}` : ''} ${v}`);
  }
  for (const [name, h] of histograms) {
    lines.push(`# TYPE ${name} summary`);
    lines.push(`${name}_count ${h.count}`);
    lines.push(`${name}_sum ${h.sum}`);
  }
  return lines.join('\n');
}

export const METRICS = {
  commandTotal: 'voltlink_command_total',
  commandLatencyMs: 'voltlink_command_latency_ms',
  providerFetchMs: 'voltlink_provider_fetch_ms',
  providerFetchErrors: 'voltlink_provider_fetch_errors_total',
  queueDepth: 'voltlink_queue_depth',
  lastPollSuccessEpoch: 'voltlink_last_poll_success_epoch_seconds',
  automationFailures: 'voltlink_automation_failures_total',
} as const;

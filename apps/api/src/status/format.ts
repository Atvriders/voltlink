// N-STATUSMISC: badge + RSS rendering shared by the web role
// (routes/status.ts) and the status role (statusServer.ts), so both answer
// identically and neither clips text nor serves SPA HTML for these paths.

const BADGE_LABELS: Record<string, [string, string]> = {
  operational: ['Operational', '#2e7d32'],
  degraded: ['Degraded', '#f9a825'],
  partial_outage: ['Partial outage', '#ef6c00'],
  major_outage: ['Major outage', '#c62828'],
  maintenance: ['Maintenance', '#1565c0'],
  unknown: ['Unknown', '#607d8b'],
};

// Approximate advance widths (px) for 11px Arial; generous so text never clips.
const CHAR_W = new Map<string, number>();
for (const [chars, w] of [
  ['ABCDEFGHJKLMNOPQRSTUVWXYZ0123456789', 7.6],
  ['IR', 6.2],
  ['abcdefghijklmnopqrstuvwxyz', 6.4],
  ['iltf', 4.6],
  [' ', 3.1],
  ['.', 3.1],
  [',', 3.1],
  [':', 3.1],
  ['-', 3.4],
] as const) {
  for (const ch of chars) CHAR_W.set(ch, w);
}

/** Measured text width for the badge (N-STATUSMISC). */
export function measureText(s: string): number {
  let w = 0;
  for (const ch of s) w += CHAR_W.get(ch) ?? 7;
  return w;
}

/** Renders the status badge with widths measured from the text. */
export function renderBadgeSvg(overall: string): string {
  const [label, color] = BADGE_LABELS[overall] ?? BADGE_LABELS.unknown!;
  const brand = 'VoltLink';
  const leftW = measureText(brand);
  const labelW = measureText(label);
  const leftRectW = Math.ceil(leftW + 12);
  const rightRectW = Math.ceil(labelW + 10);
  const width = leftRectW + rightRectW;
  const labelX = leftRectW + 6;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20">` +
    `<rect width="${leftRectW}" height="20" rx="4" fill="#424242"/>` +
    `<rect x="${leftRectW}" width="${rightRectW}" height="20" rx="4" fill="${color}"/>` +
    `<text x="6" y="14" font-family="Arial" font-size="11" fill="#fff">${brand}</text>` +
    `<text x="${labelX}" y="14" font-family="Arial" font-size="11" fill="#fff">${label}</text>` +
    `</svg>`
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Renders the status RSS feed with a channel link and stable guids. */
export function renderRssXml(
  bundle: {
    incidents: { id: string; title: string; status: string; updates: { message: string; createdAt: string }[] }[];
    updatedAt: string;
  },
  publicUrl: string,
): string {
  const items = bundle.incidents
    .slice(0, 20)
    .map((i) => {
      const latest = i.updates[0]?.createdAt ?? bundle.updatedAt;
      return (
        `<item><title>${escapeXml(i.title)}</title>` +
        `<link>${escapeXml(`${publicUrl}/status#incident-${i.id}`)}</link>` +
        `<guid isPermaLink="false">${i.id}</guid>` +
        `<pubDate>${new Date(latest).toUTCString()}</pubDate>` +
        `<description>${escapeXml(i.updates[0]?.message ?? i.status)}</description></item>`
      );
    })
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0">` +
    `<channel><title>VoltLink Status</title><link>${escapeXml(publicUrl)}</link>` +
    `<description>VoltLink platform status updates</description>${items}</channel></rss>`
  );
}

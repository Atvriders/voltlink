// The app's only CSP and scheme-dependent headers (NEW-15, guide 04 §6.3).
// Guide 06 and 07 set no CSP of their own; their needs are merged here:
// `script-src 'wasm-unsafe-eval'` (meshopt + KTX2 decoders), `worker-src blob:`
// (KTX2 transcoder) and `'self'` (MapLibre worker + /sw.js).

import helmet from 'helmet';

export function securityHeaders(publicUrl: string, extra: string[]): ReturnType<typeof helmet> {
  const https = new URL(publicUrl).protocol === 'https:';
  return helmet({
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: https ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', ...extra],
        connectSrc: ["'self'", ...extra],
        fontSrc: ["'self'", 'data:'],
        workerSrc: ["'self'", 'blob:'],
        upgradeInsecureRequests: https ? [] : null,
      },
    },
  });
}

export function cspExtraOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

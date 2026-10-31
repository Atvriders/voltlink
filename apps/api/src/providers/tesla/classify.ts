// Tesla error classification (guide 01 §6). One place maps status/text to a
// category the lifecycle and readiness can act on.

export type TeslaErrorCategory =
  | 'token_expired'
  | 'reauth_required'
  | 'mobile_access_disabled'
  | 'billing_required'
  | 'missing_scope'
  | 'protocol_required'
  | 'not_found'
  | 'vehicle_unavailable'
  | 'vehicle_busy'
  | 'partner_not_registered'
  | 'virtual_key_not_paired'
  | 'wrong_region'
  | 'protocol_unsupported'
  | 'invalid_request'
  | 'invalid_command'
  | 'account_locked'
  | 'rate_limited'
  | 'legal_region'
  | 'provider_error'
  | 'outcome_unknown'
  | 'proxy_unavailable';

export class TeslaApiError extends Error {
  constructor(
    readonly status: number,
    readonly category: TeslaErrorCategory,
    readonly detail: string,
    readonly retryAfterMs?: number,
  ) {
    super(`Tesla ${status} ${category}`);
  }
}

export function classify(status: number, text: string, h: Headers): TeslaApiError {
  const t = text.toLowerCase();
  const raRaw = h.get('retry-after') ?? h.get('ratelimit-reset');
  const ra = Number(raRaw);
  const category: TeslaErrorCategory =
    t.includes('vehicle is offline or asleep') || status === 408
      ? 'vehicle_unavailable' // proxy v0.4.1 sends this text with 500
      : t.includes('public key has not been paired')
        ? 'virtual_key_not_paired' // v0.4.1: 500; proxy main: 412
        : t.includes('vehicle busy or finishing wake-up')
          ? 'vehicle_busy'
          : status === 401
            ? t.includes('mobile_access_disabled')
              ? 'mobile_access_disabled'
              : t.includes('login_required')
                ? 'reauth_required'
                : 'token_expired'
            : status === 402
              ? 'billing_required'
              : status === 403
                ? t.includes('command protocol')
                  ? 'protocol_required'
                  : 'missing_scope'
                : status === 404
                  ? 'not_found'
                  : status === 412
                    ? 'partner_not_registered'
                    : status === 421
                      ? 'wrong_region'
                      : status === 422
                        ? t.includes('command protocol')
                          ? 'protocol_unsupported'
                          : 'invalid_request'
                        : status === 423
                          ? 'account_locked'
                          : status === 429
                            ? 'rate_limited'
                            : status === 451
                              ? 'legal_region'
                              : status === 400
                                ? t.includes('invalid_command')
                                  ? 'invalid_command'
                                  : 'invalid_request'
                                : status === 503 || status === 504
                                  ? 'outcome_unknown'
                                  : 'provider_error';
  return new TeslaApiError(
    status,
    category,
    text.slice(0, 300),
    Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined,
  );
}

// Normalizing proxy responses into the VoltLink command lifecycle (guide 01
// §10, P-TESLASIGN). `result:false` is always a rejection, never a failure
// masquerade, and non-idempotent commands never auto-retry.

import type { CommandDispatchResult } from '../types';
import { TeslaApiError } from './classify';
import type { CommandStep } from './commands';

export function normalizeTeslaError(
  err: unknown,
  sent: boolean,
  step: CommandStep | null,
): CommandDispatchResult {
  if (!(err instanceof TeslaApiError)) {
    return {
      kind: 'failed',
      errorMessage: (err as Error).message.slice(0, 200),
      providerCode: 'INTERNAL',
      retryable: false,
    };
  }
  const base = {
    errorMessage: err.detail || err.message,
    providerCode: `TESLA:${err.category}`,
    retryAfterSec: err.retryAfterMs ? Math.ceil(err.retryAfterMs / 1000) : undefined,
  };
  switch (err.category) {
    case 'vehicle_unavailable':
      return { kind: 'rejected', ...base };
    case 'vehicle_busy':
      return { kind: 'rejected', ...base };
    case 'virtual_key_not_paired':
      return { kind: 'rejected', ...base, providerCode: 'TESLA:virtual_key_not_paired' };
    case 'protocol_required':
      return { kind: 'unsupported', ...base };
    case 'invalid_command':
      return { kind: 'unsupported', ...base };
    case 'partner_not_registered':
    case 'billing_required':
    case 'reauth_required':
    case 'missing_scope':
      return { kind: 'failed', ...base, retryable: false };
    case 'proxy_unavailable':
      return { kind: 'failed', ...base, retryable: true };
    case 'outcome_unknown':
      return { kind: 'outcome_unknown', ...base };
    case 'rate_limited':
      return { kind: 'failed', ...base, retryable: true };
    default:
      return sent && step && !step.idempotent
        ? { kind: 'outcome_unknown', ...base }
        : { kind: 'failed', ...base, retryable: true };
  }
}

export function normalizeTeslaResponse(
  body: { response?: { result?: boolean; reason?: string } },
  _step: CommandStep | null,
): CommandDispatchResult {
  const result = body.response?.result;
  if (result === true)
    return { kind: 'accepted', response: 'Vehicle command accepted.', providerCode: 'OK' };
  if (result === false) {
    return {
      kind: 'rejected',
      errorMessage: body.response?.reason ?? 'Command refused by vehicle.',
      providerCode: `TESLA:RESULT_FALSE:${body.response?.reason ?? 'none'}`,
    };
  }
  // A 200 without a boolean result is a bad response, never accepted.
  return {
    kind: 'failed',
    errorMessage: 'Tesla returned no result flag.',
    providerCode: 'TESLA:BAD_RESPONSE',
  };
}

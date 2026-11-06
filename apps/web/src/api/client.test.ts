// Unit coverage for the API client: CSRF bootstrap, step-up retry, error
// mapping, raw/csv paths and the unauthorized event.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, apiCsv, fetchCsrf, ApiError, resetCsrf } from './client';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonRes(body: unknown, status = 200, headers?: Record<string, string>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    clone: () => jsonRes(body, status, headers),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

afterEach(() => {
  fetchMock.mockReset();
  resetCsrf();
});

describe('api client', () => {
  it('bootstraps CSRF for mutating calls and returns data', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { token: 'tok-1' } }))
      .mockResolvedValueOnce(jsonRes({ data: { ok: true } }));
    const out = await api('/api/v1/x', { method: 'POST', body: { a: 1 } });
    expect(out).toEqual({ ok: true });
    const csrfCall = fetchMock.mock.calls[0]!;
    expect(csrfCall[0]).toBe('/api/v1/auth/csrf');
    const sendCall = fetchMock.mock.calls[1]!;
    expect(sendCall[1]?.headers).toMatchObject({ 'X-VL-CSRF': 'tok-1' });
  });

  it('retries once after a step-up challenge and maps errors', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes({ data: { token: 'tok-1' } }))
      .mockResolvedValueOnce(
        jsonRes({ error: { code: 'STEP_UP_REQUIRED', details: { methods: ['password'] } } }, 403),
      )
      .mockResolvedValueOnce(jsonRes({ data: { ok: true } }));

    let askedMethods: string[] = [];
    const { setStepUpHandler } = await import('../lib/stepUpBus');
    setStepUpHandler((methods: string[]) => {
      askedMethods = methods;
      return Promise.resolve(true);
    });
    const out = await api('/api/v1/commands', { method: 'POST', body: { vehicleId: 'v' } });
    expect(out).toEqual({ ok: true });
    expect(askedMethods).toEqual(['password']);
    expect(fetchMock.mock.calls.length).toBe(3);

    // Failure path: non-ok with structured error.
    fetchMock.mockResolvedValueOnce(
      jsonRes({ error: { code: 'BAD', message: 'bad thing', requestId: 'r1' } }, 400),
    );
    await expect(api('/api/v1/x')).rejects.toMatchObject({
      code: 'BAD',
      message: 'bad thing',
      status: 400,
      requestId: 'r1',
    });

    // Non-JSON error body falls back to a generic message.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
      text: async () => 'boom',
      clone: () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    await expect(api('/api/v1/x')).rejects.toMatchObject({ status: 500 });
    setStepUpHandler(null);
  });

  it('dispatches the unauthorized event for 401s outside /auth', async () => {
    const listener = vi.fn();
    window.addEventListener('voltlink:unauthorized', listener);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'SESSION' } }),
      text: async () => '{}',
      clone: () => {
        throw new Error('x');
      },
    } as unknown as Response);
    await expect(api('/api/v1/vehicles')).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('voltlink:unauthorized', listener);
  });

  it('returns raw text and CSV bodies', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes('plain-body'));
    expect(await api('/api/v1/x', { raw: true })).toBe('plain-body');

    fetchMock.mockResolvedValueOnce(jsonRes('a,b\n1,2'));
    expect(await apiCsv('/api/v1/drives/export/csv')).toBe('a,b\n1,2');

    fetchMock.mockResolvedValueOnce(jsonRes({ data: { token: 'tok-2' } }));
    expect(await fetchCsrf()).toBe('tok-2');

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => 'x',
      json: async () => {
        throw new Error('x');
      },
    } as unknown as Response);
    await expect(fetchCsrf()).rejects.toBeInstanceOf(ApiError);
  });
});

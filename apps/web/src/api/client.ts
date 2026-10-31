// VoltLink API client: fetch wrapper with CSRF, session handling, and
// structured errors. Credentials never touch localStorage — the session lives
// in an HttpOnly cookie.

let csrfToken: string | null = null;

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function fetchCsrf(): Promise<string> {
  const res = await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError('NETWORK', 'Could not reach the server.', 0);
  const body = (await res.json()) as { data: { token: string } };
  csrfToken = body.data.token;
  return csrfToken;
}

interface ApiResult<T> {
  data: T;
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; raw?: boolean } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') {
    if (!csrfToken) await fetchCsrf();
    headers['X-VL-CSRF'] = csrfToken ?? '';
  }
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/api/v1/auth/')) {
    window.dispatchEvent(new CustomEvent('voltlink:unauthorized'));
  }
  if (!res.ok) {
    let code = 'ERROR';
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(code, message, res.status);
  }
  if (opts.raw) return (await res.text()) as T;
  const body = (await res.json()) as ApiResult<T>;
  return body.data;
}

export async function apiCsv(path: string): Promise<string> {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError('ERROR', `Request failed (${res.status})`, res.status);
  return res.text();
}

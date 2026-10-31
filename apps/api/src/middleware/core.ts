// Core middleware: request IDs, CSRF, security headers, and error handling.

import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../core/env';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  // G-07: no debug flag may log cookies, session ids or token-hash matches.
  const id = req.header('x-request-id') ?? crypto.randomBytes(8).toString('hex');
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/** Double-submit CSRF: cookie + header must match for mutating requests. */
export function csrf(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    next();
    return;
  }
  let cookie = req.cookies?.[env.CSRF_COOKIE_NAME];
  const header = req.header('x-vl-csrf');
  if (typeof cookie !== 'string' || !cookie) {
    // Issue on first mutating request then require retry.
    cookie = crypto.randomBytes(16).toString('hex');
    res.cookie(env.CSRF_COOKIE_NAME, cookie, { httpOnly: false, sameSite: 'lax', secure: env.NODE_ENV === 'production', path: '/' });
    res.status(403).json({ error: { code: 'CSRF', message: 'CSRF token issued; retry the request.' } });
    return;
  }
  if (!header || header !== cookie) {
    res.status(403).json({ error: { code: 'CSRF', message: 'CSRF token mismatch.' } });
    return;
  }
  next();
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const message = err instanceof Error ? err.message : 'Unexpected error';
  const status = (err as { status?: number })?.status ?? 500;
  if (status >= 500) {
    console.error('[error]', message, err instanceof Error ? err.stack?.split('\n').slice(0, 4).join(' | ') : '');
  }
  if (res.headersSent) return;
  res.status(status).json({
    error: {
      code: (err as { code?: string })?.code ?? (status >= 500 ? 'INTERNAL' : 'BAD_REQUEST'),
      message: status >= 500 && env.NODE_ENV === 'production' ? 'An unexpected error occurred.' : message,
      ...((err as { details?: unknown })?.details !== undefined ? { details: (err as { details: unknown }).details } : {}),
      requestId: _req.id,
    },
  });
}

// Authorization and authentication errors with structured codes.

export class AuthError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class AccessDenied extends AuthError {
  constructor(code: string, message: string, status = 403, details?: unknown) {
    super(code, message, status, details);
  }
}

export class NotFoundError extends AuthError {
  constructor(message: string) {
    super('NOT_FOUND', message, 404);
  }
}

export function notFound(message: string): NotFoundError {
  return new NotFoundError(message);
}

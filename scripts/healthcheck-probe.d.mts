// Type declarations for the I-HEALTH healthcheck probe (plain JS so the image's
// node run and the vitest project share one implementation).
export const BEAT_BOUNDS: { worker: number; scheduler: number };

export function beatValueMs(value: unknown): number;

export function beatFresh(role: string, value: unknown, nowMs?: number): boolean;

export function configProblems(input: { role: string; redisUrl?: string }): string[];

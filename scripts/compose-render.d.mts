// Type declarations for the C3 compose renderer (no TS source; the model is
// plain JS so CI's node run and the vitest project share one implementation).
export interface RenderedService {
  image?: string;
  build?: string;
  environment: Record<string, string>;
  networks: string[];
  ports: string[];
  volumes: string[];
  profiles: string[];
}

export interface RenderedCompose {
  name?: string;
  services: Record<string, RenderedService>;
  networks: Record<string, unknown>;
  volumes: Record<string, unknown>;
}

export function renderCompose(
  files: string[],
  options?: { envFile?: string; env?: Record<string, string | undefined> },
): RenderedCompose;

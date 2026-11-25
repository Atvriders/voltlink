// Type declarations for scripts/install-doc-run.mjs (C5).
export interface GuideBlock {
  name: string;
  body: string;
}

export interface RunnerOptions {
  composeSrc?: string;
  entrySrc?: string;
  envExampleSrc?: string;
  ciOverlay?: string;
  imageDigest?: string;
}

export function parseGuideBlocks(md: string): GuideBlock[];
export function substitute(block: string, opts: RunnerOptions): string;
export function buildKeptEnv(
  opts: RunnerOptions,
  processEnv: Record<string, string | undefined>,
): { kept: Record<string, string | undefined>; dockerKeys: string[] };

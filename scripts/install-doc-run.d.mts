// Type declarations for scripts/install-doc-run.mjs (C5).
export interface GuideBlock {
  name: string;
  body: string;
}

export interface RunnerOptions {
  composeSrc?: string;
  envExampleSrc?: string;
  ciOverlay?: string;
}

export function parseGuideBlocks(md: string): GuideBlock[];
export function substitute(block: string, opts: RunnerOptions): string;

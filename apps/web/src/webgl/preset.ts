// Graphics preset heuristics kept free of three.js so pages can compute the
// default preset without pulling the 1.1 MB viewer chunk into their bundle.
export type GraphicsPreset = 'low' | 'medium' | 'high' | 'ultra';

export const PRESETS: Record<GraphicsPreset, { pxRatio: number; shadows: boolean; ao: boolean }> = {
  low: { pxRatio: 1, shadows: false, ao: false },
  medium: { pxRatio: 1.25, shadows: false, ao: false },
  high: { pxRatio: 1.75, shadows: true, ao: false },
  ultra: { pxRatio: 2, shadows: true, ao: true },
};

export function autoPreset(): GraphicsPreset {
  if (typeof navigator === 'undefined') return 'medium';
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 4;
  if (cores <= 4 || mem <= 2) return 'low';
  if (cores <= 8 || mem <= 4) return 'medium';
  if (cores <= 16) return 'high';
  return 'ultra';
}

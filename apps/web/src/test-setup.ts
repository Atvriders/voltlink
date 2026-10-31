// Vitest setup for the VoltLink SPA (jsdom environment).

import '@testing-library/jest-dom/vitest';

// maplibre-gl needs a few browser globals that jsdom doesn't provide.
if (typeof window !== 'undefined') {
  if (!window.URL.createObjectURL) {
    window.URL.createObjectURL = () => 'blob:mock';
    window.URL.revokeObjectURL = () => undefined;
  }
  // ResizeObserver used by some components.
  if (!('ResizeObserver' in window)) {
    (window as unknown as Record<string, unknown>).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  // requestAnimationFrame fallback.
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number;
  }
}

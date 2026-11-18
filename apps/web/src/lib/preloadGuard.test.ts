// R6: R2-37 — a failing route chunk may reload the page at most once per
// window; afterwards the route error boundary takes over.
import { beforeEach, describe, expect, it } from 'vitest';
import { installPreloadReloadGuard } from './preloadGuard';

describe('preload error guard (R2-37)', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('reloads once, then stays quiet within the window', () => {
    const store = new Map<string, string>();
    let reloads = 0;
    const guard = installPreloadReloadGuard({
      get: (k) => store.get(k) ?? null,
      set: (k, v) => void store.set(k, v),
      reload: () => {
        reloads += 1;
      },
      now: () => 1000,
    });
    guard.emit();
    guard.emit();
    guard.emit();
    expect(reloads).toBe(1);
    expect(store.get('voltlink-preload-retry')).toBe('1000');
  });

  it('never reloads again, even long after the first reload (TI-28)', () => {
    const store = new Map<string, string>();
    let reloads = 0;
    let now = 1000;
    const guard = installPreloadReloadGuard({
      get: (k) => store.get(k) ?? null,
      set: (k, v) => void store.set(k, v),
      reload: () => {
        reloads += 1;
      },
      now: () => now,
    });
    guard.emit();
    guard.emit();
    // A persistent failure hours later must land on the error card, not
    // reload again — the session marker survives reloads.
    now = 1000 + 30_001;
    guard.emit();
    now = 1000 + 3 * 60 * 60_000;
    guard.emit();
    expect(reloads).toBe(1);
    expect(store.get('voltlink-preload-retry')).toBe('1000');
  });
});

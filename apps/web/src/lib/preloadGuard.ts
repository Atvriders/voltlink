// R2-37: a chunk preload failure may reload at most once per time window so a
// persistent failure lands on the route error card instead of a reload loop.

export interface PreloadGuardDeps {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  reload: () => void;
  now: () => number;
}

const KEY = 'voltlink-preload-retry';
const WINDOW_MS = 30_000;

export function installPreloadReloadGuard(deps: PreloadGuardDeps): { emit: () => void } {
  return {
    emit: () => {
      const raw = deps.get(KEY);
      const last = raw ? Number(raw) : NaN;
      if (!Number.isFinite(last) || deps.now() - last > WINDOW_MS) {
        deps.set(KEY, String(deps.now()));
        deps.reload();
      }
    },
  };
}

export function installDefaultPreloadGuard(): void {
  const guard = installPreloadReloadGuard({
    get: (k) => sessionStorage.getItem(k),
    set: (k, v) => sessionStorage.setItem(k, v),
    reload: () => location.reload(),
    now: () => Date.now(),
  });
  window.addEventListener('vite:preloadError', () => guard.emit());
}

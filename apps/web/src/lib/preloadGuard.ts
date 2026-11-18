// R2-37: a chunk preload failure may reload at most once per time window so a
// persistent failure lands on the route error card instead of a reload loop.

export interface PreloadGuardDeps {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  reload: () => void;
  now: () => number;
}

const KEY = 'voltlink-preload-retry';

export function installPreloadReloadGuard(deps: PreloadGuardDeps): { emit: () => void } {
  return {
    emit: () => {
      // TI-28/R2-37: at most ONE reload per session (the sessionStorage
      // marker survives reloads). The old 30 s window reloaded again after
      // the window expired, so a chunk failing after 30 s looped forever and
      // the error card never showed.
      if (deps.get(KEY) === null) {
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

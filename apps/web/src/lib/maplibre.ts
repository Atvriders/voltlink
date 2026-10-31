// The only module that touches MapLibre globals (guide 07 §1.1, NEW-11):
// the worker is emitted as an asset and pointed at via setWorkerUrl, so the
// SPA fallback can never serve it as HTML.

import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';

let configured = false;

export function configureMapLibre(): void {
  if (configured) return;
  setWorkerUrl(workerUrl); // same-origin /assets/maplibre-gl-worker-<hash>.js
  configured = true;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export { hasWebGL2 } from './webgl';

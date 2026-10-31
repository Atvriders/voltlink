// Stage the built SPA into apps/api/web-dist so the API serves it from the
// image and from bare-metal builds.
import { rmSync, cpSync, mkdirSync } from 'node:fs';
mkdirSync('apps/api/web-dist', { recursive: true });
rmSync('apps/api/web-dist', { recursive: true, force: true });
cpSync('apps/web/dist', 'apps/api/web-dist', { recursive: true });
console.log('web-dist staged');

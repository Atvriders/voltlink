// check:bundle — G-06 guard: index.html must never preload a three-, map- or
// charts- chunk (the viewer, the map and the charts load only on their routes).

import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve('apps/web/dist');
const html = path.join(dist, 'index.html');
if (!fs.existsSync(html)) {
  console.error('apps/web/dist/index.html not found — build the web app first.');
  process.exit(1);
}
const text = fs.readFileSync(html, 'utf8');
const bad = [/three-[\w-]+\.js/, /map-[\w-]+\.js/, /charts-[\w-]+\.js/].filter((re) =>
  re.test(text),
);
if (bad.length > 0) {
  console.error(
    'index.html preloads route-lazy chunks:',
    bad.map((r) => r.source),
  );
  process.exit(1);
}
console.log('✓ index.html preloads no three/map/charts chunk');

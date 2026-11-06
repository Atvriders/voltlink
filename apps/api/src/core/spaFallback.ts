// G-13: the SPA fallback must never answer missing asset/3D files with
// index.html + 200. Shared by the web role (app.ts) and the status role
// (statusServer.ts) so both behave identically.

import type { Express, NextFunction, Request, Response } from 'express';
import path from 'node:path';

export function spaFallback(app: Express, spaDir: string): void {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') {
      next();
      return;
    }
    // Missing asset or 3D files are 404, never index.html with 200.
    if (req.path.startsWith('/assets/') || req.path.startsWith('/3d/')) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Asset not found.' } });
      return;
    }
    res.sendFile(path.join(spaDir, 'index.html'));
  });
}

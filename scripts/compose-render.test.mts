// compose-render.test.mts — C3: the compose renderer must model VoltLink's
// files (anchors, merges, include, multi-file overlays and every interpolation
// form), including the R2-67 and R2-70 cases. CI compares this model's output
// with `docker compose config --format json`; these tests pin the model.

import { fileURLToPath } from 'node:url';
import { unlinkSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderCompose } from './compose-render.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const production = `${repo}compose.production.yml`;
const entry = `${repo}docker-compose.yml`;
const buildOverlay = `${repo}docker-compose.build.yml`;

describe('compose-render (C3)', () => {
  it('resolves anchors and merges: every role inherits the shared app environment', () => {
    const out = renderCompose([production], {
      env: {
        VL_QUEUE_PREFIX: 'voltlink',
        POSTGRES_PASSWORD: 'pgpw',
        JWT_SECRET: 'j'.repeat(64),
        VL_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
        PUBLIC_URL: 'https://voltlink.example.com',
      },
    });
    const web = out.services.web!;
    expect(web.environment.NODE_ENV).toBe('production');
    expect(web.environment.VL_ROLE).toBe('web');
    expect(web.environment.VL_QUEUE_PREFIX).toBe('voltlink');
    expect(web.environment.VL_MASTER_KEY_VERSION).toBe('1');
    expect(web.environment.DATABASE_URL).toBe('postgresql://voltlink:pgpw@postgres:5432/voltlink');
    expect(web.environment.JWT_SECRET).toBe('j'.repeat(64));
  });

  it('supports every interpolation form', () => {
    const out = renderCompose([production], {
      env: {
        POSTGRES_PASSWORD: 'pgpw',
        JWT_SECRET: 's'.repeat(64),
        VL_MASTER_KEY: Buffer.alloc(32, 2).toString('base64'),
        PUBLIC_URL: 'https://x.example.com',
        LOG_LEVEL: '',
      },
    });
    const web = out.services.web!;
    // ${VAR:-def} with unset var -> def
    expect(web.environment.VL_RATE_LIMIT_PER_MIN).toBe('900');
    // ${VAR:-def} with set var -> value
    expect(web.environment.PUBLIC_URL).toBe('https://x.example.com');
    // ${VAR:-def} with EMPTY var -> def (compose semantics)
    expect(web.environment.LOG_LEVEL).toBe('info');
  });

  it('renders the in-file defaults with an empty environment (no .env flow)', () => {
    const out = renderCompose([production], { env: {} });
    const web = out.services.web!;
    expect(web.environment.PUBLIC_URL).toBe('http://localhost:3110');
    expect(web.environment.DATABASE_URL).toContain('0273562be8b07bd887cce80c59cc66e4');
    expect(web.environment.JWT_SECRET).toBe(
      'c4ed0b963a2d89dad3387e59110914f76b9b48dc02864964559a4eb37a277049',
    );
  });

  it('still throws for a `${VAR:?msg}` fail-fast (the model keeps the form)', () => {
    const file = `${repo}scripts/compose-render.test-fixture.yml`;
    writeFileSync(file, "services:\n  probe:\n    environment:\n      A: '${REQ:?need REQ}'\n");
    try {
      expect(() => renderCompose([file], { env: {} })).toThrow(/Required variable REQ is not set/);
    } finally {
      unlinkSync(file);
    }
  });

  it('keeps a literal $$ as $', () => {
    const file = `${repo}scripts/compose-render.test-fixture.yml`;
    writeFileSync(file, 'services:\n  probe:\n    environment:\n      A: "cost $$5"\n');
    try {
      const out = renderCompose([file], { env: {} });
      expect(out.services.probe!.environment.A).toBe('cost $5');
    } finally {
      unlinkSync(file);
    }
  });

  it('follows include: docker-compose.yml renders the same services as the canonical file', () => {
    const a = renderCompose([entry], {
      env: {
        POSTGRES_PASSWORD: 'pgpw',
        JWT_SECRET: 'j'.repeat(64),
        VL_MASTER_KEY: Buffer.alloc(32, 3).toString('base64'),
        PUBLIC_URL: 'https://voltlink.example.com',
      },
    });
    const b = renderCompose([production], {
      env: {
        POSTGRES_PASSWORD: 'pgpw',
        JWT_SECRET: 'j'.repeat(64),
        VL_MASTER_KEY: Buffer.alloc(32, 3).toString('base64'),
        PUBLIC_URL: 'https://voltlink.example.com',
      },
    });
    expect(Object.keys(a.services).sort()).toEqual(Object.keys(b.services).sort());
    expect(a.services.web!.environment).toEqual(b.services.web!.environment);
  });

  it('merges multiple -f files: the build overlay swaps in a local build', () => {
    const out = renderCompose([production, buildOverlay], {
      env: {
        POSTGRES_PASSWORD: 'pgpw',
        JWT_SECRET: 'j'.repeat(64),
        VL_MASTER_KEY: Buffer.alloc(32, 4).toString('base64'),
        PUBLIC_URL: 'https://voltlink.example.com',
      },
    });
    expect(out.services.web!.build).toBe('.');
    expect(out.services.web!.image).toBe('voltlink:local');
    expect(out.services.web!.environment.VL_ROLE).toBe('web');
    // postgres is untouched by the overlay
    expect(out.services.postgres!.image).toBe('postgres:17-alpine');
  });

  it('renders the R2-67 compose default: empty VL_MASTER_KEY_VERSION falls back to the compose default', () => {
    const envFile = `${repo}scripts/compose-render.test.env`;
    writeFileSync(envFile, 'VL_MASTER_KEY_VERSION=\nPOSTGRES_PASSWORD=pgpw\n');
    try {
      const out = renderCompose([production], {
        envFile,
        env: {
          JWT_SECRET: 'j'.repeat(64),
          VL_MASTER_KEY: Buffer.alloc(32, 5).toString('base64'),
          PUBLIC_URL: 'https://voltlink.example.com',
        },
      });
      // `${VAR:-def}` treats empty as unset (compose semantics), so an empty
      // .env value renders the '1' default — and the product treats a literal
      // empty string as unset too (R2-67), so both paths agree.
      expect(out.services.web!.environment.VL_MASTER_KEY_VERSION).toBe('1');
    } finally {
      unlinkSync(envFile);
    }
  });

  it('renders the real files with a filled .env: every role carries every ENV_SPEC key', async () => {
    const { ENV_KEYS } = await import('../apps/api/src/core/env-spec');
    const envFile = `${repo}scripts/compose-render.test2.env`;
    writeFileSync(
      envFile,
      `POSTGRES_PASSWORD=pgpw\nJWT_SECRET=${'j'.repeat(64)}\nVL_MASTER_KEY=${Buffer.alloc(32, 6).toString('base64')}\nPUBLIC_URL=https://voltlink.example.com\n`,
    );
    try {
      const out = renderCompose([production], { envFile, env: {}, profiles: ['status'] });
      for (const role of ['migrate', 'web', 'worker', 'scheduler', 'status']) {
        const env = out.services[role]!.environment;
        const missing = ENV_KEYS.filter((k) => !(k in env));
        expect(missing, `role ${role} missing`).toEqual([]);
      }
    } finally {
      unlinkSync(envFile);
    }
  });
});

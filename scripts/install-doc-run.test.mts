// install-doc-run.test.mts — C5: the guide runner must execute EVERY marked
// block of docs/DOCKER_COMPOSE.md and nothing that is not in the guide. A test
// proves the marker set, the substitutions and the environment the runner
// exports (CI overlay + digest pin — the guide itself needs no COMPOSE_FILE).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGuideBlocks, substitute, buildKeptEnv } from './install-doc-run.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));

describe('install-doc-run (C5)', () => {
  it('the guide carries exactly the expected runnable blocks', () => {
    const md = readFileSync(`${repo}docs/DOCKER_COMPOSE.md`, 'utf8');
    const blocks = parseGuideBlocks(md);
    expect(blocks.map((b) => b.name)).toEqual([
      'get-files',
      'rotate-secrets',
      'env-lan',
      'env-https',
      'env-webauthn',
      'up',
      'read-token',
      'status-profile',
      'down',
      'down-v',
    ]);
  });

  it('every marked block is fenced bash and non-empty', () => {
    const md = readFileSync(`${repo}docs/DOCKER_COMPOSE.md`, 'utf8');
    for (const b of parseGuideBlocks(md)) {
      expect(b.body.trim().length, b.name).toBeGreaterThan(0);
    }
  });

  it('the substitutions cover the get-files block (compose + entry + env example)', () => {
    const block = parseGuideBlocks(readFileSync(`${repo}docs/DOCKER_COMPOSE.md`, 'utf8')).find(
      (b) => b.name === 'get-files',
    )!;
    const out = substitute(block.body, {
      composeSrc: '/checkout/compose.production.yml',
      entrySrc: '/checkout/docker-compose.yml',
      envExampleSrc: '/checkout/.env.example',
      ciOverlay: 'docker-compose.ci.yml',
    });
    expect(out).toContain('cp /checkout/compose.production.yml compose.production.yml');
    expect(out).toContain('cp /checkout/docker-compose.yml docker-compose.yml');
    expect(out).toContain('cp /checkout/.env.example .env.example');
    expect(out).not.toContain('raw.githubusercontent.com');
  });

  it('the CI overlay and the digest pin travel through the exported env, never through a block body', () => {
    const opts = { ciOverlay: 'docker-compose.ci.yml', imageDigest: '@sha256:deadbeef' };
    const { kept } = buildKeptEnv(opts, { PATH: '/bin', HOME: '/root', DOCKER_HOST: 'x' });
    expect(kept.COMPOSE_FILE).toBe('compose.production.yml:docker-compose.ci.yml');
    expect(kept.VOLTLINK_IMAGE_DIGEST).toBe('@sha256:deadbeef');
    expect(kept.DOCKER_HOST).toBe('x');
    const md = readFileSync(`${repo}docs/DOCKER_COMPOSE.md`, 'utf8');
    for (const b of parseGuideBlocks(md)) {
      expect(b.body, b.name).not.toContain('COMPOSE_FILE');
      expect(b.body, b.name).not.toContain('docker-compose.ci.yml');
    }
  });

  it('every compose command is bare — no -f flags and no fail-fast :? interpolations', () => {
    const md = readFileSync(`${repo}docs/DOCKER_COMPOSE.md`, 'utf8');
    for (const b of parseGuideBlocks(md)) {
      expect(b.body, b.name).not.toContain('-f compose');
      expect(b.body, b.name).not.toContain('--file');
    }
    const env = parseGuideBlocks(md).find((b) => b.name === 'rotate-secrets')!;
    expect(env.body).toContain('openssl rand -base64 32');
    expect(env.body).toContain('[ ! -e .env ]');
  });

  it('the README quick-start blocks are marked and bare', () => {
    const md = readFileSync(`${repo}README.md`, 'utf8');
    const blocks = parseGuideBlocks(md);
    expect(blocks.map((b) => b.name)).toEqual(['quick-get-files', 'quick-up', 'quick-token']);
    for (const b of blocks) expect(b.body, b.name).not.toContain('-f compose');
    const up = blocks.find((b) => b.name === 'quick-up')!;
    expect(substitute(up.body, { ciOverlay: 'docker-compose.ci.yml' })).toBe(up.body);
  });

  // Item 2a: the guide's get-files block downloads the entry compose file too;
  // without --entry-src that curl fetched the nonexistent v1.1.1 tag (404) and
  // killed the image job. CI must supply every source, and the runner must
  // refuse to execute a block that would still hit raw.githubusercontent.com.
  it('CI mode substitutes every download in the guide and the README, no raw URL survives', () => {
    const opts = {
      composeSrc: '/checkout/compose.production.yml',
      entrySrc: '/checkout/docker-compose.yml',
      envExampleSrc: '/checkout/.env.example',
    };
    for (const file of ['docs/DOCKER_COMPOSE.md', 'README.md']) {
      for (const b of parseGuideBlocks(readFileSync(`${repo}${file}`, 'utf8'))) {
        const out = substitute(b.body, opts);
        expect(out, `${file}#${b.name}`).not.toContain('raw.githubusercontent.com');
        expect(out, `${file}#${b.name}`).not.toContain('curl -fsSL');
      }
    }
  });

  it('the runner fails a CI-mode block whose download source is missing', () => {
    const block = parseGuideBlocks(readFileSync(`${repo}docs/DOCKER_COMPOSE.md`, 'utf8')).find(
      (b) => b.name === 'get-files',
    )!;
    // --entry-src omitted: the docker-compose.yml curl would stay real.
    expect(() =>
      substitute(block.body, {
        composeSrc: '/checkout/compose.production.yml',
        envExampleSrc: '/checkout/.env.example',
      }),
    ).toThrow(/unsubstituted download URL.*docker-compose\.yml/);
  });
});

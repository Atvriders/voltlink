// install-doc-run.test.mts — C5: the guide runner must execute EVERY marked
// block of docs/DOCKER_COMPOSE.md and nothing that is not in the guide. A test
// proves the marker set and the substitutions.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGuideBlocks, substitute } from './install-doc-run.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));

describe('install-doc-run (C5)', () => {
  it('the guide carries exactly the expected runnable blocks', () => {
    const md = readFileSync(`${repo}docs/DOCKER_COMPOSE.md`, 'utf8');
    const blocks = parseGuideBlocks(md);
    expect(blocks.map((b) => b.name)).toEqual([
      'get-files',
      'create-env',
      'env-localhost',
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

  it('the substitutions cover the get-files block (compose + env example + CI overlay)', () => {
    const block = parseGuideBlocks(readFileSync(`${repo}docs/DOCKER_COMPOSE.md`, 'utf8')).find(
      (b) => b.name === 'get-files',
    )!;
    const out = substitute(block.body, {
      composeSrc: '/checkout/compose.production.yml',
      envExampleSrc: '/checkout/.env.example',
      ciOverlay: 'docker-compose.ci.yml',
    });
    expect(out).toContain('cp /checkout/compose.production.yml compose.production.yml');
    expect(out).toContain('cp /checkout/.env.example .env.example');
    expect(out).not.toContain('raw.githubusercontent.com');
  });

  it('the CI overlay substitution covers the start block', () => {
    const block = parseGuideBlocks(readFileSync(`${repo}docs/DOCKER_COMPOSE.md`, 'utf8')).find(
      (b) => b.name === 'up',
    )!;
    const out = substitute(block.body, { ciOverlay: 'docker-compose.ci.yml' });
    expect(out).toContain('-f compose.production.yml -f docker-compose.ci.yml up -d --wait');
  });
});

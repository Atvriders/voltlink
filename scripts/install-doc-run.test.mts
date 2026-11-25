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

  it('the CI overlay rides along in the COMPOSE_FILE line the guarded .env block writes', () => {
    const block = parseGuideBlocks(readFileSync(`${repo}docs/DOCKER_COMPOSE.md`, 'utf8')).find(
      (b) => b.name === 'create-env',
    )!;
    const out = substitute(block.body, { ciOverlay: 'docker-compose.ci.yml' });
    expect(out).toContain(
      "printf 'COMPOSE_FILE=compose.production.yml:docker-compose.ci.yml\\n' >> .env",
    );
    expect(out).not.toContain('COMPOSE_FILE=compose.production.yml\\n');
  });

  it('every compose command is bare — no -f flags — so a bare command fails without COMPOSE_FILE', () => {
    const md = readFileSync(`${repo}docs/DOCKER_COMPOSE.md`, 'utf8');
    for (const b of parseGuideBlocks(md)) {
      expect(b.body, b.name).not.toContain('-f compose');
      expect(b.body, b.name).not.toContain('--file');
    }
    const env = parseGuideBlocks(md).find((b) => b.name === 'create-env')!;
    expect(env.body).toContain('COMPOSE_FILE=compose.production.yml');
  });

  it('the README quick-start blocks are marked and bare', () => {
    const md = readFileSync(`${repo}README.md`, 'utf8');
    const blocks = parseGuideBlocks(md);
    expect(blocks.map((b) => b.name)).toEqual([
      'quick-get-files',
      'quick-env',
      'quick-up',
      'quick-token',
    ]);
    for (const b of blocks) expect(b.body, b.name).not.toContain('-f compose');
    const up = blocks.find((b) => b.name === 'quick-up')!;
    expect(substitute(up.body, { ciOverlay: 'docker-compose.ci.yml' })).toBe(up.body);
  });
});

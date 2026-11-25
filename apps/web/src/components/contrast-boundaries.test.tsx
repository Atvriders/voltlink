// R6: F-CONTRAST — interactive control boundaries (inputs, selects, secondary
// buttons) must use the 3:1 border token, and status-tone text in the light and
// colorblind-safe themes must clear 4.5:1 on panels.
import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Input, Select, Button } from './ui';
import { readFileSync } from 'node:fs';
import path from 'node:path';

afterEach(cleanup);

function hex(s: string): [number, number, number] {
  const v = s.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function lum(r: number, g: number, b: number): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a: string, b: string): number {
  const [r1, g1, b1] = hex(a);
  const [r2, g2, b2] = hex(b);
  const l1 = lum(r1, g1, b1);
  const l2 = lum(r2, g2, b2);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function themeTokens(css: string, theme: string): Record<string, string> {
  const block = css.match(new RegExp(`\\[data-theme='${theme}'\\] \\{([\\s\\S]*?)\\}`));
  const tokens: Record<string, string> = {};
  if (!block) return tokens;
  for (const m of block[1]!.matchAll(/--vl-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    tokens[m[1]!] = m[2]!;
  }
  return tokens;
}

describe('contrast boundaries (F-CONTRAST)', () => {
  it('inputs, selects and secondary buttons use the 3:1 border token', () => {
    const { container: c1 } = render(
      <div data-theme="voltlink-dark">
        <Input aria-label="i" />
        <Select aria-label="s" value="" onChange={() => undefined}>
          <option value="">x</option>
        </Select>
        <Button variant="secondary">secondary</Button>
      </div>,
    );
    const input = c1.querySelector('input')!;
    const select = c1.querySelector('select')!;
    expect(input.className).toContain('border-control');
    expect(input.className).not.toContain('border-line');
    expect(select.className).toContain('border-control');
    expect(select.className).not.toContain('border-line');
    const secondary = Array.from(c1.querySelectorAll('button')).find(
      (b) => b.textContent === 'secondary',
    )!;
    expect(secondary.className).toContain('border-control');
  });

  it('accent, faint and danger-button pairs clear 4.5:1 in all themes', () => {
    const css = readFileSync(path.resolve('apps/web/src/index.css'), 'utf8');
    for (const theme of [
      'voltlink-dark',
      'voltlink-light',
      'fleet-ops',
      'high-contrast',
      'colorblind-safe',
    ]) {
      const t = themeTokens(css, theme);
      expect(t['accent'], theme).toBeTruthy();
      expect(t['onaccent'], theme).toBeTruthy();
      expect(ratio(t['onaccent']!, t['accent']!), theme).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t['faint']!, t['panel']!), theme).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t['ondanger']!, t['danger-strong']!), theme).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t['control']!, t['panel']!), theme).toBeGreaterThanOrEqual(3);
    }
  });

  it('status-tone text clears 4.5:1 in the light and colorblind-safe themes', () => {
    const css = readFileSync(path.resolve('apps/web/src/index.css'), 'utf8');
    for (const theme of ['voltlink-light', 'colorblind-safe']) {
      const t = themeTokens(css, theme);
      for (const tone of ['ok', 'warn', 'danger', 'info']) {
        expect(ratio(t[tone]!, t['panel']!), `${theme} ${tone}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('web-9: the .text-<tone> classes bind the checked tokens (live usage)', () => {
    // The token ratios above only matter if the utility classes real pages
    // use are bound to those tokens. Tailwind v4 generates .text-ok etc.
    // from the @theme mapping, so the binding lives in the theme block:
    // --color-ok: var(--vl-ok).
    const css = readFileSync(path.resolve('apps/web/src/index.css'), 'utf8');
    const theme = css.match(/@theme[^{]*\{([\s\S]*?)\n\}/);
    expect(theme, '@theme block exists').toBeTruthy();
    for (const tone of ['ok', 'warn', 'danger', 'info']) {
      expect(theme![1], `--color-${tone} maps the tone token (generates .text-${tone})`).toMatch(
        new RegExp(`--color-${tone}:\\s*var\\(--vl-${tone}\\)`),
      );
    }
  });
});

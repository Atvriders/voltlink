// Placeholder-looking secret detection (guide 02 §2, boot refusal).
// The pattern must catch documented placeholders (change-me, example,
// xxxxxxxx) WITHOUT refusing random generated keys: a run of exactly 4
// 'x's appears in ~1 of 26,000 `openssl rand -base64 32` outputs, so the
// 'xxxx' alternative requires six consecutive x's instead (chance ~1 in
// 4.4e9 per 44-char key) and is still generous for hand-written placeholders.

const PLACEHOLDER = /(secret|change.?me|changeme|placeholder|example|your-|x{6,}|default)/i;

export function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value);
}

#!/usr/bin/env node
// Writes web/src/ds/tokens.css from design/system/tokens.json, the design system's single source of values.
//   node scripts/generate-tokens-css.mjs   (npm run tokens)
// Terminal (`dark`) is the default on :root; Paper (`light`) applies when the OS prefers light and no theme is
// forced, or when <html data-theme="light">. <html data-theme="dark"> forces Terminal.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TOKENS_JSON = join(root, 'design', 'system', 'tokens.json');
export const TOKENS_CSS = join(root, 'web', 'src', 'ds', 'tokens.css');

/** `{signal}` → `var(--signal)`; anything else verbatim. */
function cssValue(value) {
  const ref = /^\{([a-z0-9-]+)\}$/.exec(value);
  return ref ? `var(--${ref[1]})` : value;
}

/** The CSS text for a parsed tokens.json. */
export function tokensCss(tokens) {
  const themed = [...tokens.color.tokens, ...tokens.shadow.tokens];
  const shared = [];
  const dark = [];
  const light = [];
  for (const token of themed) {
    if (typeof token.value === 'string') shared.push(`  --${token.name}: ${cssValue(token.value)};`);
    else {
      dark.push(`  --${token.name}: ${cssValue(token.value.dark)};`);
      light.push(`  --${token.name}: ${cssValue(token.value.light)};`);
    }
  }
  shared.push(`  --font-sans: ${tokens.type.families.sans};`, `  --font-mono: ${tokens.type.families.mono};`);
  for (const group of tokens.type.groups) {
    for (const style of group.styles) {
      shared.push(`  --type-${style.name}: ${style.fontWeight} ${style.fontSize}/${style.lineHeight} var(--font-${group.family});`);
      shared.push(`  --tracking-${style.name}: ${style.letterSpacing ?? '0'};`);
    }
  }
  for (const token of [...tokens.spacing.tokens, ...tokens.radius.tokens]) shared.push(`  --${token.name}: ${token.value};`);

  return [
    '/* Generated from design/system/tokens.json by scripts/generate-tokens-css.mjs (npm run tokens). Do not edit. */',
    '',
    ':root {',
    '  color-scheme: dark;',
    ...dark,
    ...shared,
    '}',
    '',
    '@media (prefers-color-scheme: light) {',
    "  :root:not([data-theme='dark']) {",
    '    color-scheme: light;',
    ...light.map((line) => `  ${line}`),
    '  }',
    '}',
    '',
    ":root[data-theme='light'] {",
    '  color-scheme: light;',
    ...light,
    '}',
    '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(TOKENS_CSS, tokensCss(JSON.parse(readFileSync(TOKENS_JSON, 'utf8'))));
  console.log(`wrote ${TOKENS_CSS}`);
}

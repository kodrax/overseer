import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..');

interface Token {
  name: string;
  value: string | { dark: string; light: string };
}

const tokens = JSON.parse(readFileSync(join(REPO, 'design/system/tokens.json'), 'utf8')) as {
  color: { tokens: Token[] };
  shadow: { tokens: Token[] };
  spacing: { tokens: Token[] };
  radius: { tokens: Token[] };
};
const css = readFileSync(join(REPO, 'web/src/ds/tokens.css'), 'utf8');

/** Custom properties declared in the rule whose selector is exactly `selector`. */
function declarations(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + selector.length + 2, css.indexOf('}', start));
  return new Map([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const expected = (value: string) => value.replace(/^\{([a-z0-9-]+)\}$/, 'var(--$1)');

describe('web/src/ds/tokens.css (npm run tokens)', () => {
  const terminal = declarations(':root');
  const paperForced = declarations(":root[data-theme='light']");
  const paperPreferred = declarations(":root:not([data-theme='dark'])");

  it('declares every themed token with its Terminal value by default and its Paper value for both light selectors', () => {
    for (const token of [...tokens.color.tokens, ...tokens.shadow.tokens]) {
      if (typeof token.value === 'string') {
        expect(terminal.get(token.name), token.name).toBe(expected(token.value));
        continue;
      }
      expect(terminal.get(token.name), token.name).toBe(token.value.dark);
      expect(paperForced.get(token.name), token.name).toBe(token.value.light);
      expect(paperPreferred.get(token.name), token.name).toBe(token.value.light);
    }
  });

  it('declares the spacing and radius scales as stored', () => {
    for (const token of [...tokens.spacing.tokens, ...tokens.radius.tokens]) expect(terminal.get(token.name), token.name).toBe(token.value);
  });
});

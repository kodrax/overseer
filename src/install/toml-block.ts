import { parse, stringify } from 'smol-toml';
import { OverseerError } from '../core/errors.js';

export const TOML_BLOCK_START = '# >>> overseer (managed by overseer-cli) >>>';
export const TOML_BLOCK_END = '# <<< overseer <<<';

const BLOCK_RE = new RegExp(
  `(?:\\r?\\n)?${[TOML_BLOCK_START, '\\r?\\n[\\s\\S]*?', TOML_BLOCK_END]
    .map((part, i) => (i === 1 ? part : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')}[^\\n]*(?:\\n|$)`,
);

function parseToml(text: string, file: string): Record<string, unknown> {
  try {
    return parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new OverseerError('CONFIG_PARSE', `${file}: ${(error as Error).message.split('\n')[0]}`);
  }
}

/** Codex `[mcp_servers.overseer]` table body for the managed block. */
export function renderMcpBlock(command: string, args: string[]): string {
  const table = stringify({
    mcp_servers: { overseer: { command, args, startup_timeout_sec: 30, tool_timeout_sec: 120 } },
  }).trim();
  return `${TOML_BLOCK_START}\n${table}\n${TOML_BLOCK_END}\n`;
}

/** Text with the managed block (and the blank separator line before it) removed. */
function stripTomlBlock(text: string): string {
  return text.replace(BLOCK_RE, (match, offset: number) => {
    const before = text.slice(0, offset);
    // Keep the newline that terminated the previous line; drop only our separator.
    return before === '' || before.endsWith('\n') ? '' : match.slice(0, match.indexOf('#'));
  });
}

export type TomlUpsert = { ok: true; text: string } | { ok: false; reason: 'conflict' };

/**
 * Appends or replaces the managed block. Existing `mcp_servers.overseer` outside the block → conflict.
 * The result is parsed with smol-toml before returning; any parse failure throws CONFIG_PARSE.
 */
export function upsertTomlBlock(text: string | undefined, block: string, file: string): TomlUpsert {
  const current = text ?? '';
  const outside = stripTomlBlock(current);
  const parsed = parseToml(outside, file);
  const servers = parsed.mcp_servers as Record<string, unknown> | undefined;
  if (servers && typeof servers === 'object' && 'overseer' in servers) return { ok: false, reason: 'conflict' };
  let out: string;
  if (BLOCK_RE.test(current)) {
    out = current.replace(BLOCK_RE, (match) => match.slice(0, match.indexOf('#')) + block);
  } else if (outside.trim() === '') {
    out = block;
  } else {
    out = `${outside.endsWith('\n') ? outside : `${outside}\n`}\n${block}`;
  }
  parseToml(out, file);
  return { ok: true, text: out };
}

/** Removes the managed block; validates the remaining text. */
export function removeTomlBlock(text: string, file: string): { text: string; changed: boolean } {
  if (!BLOCK_RE.test(text)) return { text, changed: false };
  const out = stripTomlBlock(text);
  parseToml(out, file);
  return { text: out, changed: true };
}

/** Every `mcp_servers.<name>` table from a config.toml, by name. Throws CONFIG_PARSE on malformed text. */
export function readTomlServers(text: string, file: string): Record<string, Record<string, unknown>> {
  const servers = parseToml(text, file).mcp_servers;
  if (!servers || typeof servers !== 'object') return {};
  return Object.fromEntries(
    Object.entries(servers as Record<string, unknown>).filter((entry): entry is [string, Record<string, unknown>] => !!entry[1] && typeof entry[1] === 'object'),
  );
}

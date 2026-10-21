import { runCommand } from './exec.js';
import type { InstallContext } from './types.js';
import { SERVER_NAME } from './types.js';

export const CLAUDE_REMOVE_ARGS = ['mcp', 'remove', '--scope', 'user', SERVER_NAME];
export const CLAUDE_LIST_ARGS = ['mcp', 'list'];

export function claudeAddArgs(ctx: InstallContext): string[] {
  return ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', SERVER_NAME, '--', ctx.nodePath, ctx.cliPath, 'mcp'];
}

export interface ClaudeServerInfo {
  exists: boolean;
  scope?: string;
  type?: string;
  command?: string;
  /** Space-joined, as printed by `claude mcp get` (`  Args: a b c`). */
  args?: string;
  /** HTTP and SSE servers. */
  url?: string;
}

/**
 * Parses `claude mcp get <name>` (default `overseer`). Exit 0 prints, for stdio servers:
 * `overseer:` / `  Scope: User config (…)` / `  Status: …` / `  Type: stdio` / `  Command: <cmd>` / `  Args: <a b c>`;
 * HTTP and SSE servers print `  URL: <url>` instead of Command and Args.
 * A missing server exits 1 with `No MCP server named "overseer"…`.
 */
export function claudeMcpGet(ctx: InstallContext, claudeBin: string, name: string = SERVER_NAME): ClaudeServerInfo {
  const result = runCommand(ctx, claudeBin, ['mcp', 'get', name], 60_000);
  if (!result.ok) return { exists: false };
  const field = (key: string) => new RegExp(`^\\s*${key}:[ \\t]*(.*)$`, 'm').exec(result.stdout)?.[1]?.trim();
  return { exists: true, scope: field('Scope'), type: field('Type'), command: field('Command'), args: field('Args'), url: field('URL') };
}

/**
 * Parses `claude mcp list`: one `<name>: <url or command and args>[ (HTTP|SSE)] - <status>` line per server, after a
 * `Checking MCP server health…` header. Returns undefined when the command fails.
 */
export function claudeMcpList(ctx: InstallContext, claudeBin: string): { name: string; target: string }[] | undefined {
  const result = runCommand(ctx, claudeBin, CLAUDE_LIST_ARGS, 60_000);
  if (!result.ok) return undefined;
  const servers: { name: string; target: string }[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^([^\s:][^:]*): (.+)$/.exec(line.trim());
    if (!match) continue;
    const status = match[2]!.lastIndexOf(' - ');
    const target = (status === -1 ? match[2]! : match[2]!.slice(0, status)).replace(/ \((?:HTTP|SSE)\)$/, '').trim();
    servers.push({ name: match[1]!, target });
  }
  return servers;
}

/** True when the registered server is the user-scope stdio entry this context would add. */
export function claudeRegistrationMatches(info: ClaudeServerInfo, ctx: InstallContext): boolean {
  return (
    info.exists &&
    /^user\b/i.test(info.scope ?? '') &&
    info.type === 'stdio' &&
    info.command === ctx.nodePath &&
    info.args === `${ctx.cliPath} mcp`
  );
}

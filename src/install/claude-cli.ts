import { runCommand } from './exec.js';
import type { InstallContext } from './types.js';
import { SERVER_NAME } from './types.js';

export const CLAUDE_REMOVE_ARGS = ['mcp', 'remove', '--scope', 'user', SERVER_NAME];
export const CLAUDE_GET_ARGS = ['mcp', 'get', SERVER_NAME];

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
}

/**
 * Parses `claude mcp get overseer`. Exit 0 prints, for stdio servers:
 * `overseer:` / `  Scope: User config (…)` / `  Status: …` / `  Type: stdio` / `  Command: <cmd>` / `  Args: <a b c>`.
 * A missing server exits 1 with `No MCP server named "overseer"…`.
 */
export function claudeMcpGet(ctx: InstallContext, claudeBin: string): ClaudeServerInfo {
  const result = runCommand(ctx, claudeBin, CLAUDE_GET_ARGS, 60_000);
  if (!result.ok) return { exists: false };
  const field = (name: string) => new RegExp(`^\\s*${name}:[ \\t]*(.*)$`, 'm').exec(result.stdout)?.[1]?.trim();
  return { exists: true, scope: field('Scope'), type: field('Type'), command: field('Command'), args: field('Args') };
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

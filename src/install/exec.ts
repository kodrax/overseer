import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { InstallContext } from './types.js';

/**
 * Absolute path of `name` found on `ctx.env.PATH` (no shelling out), or undefined. On Windows only PATHEXT names
 * match: npm puts an extensionless sh shim for Git Bash next to `<name>.cmd`, and Windows cannot run it.
 */
export function findExecutable(ctx: InstallContext, name: string): string | undefined {
  const exts = process.platform === 'win32' ? (ctx.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (ctx.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** cmd.exe metacharacters, escaped with `^` (the set cross-spawn uses). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * The cmd.exe invocation that runs a Windows batch file (`.cmd`/`.bat`, how npm installs CLIs such as `claude`) with
 * `args` passed literally. Node refuses to spawn batch files without a shell (CVE-2024-27980), and `shell: true` joins
 * the arguments unquoted, which breaks paths with spaces. The batch path is quoted (Windows paths cannot contain `"`);
 * each argument is quoted for the program's command-line parser as cross-spawn does, then every cmd metacharacter (its
 * quotes too) is `^`-escaped so cmd never enters quote mode inside it. The line runs under `/d /s /c "…"`, verbatim.
 */
export function batchInvocation(file: string, args: string[], comspec = 'cmd.exe'): { file: string; args: string[] } {
  const quote = (arg: string) => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(CMD_META, '^$1');
  const line = [`"${file}"`, ...args.map(quote)].join(' ');
  return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`] };
}

/** Runs an external command with the context environment (so PATH shims in tests apply). Never throws. */
export function runCommand(ctx: InstallContext, file: string, args: string[], timeoutMs = 30_000): CommandResult {
  const batch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file);
  const invocation = batch ? batchInvocation(file, args, ctx.env.COMSPEC ?? ctx.env.ComSpec) : { file, args };
  const result = spawnSync(invocation.file, invocation.args, {
    env: ctx.env as NodeJS.ProcessEnv,
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsVerbatimArguments: batch,
  });
  const stdout = result.stdout ?? '';
  if (!result.error && result.status === 0) return { ok: true, stdout, stderr: '' };
  const reason = result.error?.message ?? (result.signal ? `killed by ${result.signal}` : `exit code ${result.status}`);
  return { ok: false, stdout, stderr: result.stderr || reason };
}

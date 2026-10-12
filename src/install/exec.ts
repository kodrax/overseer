import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { InstallContext } from './types.js';

/** Absolute path of `name` found on `ctx.env.PATH` (no shelling out), or undefined. */
export function findExecutable(ctx: InstallContext, name: string): string | undefined {
  const exts = process.platform === 'win32' ? ['', ...(ctx.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
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

/** Runs an external command with the context environment (so PATH shims in tests apply). Never throws. */
export function runCommand(ctx: InstallContext, file: string, args: string[], timeoutMs = 30_000): CommandResult {
  try {
    const stdout = execFileSync(file, args, {
      env: ctx.env as NodeJS.ProcessEnv,
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer; message: string };
    return { ok: false, stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr ?? failure.message) };
  }
}

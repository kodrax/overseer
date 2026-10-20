import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Real (symlink-free) temp dir removed after the current test. */
export function tempDir(prefix = 'ovs-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

/**
 * Throwaway user config dir for `OVERSEER_CONFIG_DIR`. Projects are off by default, so the default config turns
 * overseer on for every temp dir; pass `{}` for the real default.
 */
export function tempUserConfig(config: object = { enabled_projects: [realpathSync(tmpdir())] }): string {
  const dir = tempDir('ovs-config-');
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Temp git repo with one commit (worktrees need a HEAD). */
export function tempRepo(prefix = 'ovs-repo-'): string {
  const dir = tempDir(prefix);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

/**
 * Keeps the host's git config (global and system files, GIT_CONFIG_* variables) out of git commands, so remote URLs
 * are not rewritten by its `url.<base>.insteadOf` rules. Undo with `vi.unstubAllEnvs()`.
 */
export function isolateGitConfig(): void {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_COUNT', '0');
}

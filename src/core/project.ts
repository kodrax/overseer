import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { OverseerError } from './errors.js';

export const DATA_DIR = '.overseer';
export const DB_FILE = 'overseer.db';
const DATA_GITIGNORE = '*\n';

export interface StartDirOptions {
  /** CLI `--project` or MCP tool arg `project_dir`. */
  explicit?: string;
  env?: Record<string, string | undefined>;
  /** MCP only: first `file://` root advertised by the client. */
  mcpRoot?: string;
  cwd?: string;
}

/** Start directory precedence (S1): explicit → OVERSEER_PROJECT → CLAUDE_PROJECT_DIR → MCP root → cwd. */
export function pickStartDir(options: StartDirOptions = {}): string {
  const env = options.env ?? process.env;
  const start =
    options.explicit || env.OVERSEER_PROJECT || env.CLAUDE_PROJECT_DIR || options.mcpRoot || options.cwd || process.cwd();
  const absolute = resolve(start);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new OverseerError('INVALID_INPUT', `Project directory does not exist: ${absolute}`);
  }
  return absolute;
}

/** Trimmed stdout of `git -C <cwd> <args>`; undefined when git fails or prints nothing. */
export function git(cwd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Project root for a start directory: the main checkout of a git repo (linked worktrees map to it),
 * the toplevel for submodules, else the nearest ancestor holding `.overseer/`, else `start` itself.
 */
export function resolveProjectRoot(start: string): string {
  const absolute = resolve(start);
  const commonDir = git(absolute, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (commonDir) {
    if (basename(commonDir) === '.git') return resolve(dirname(commonDir));
    const top = git(absolute, ['rev-parse', '--show-toplevel']);
    if (top) return resolve(top);
  }
  for (let dir = absolute; ; dir = dirname(dir)) {
    if (existsSync(join(dir, DATA_DIR))) return dir;
    if (dirname(dir) === dir) return absolute;
  }
}

/** True when `path` is `dir` itself or lies below it. */
export function isWithin(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** True when `root` is the filesystem root, the home directory or one of its ancestors. */
export function isGuardedRoot(root: string): boolean {
  const target = resolve(root);
  if (target === parse(target).root) return true;
  const homes = new Set([resolve(homedir())]);
  try {
    homes.add(realpathSync(homedir()));
  } catch {
    // home may not exist (sandboxes); the lexical path is enough.
  }
  for (const home of homes) {
    if (isWithin(target, home)) return true;
  }
  return false;
}

export function assertWritableRoot(root: string): void {
  if (isGuardedRoot(root)) {
    throw new OverseerError(
      'NO_PROJECT',
      `No project detected (resolved to ${root}). Run inside a project folder, or pass project_dir / --project.`,
    );
  }
}

export function dataDir(root: string): string {
  return join(root, DATA_DIR);
}

/** Creates `<root>/.overseer/` with its self-ignoring `.gitignore`; the project's own files are never touched. */
export function ensureDataDir(root: string): string {
  assertWritableRoot(root);
  const dir = dataDir(root);
  mkdirSync(dir, { recursive: true });
  const ignoreFile = join(dir, '.gitignore');
  if (!existsSync(ignoreFile) || readFileSync(ignoreFile, 'utf8') !== DATA_GITIGNORE) {
    writeFileSync(ignoreFile, DATA_GITIGNORE);
  }
  return dir;
}

/** `git config user.name` in the project, else the OS user name. */
export function defaultAskedBy(root: string): string {
  const name = git(root, ['config', 'user.name']);
  if (name) return name;
  try {
    return userInfo().username;
  } catch {
    // os.userInfo throws when the uid has no passwd entry (containers).
    return process.env.USER || process.env.USERNAME || 'unknown';
  }
}

/** Default branch of the `origin` remote (`refs/remotes/origin/HEAD`), else `main`. */
export function defaultBaseBranch(root: string): string {
  const prefix = 'refs/remotes/origin/';
  const ref = git(root, ['symbolic-ref', '--quiet', `${prefix}HEAD`]);
  return ref?.startsWith(prefix) ? ref.slice(prefix.length) : 'main';
}

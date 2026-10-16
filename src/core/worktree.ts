import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { errorMessage, OverseerError } from './errors.js';
import { PR_TYPES, type PrType } from './pr-draft.js';
import { git } from './project.js';
import type { OverseerService } from './service.js';

/** `worktree_setup` value that turns the setup off. */
export const SETUP_NONE = 'none';

/** Lockfile → setup command, in detection order. */
export const SETUP_BY_LOCKFILE = [
  ['package-lock.json', 'npm ci'],
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --immutable'],
] as const;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_WORDS = 4;
const FILLER_WORDS: Record<string, true> = { a: true, an: true, the: true, and: true, or: true, of: true, to: true, for: true, in: true, on: true, with: true };
const FETCH_TIMEOUT_MS = 5 * 60_000;
const WORKTREE_TIMEOUT_MS = 2 * 60_000;

export interface WorktreeStartOptions {
  /** Conventional Commit type; default fix for bugs, feat for tasks. */
  type?: string;
  /** Default: derived from the item title. */
  slug?: string;
  /** Default: the base_branch setting. */
  base?: string;
  /** false skips the setup command of a new worktree. Default true. */
  setup?: boolean;
  /** Receives the setup command's stdout and stderr. */
  output?: (chunk: string) => void;
}

export interface WorktreeStartResult {
  path: string;
  branch: string;
  base: string;
  reused: boolean;
  /** `command`: the setup that applies to the worktree (null: none); `ran`: whether this call ran it. */
  setup: { command: string | null; ran: boolean };
}

/**
 * Title → branch slug: accents stripped, lowercase, `[a-z0-9]` words without filler words, the first four joined by
 * hyphens. Same title → same slug; empty when no word is left.
 */
export function slugFromTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '' && !Object.hasOwn(FILLER_WORDS, word))
    .slice(0, SLUG_WORDS)
    .join('-');
}

/** Setup command for the lockfile in `dir`, else null. */
export function detectSetupCommand(dir: string): string | null {
  for (const [lockfile, command] of SETUP_BY_LOCKFILE) if (existsSync(join(dir, lockfile))) return command;
  return null;
}

/** Fills `{type}`, `{id}` and `{slug}` in a branch pattern. */
export function branchName(pattern: string, values: { type: string; id: string; slug: string }): string {
  return pattern.replaceAll('{type}', values.type).replaceAll('{id}', values.id).replaceAll('{slug}', values.slug);
}

/** Runs git and returns its trimmed stdout; GIT_FAILED with git's stderr when it fails. */
function gitOrThrow(cwd: string, args: string[], timeout: number): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 0) return result.stdout.trim();
  const reason = result.error ? result.error.message : result.stderr.trim() || `exit code ${result.status}`;
  throw new OverseerError('GIT_FAILED', `git ${args.join(' ')} failed: ${reason}`);
}

/** Worktree path checked out on `refs/heads/<branch>`, from `git worktree list --porcelain`. */
function worktreeOfBranch(root: string, branch: string): string | undefined {
  const list = gitOrThrow(root, ['worktree', 'list', '--porcelain'], WORKTREE_TIMEOUT_MS);
  for (const block of list.split(/\n\n+/)) {
    const lines = block.split('\n');
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    if (path && lines.includes(`branch refs/heads/${branch}`)) return path;
  }
  return undefined;
}

function refExists(root: string, ref: string): boolean {
  return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== undefined;
}

/** Runs `command` through the shell in `cwd`, forwarding its output; resolves with the exit code (null: killed or not started). */
async function runSetup(command: string, cwd: string, output: (chunk: string) => void): Promise<number | null> {
  const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8').on('data', output);
  child.stderr.setEncoding('utf8').on('data', output);
  try {
    const [code] = (await once(child, 'close')) as [number | null];
    return code;
  } catch (error) {
    output(`${errorMessage(error)}\n`);
    return null;
  }
}

function resolveType(kind: 'task' | 'bug', id: string, requested: string | undefined): PrType {
  const type = requested ?? (kind === 'bug' ? 'fix' : 'feat');
  const valid = PR_TYPES.find((candidate) => candidate === type);
  if (valid === undefined) throw new OverseerError('INVALID_INPUT', `Invalid type "${type}"; valid: ${PR_TYPES.join(', ')}.`);
  if (kind === 'bug' && valid !== 'fix') throw new OverseerError('INVALID_INPUT', `${id} is a bug; bug branches always use type fix, not ${valid}.`);
  return valid;
}

function resolveSlug(title: string, id: string, requested: string | undefined): string {
  if (requested !== undefined) {
    if (!SLUG.test(requested)) throw new OverseerError('INVALID_INPUT', `Invalid slug "${requested}": use lowercase letters and digits separated by single hyphens.`);
    return requested;
  }
  const slug = slugFromTitle(title);
  if (slug === '') throw new OverseerError('INVALID_INPUT', `No slug can be derived from the title of ${id}; pass --slug.`);
  return slug;
}

/**
 * Creates or reuses the worktree and branch of a task or bug (REQ-0252, REQ-0260). The branch fills `branch_pattern`;
 * the worktree goes to `<worktree_root>/<id>-<slug>` under the project root (the main checkout).
 * - A worktree already on the branch → returned with `reused: true`; no fetch, no setup.
 * - The branch exists without a worktree → a worktree on that branch.
 * - Otherwise a new branch from `origin/<base>` after fetching origin (when it exists), else from the local `<base>`.
 * - The path exists but is not the branch's worktree → CONFLICT; nothing is touched.
 * New worktrees run the setup command (`worktree_setup`, else detected from the lockfile); a failure keeps the
 * worktree and throws SETUP_FAILED. Item status is not changed.
 */
export async function startWorktree(service: OverseerService, id: string, options: WorktreeStartOptions = {}): Promise<WorktreeStartResult> {
  const { item } = service.getItem(id);
  if (item.kind !== 'task' && item.kind !== 'bug') {
    throw new OverseerError('INVALID_INPUT', `${item.id} is a ${item.kind}; worktrees are started for tasks and bugs only.`);
  }
  const type = resolveType(item.kind, item.id, options.type);
  const slug = resolveSlug(item.title, item.id, options.slug);
  const branch = branchName(service.configValue('branch_pattern'), { type, id: item.id, slug });
  const root = service.root;
  if (git(root, ['rev-parse', '--git-dir']) === undefined) throw new OverseerError('INVALID_INPUT', `${root} is not a git repository.`);
  if (git(root, ['check-ref-format', '--branch', branch]) === undefined) {
    throw new OverseerError('INVALID_INPUT', `"${branch}" is not a valid branch name; check branch_pattern and --slug.`);
  }
  const base = options.base ?? service.configValue('base_branch');
  const stored = service.getMeta('worktree_setup');
  const setupFor = (dir: string): string | null => {
    const command = stored ?? detectSetupCommand(dir);
    return command === SETUP_NONE ? null : command;
  };

  const existing = worktreeOfBranch(root, branch);
  if (existing !== undefined) {
    if (!existsSync(existing)) {
      throw new OverseerError('CONFLICT', `${branch} is registered to the missing worktree ${existing}; run "git worktree prune" and retry.`);
    }
    return { path: existing, branch, base, reused: true, setup: { command: setupFor(existing), ran: false } };
  }

  const path = join(resolve(root, service.configValue('worktree_root')), `${item.id}-${slug}`);
  if (existsSync(path)) {
    throw new OverseerError('CONFLICT', `${path} already exists and is not the worktree of ${branch}; move it away or pass another --slug.`);
  }

  if (refExists(root, `refs/heads/${branch}`)) {
    gitOrThrow(root, ['worktree', 'add', path, branch], WORKTREE_TIMEOUT_MS);
  } else {
    if (git(root, ['remote', 'get-url', 'origin']) !== undefined) gitOrThrow(root, ['fetch', '--quiet', 'origin'], FETCH_TIMEOUT_MS);
    const start = refExists(root, `refs/remotes/origin/${base}`) ? `origin/${base}` : refExists(root, `refs/heads/${base}`) ? base : undefined;
    if (start === undefined) throw new OverseerError('NOT_FOUND', `Base branch "${base}" exists neither as origin/${base} nor locally.`);
    gitOrThrow(root, ['worktree', 'add', '--no-track', '-b', branch, path, start], WORKTREE_TIMEOUT_MS);
  }

  const command = setupFor(path);
  if (command === null || options.setup === false) return { path, branch, base, reused: false, setup: { command, ran: false } };
  const code = await runSetup(command, path, options.output ?? (() => undefined));
  if (code !== 0) {
    throw new OverseerError('SETUP_FAILED', `Setup "${command}" failed (${code === null ? 'not run' : `exit code ${code}`}) in ${path}; the worktree is kept.`);
  }
  return { path, branch, base, reused: false, setup: { command, ran: true } };
}

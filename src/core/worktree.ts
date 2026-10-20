import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { errorMessage, OverseerError } from './errors.js';
import { PR_TYPES, type PrType } from './pr-draft.js';
import { git } from './project.js';
import { type Ctx, ID_PREFIX } from './schema.js';
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
const SHA = /^[0-9a-f]{7,40}$/i;

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

interface GitRun {
  ok: boolean;
  /** Untrimmed stdout. */
  stdout: string;
  /** git's stderr, else the spawn error or exit code. */
  reason: string;
}

function runGit(cwd: string, args: string[], timeout: number): GitRun {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  const reason = result.error ? result.error.message : result.stderr.trim() || `exit code ${result.status}`;
  return { ok: result.status === 0, stdout: result.stdout ?? '', reason };
}

/** Runs git and returns its trimmed stdout; GIT_FAILED with git's stderr when it fails. */
function gitOrThrow(cwd: string, args: string[], timeout: number): string {
  const result = runGit(cwd, args, timeout);
  if (result.ok) return result.stdout.trim();
  throw new OverseerError('GIT_FAILED', `git ${args.join(' ')} failed: ${result.reason}`);
}

interface WorktreeEntry {
  path: string;
  /** Short branch name; null for a detached HEAD. */
  branch: string | null;
  /** The main checkout, which git never removes. */
  main: boolean;
}

/** Worktrees of the repository at `root`, main checkout first, from `git worktree list --porcelain`. */
function listGitWorktrees(root: string): WorktreeEntry[] {
  const list = gitOrThrow(root, ['worktree', 'list', '--porcelain'], WORKTREE_TIMEOUT_MS);
  return list.split(/\n\n+/).flatMap((block, index) => {
    const lines = block.split('\n');
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    const ref = lines.find((line) => line.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length);
    return path ? [{ path, branch: ref ?? null, main: index === 0 }] : [];
  });
}

function refExists(root: string, ref: string): boolean {
  return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Branch names `pattern` can produce for the item IDs matched by the regex source `id`: `{type}` is a Conventional
 * Commit type and `{slug}` a slug. Group 1 captures the ID.
 */
function branchMatcher(pattern: string, id: string): RegExp {
  const source = pattern
    .split(/(\{type\}|\{id\}|\{slug\})/)
    .map((part) => {
      if (part === '{type}') return `(?:${PR_TYPES.join('|')})`;
      if (part === '{slug}') return '[a-z0-9]+(?:-[a-z0-9]+)*';
      if (part === '{id}') return `(${id})`;
      return escapeRegExp(part);
    })
    .join('');
  return new RegExp(`^${source}$`);
}

/** Short names of the refs under `prefix` (e.g. `refs/heads/`) that `matcher` accepts. */
function matchingRefs(root: string, prefix: string, matcher: RegExp): string[] {
  const refs = gitOrThrow(root, ['for-each-ref', '--format=%(refname)', prefix], WORKTREE_TIMEOUT_MS);
  return refs
    .split('\n')
    .map((ref) => ref.slice(prefix.length))
    .filter((name) => matcher.test(name));
}

/** Remote of the branch's upstream, else `origin` when that remote exists, else null. */
function remoteFor(root: string, branch: string | null): string | null {
  const upstream = branch === null ? undefined : git(root, ['for-each-ref', '--format=%(upstream:remotename)', `refs/heads/${branch}`]);
  if (upstream) return upstream;
  return git(root, ['remote', 'get-url', 'origin']) !== undefined ? 'origin' : null;
}

function assertGitRepo(root: string): void {
  if (git(root, ['rev-parse', '--git-dir']) === undefined) throw new OverseerError('INVALID_INPUT', `${root} is not a git repository.`);
}

function assertWorkItem(item: { id: string; kind: string }, action: string): asserts item is { id: string; kind: 'task' | 'bug' } {
  if (item.kind !== 'task' && item.kind !== 'bug') {
    throw new OverseerError('INVALID_INPUT', `${item.id} is a ${item.kind}; worktrees are ${action} for tasks and bugs only.`);
  }
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
 * Throws CONFLICT when `id` depends_on tasks or bugs that are neither done nor cancelled, naming each with its status
 * and its local or origin branch (any branch that fills `branch_pattern` with its ID). Other targets are ignored.
 */
function assertNoOpenDependencies(service: OverseerService, id: string, outgoing: { rel: string; id: string; kind: string; status: string }[]): void {
  const open = outgoing.filter(
    (link) => link.rel === 'depends_on' && (link.kind === 'task' || link.kind === 'bug') && link.status !== 'done' && link.status !== 'cancelled',
  );
  if (open.length === 0) return;
  const root = service.root;
  const pattern = service.configValue('branch_pattern');
  const hasOrigin = git(root, ['remote', 'get-url', 'origin']) !== undefined;
  const lines = open.map((dep) => {
    const matcher = branchMatcher(pattern, escapeRegExp(dep.id));
    const local = matchingRefs(root, 'refs/heads/', matcher);
    const remote = hasOrigin ? matchingRefs(root, 'refs/remotes/origin/', matcher) : [];
    const branches = [...new Set([...local, ...remote])];
    return `- ${dep.id} (${dep.status}): ${branches.length > 0 ? `branch ${branches.join(', ')}` : 'no branch yet'}`;
  });
  throw new OverseerError(
    'CONFLICT',
    `${id} depends on unfinished work:\n${lines.join('\n')}\nWait until it is done, or stack on it with --base <its branch> (--base <base branch> to start anyway).`,
  );
}

/**
 * Creates or reuses the worktree and branch of a task or bug (REQ-0252, REQ-0260). The branch fills `branch_pattern`;
 * the worktree goes to `<worktree_root>/<id>-<slug>` under the project root (the main checkout).
 * - A worktree already on the branch → returned with `reused: true`; no fetch, no setup.
 * - Without `base`, depends_on tasks or bugs that are not done or cancelled → CONFLICT listing them; nothing is touched.
 * - The branch exists without a worktree → a worktree on that branch.
 * - Otherwise a new branch from `origin/<base>` after fetching origin (when it exists), else from the local `<base>`.
 * - The path exists but is not the branch's worktree → CONFLICT; nothing is touched.
 * New worktrees run the setup command (`worktree_setup`, else detected from the lockfile); a failure keeps the
 * worktree and throws SETUP_FAILED. Item status is not changed.
 */
export async function startWorktree(service: OverseerService, id: string, options: WorktreeStartOptions = {}): Promise<WorktreeStartResult> {
  const { item, links } = service.getItem(id);
  assertWorkItem(item, 'started');
  const type = resolveType(item.kind, item.id, options.type);
  const slug = resolveSlug(item.title, item.id, options.slug);
  const branch = branchName(service.configValue('branch_pattern'), { type, id: item.id, slug });
  const root = service.root;
  assertGitRepo(root);
  if (git(root, ['check-ref-format', '--branch', branch]) === undefined) {
    throw new OverseerError('INVALID_INPUT', `"${branch}" is not a valid branch name; check branch_pattern and --slug.`);
  }
  const base = options.base ?? service.configValue('base_branch');
  const stored = service.getMeta('worktree_setup');
  const setupFor = (dir: string): string | null => {
    const command = stored ?? detectSetupCommand(dir);
    return command === SETUP_NONE ? null : command;
  };

  const existing = listGitWorktrees(root).find((entry) => entry.branch === branch)?.path;
  if (existing !== undefined) {
    if (!existsSync(existing)) {
      throw new OverseerError('CONFLICT', `${branch} is registered to the missing worktree ${existing}; run "git worktree prune" and retry.`);
    }
    return { path: existing, branch, base, reused: true, setup: { command: setupFor(existing), ran: false } };
  }

  if (options.base === undefined) assertNoOpenDependencies(service, item.id, links.outgoing);

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

export interface WorktreeListEntry {
  id: string;
  branch: string;
  path: string;
}

/** Worktrees on a branch that fills `branch_pattern` with a task or bug ID, in `git worktree list` order; the main checkout is left out. */
export function listWorktrees(service: OverseerService): WorktreeListEntry[] {
  const root = service.root;
  assertGitRepo(root);
  const matcher = branchMatcher(service.configValue('branch_pattern'), `(?:${ID_PREFIX.task}|${ID_PREFIX.bug})-\\d{4,}`);
  return listGitWorktrees(root).flatMap((entry) => {
    if (entry.main || entry.branch === null) return [];
    const id = matcher.exec(entry.branch)?.[1];
    return id === undefined ? [] : [{ id, branch: entry.branch, path: entry.path }];
  });
}

export interface WorktreeFinishOptions {
  /** Head commit of the merged pull request, 7 to 40 hex digits. */
  mergedHead: string;
  /** Pull request URL for delivered_in. Default: the item's delivered_in. */
  pr?: string;
  /** Default: the base_branch setting. */
  base?: string;
}

export interface WorktreeBaseUpdate {
  branch: string;
  /** Local base branch after the update; null when there is none. */
  head: string | null;
  fast_forwarded: boolean;
  /** Why the base was not fast-forwarded; null when it was, or was already up to date. */
  reason: string | null;
}

export interface WorktreeFinishResult {
  id: string;
  status: string;
  /** Deleted local branch; null when there was none. */
  branch: string | null;
  /** Removed worktree; null when the branch had none. */
  path: string | null;
  /** Deleted remote branch as `<remote>/<branch>`; null when it was already gone. */
  remote_branch: string | null;
  base: WorktreeBaseUpdate;
  delivered_in: string;
  code_refs: string[];
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/**
 * Files the merged branch changed: `git diff --name-only <baseRef>...<head>`. When `baseRef` already contains `head`
 * (merged with a merge commit), the diff starts from the first parent of the commit that merged it.
 */
function changedFiles(root: string, baseRef: string, head: string): string[] {
  let from = baseRef;
  if (runGit(root, ['merge-base', '--is-ancestor', head, baseRef], WORKTREE_TIMEOUT_MS).ok) {
    const merge = gitOrThrow(root, ['rev-list', '--first-parent', '--ancestry-path', '--reverse', `${head}..${baseRef}`], WORKTREE_TIMEOUT_MS).split('\n')[0];
    if (!merge) return [];
    from = `${merge}^1`;
  }
  const files = gitOrThrow(root, ['diff', '--name-only', `${from}...${head}`], WORKTREE_TIMEOUT_MS);
  return files === '' ? [] : files.split('\n');
}

/** Deletes `branch` on `remote`; a branch someone else deleted meanwhile only loses its stale tracking ref. */
function deleteRemoteBranch(root: string, remote: string, branch: string): void {
  const pushed = runGit(root, ['push', '--quiet', remote, '--delete', branch], FETCH_TIMEOUT_MS);
  if (pushed.ok) return;
  const listed = runGit(root, ['ls-remote', '--heads', remote, `refs/heads/${branch}`], FETCH_TIMEOUT_MS);
  if (!listed.ok || listed.stdout.trim() !== '') {
    throw new OverseerError('GIT_FAILED', `git push ${remote} --delete ${branch} failed: ${pushed.reason}; nothing was removed.`);
  }
  gitOrThrow(root, ['update-ref', '-d', `refs/remotes/${remote}/${branch}`], WORKTREE_TIMEOUT_MS);
}

/** Fast-forwards the local `base` to `<remote>/<base>`: with `git merge --ff-only` where it is checked out, else by moving the ref. */
function fastForwardBase(root: string, base: string, remote: string | null): WorktreeBaseUpdate {
  const local = `refs/heads/${base}`;
  const update = (head: string | null, fast_forwarded: boolean, reason: string | null): WorktreeBaseUpdate => ({ branch: base, head, fast_forwarded, reason });
  const before = git(root, ['rev-parse', '--verify', '--quiet', local]);
  if (before === undefined) return update(null, false, `there is no local branch ${base}`);
  const target = remote === null ? undefined : git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${base}^{commit}`]);
  if (target === undefined) return update(before, false, remote === null ? 'the repository has no remote' : `${remote}/${base} does not exist`);
  if (target === before) return update(before, false, null);
  if (!runGit(root, ['merge-base', '--is-ancestor', before, target], WORKTREE_TIMEOUT_MS).ok) {
    return update(before, false, `${base} has commits that are not on ${remote}/${base}`);
  }
  const checkout = listGitWorktrees(root).find((entry) => entry.branch === base);
  if (checkout === undefined) {
    gitOrThrow(root, ['update-ref', local, target, before], WORKTREE_TIMEOUT_MS);
  } else {
    const merged = runGit(checkout.path, ['merge', '--ff-only', '--quiet', target], WORKTREE_TIMEOUT_MS);
    if (!merged.ok) return update(before, false, `git merge --ff-only in ${checkout.path} failed: ${merged.reason}`);
  }
  return update(target, true, null);
}

/**
 * Cleans up a task or bug whose pull request was merged with head `mergedHead` (REQ-0252, REQ-0257). The branch is the
 * local or remote-tracking branch that fills `branch_pattern` with the item ID; its remote is the branch's upstream,
 * else origin, which is fetched with --prune first.
 * - Refuses with CONFLICT, removing nothing, when the worktree has uncommitted or untracked changes, or the local or
 *   remote branch has commits that `mergedHead` lacks. The error lists them.
 * - Otherwise deletes the remote branch when it is still there, removes the worktree (ignored files go with it),
 *   deletes the local branch, prunes worktrees and fast-forwards the local base branch to its remote.
 * - Sets the item done with delivered_in (`pr`, else the item's) and code_refs (the files the branch changed against
 *   the base, else the item's code_refs).
 */
export async function finishWorktree(service: OverseerService, id: string, options: WorktreeFinishOptions, ctx: Ctx): Promise<WorktreeFinishResult> {
  const { item } = service.getItem(id);
  assertWorkItem(item, 'finished');
  const root = service.root;
  assertGitRepo(root);
  const mergedHead = options.mergedHead.trim();
  if (!SHA.test(mergedHead)) {
    throw new OverseerError('INVALID_INPUT', `Invalid merged head "${mergedHead}": pass the pull request's head commit SHA.`);
  }
  const deliveredIn = options.pr?.trim() || item.delivered_in;
  if (!deliveredIn) throw new OverseerError('INVALID_INPUT', `${item.id} has no delivered_in; pass --pr with the pull request URL.`);
  const base = options.base ?? service.configValue('base_branch');

  const matcher = branchMatcher(service.configValue('branch_pattern'), escapeRegExp(item.id));
  const locals = matchingRefs(root, 'refs/heads/', matcher);
  const remote = remoteFor(root, locals.length === 1 ? locals[0]! : null);
  const baseRemote = remoteFor(root, refExists(root, `refs/heads/${base}`) ? base : null);
  for (const name of new Set([remote, baseRemote])) {
    if (name !== null) gitOrThrow(root, ['fetch', '--quiet', '--prune', name], FETCH_TIMEOUT_MS);
  }
  const remotes = remote === null ? [] : matchingRefs(root, `refs/remotes/${remote}/`, matcher);
  const branches = [...new Set([...locals, ...remotes])];
  if (branches.length > 1) {
    throw new OverseerError('CONFLICT', `${item.id} matches several branches (${branches.join(', ')}); delete the extra ones and retry.`);
  }
  const branch = branches[0] ?? null;
  const head = git(root, ['rev-parse', '--verify', '--quiet', `${mergedHead}^{commit}`]);
  if (head === undefined) {
    throw new OverseerError('NOT_FOUND', `Merged head ${mergedHead} is not in this repository; fetch the pull request's commits and retry.`);
  }

  const localRef = branch !== null && locals.includes(branch) ? `refs/heads/${branch}` : null;
  const remoteBranch = branch !== null && remotes.includes(branch) ? `${remote}/${branch}` : null;
  const worktree = branch === null ? undefined : listGitWorktrees(root).find((entry) => entry.branch === branch);
  if (worktree?.main) {
    throw new OverseerError('CONFLICT', `${branch} is checked out in the main checkout ${worktree.path}; switch it to ${base} and retry.`);
  }

  const lost: string[] = [];
  if (worktree !== undefined && existsSync(worktree.path)) {
    const changes = runGit(worktree.path, ['status', '--porcelain', '--untracked-files=all'], WORKTREE_TIMEOUT_MS);
    if (!changes.ok) throw new OverseerError('GIT_FAILED', `git status in ${worktree.path} failed: ${changes.reason}`);
    if (changes.stdout.trim() !== '') lost.push(`uncommitted changes in ${worktree.path}:\n${indent(changes.stdout.trimEnd())}`);
  }
  for (const ref of [localRef, remoteBranch === null ? null : `refs/remotes/${remoteBranch}`]) {
    if (ref === null) continue;
    const commits = gitOrThrow(root, ['log', '--oneline', '--no-decorate', `${head}..${ref}`], WORKTREE_TIMEOUT_MS);
    if (commits !== '') lost.push(`commits on ${ref.replace(/^refs\/(heads|remotes)\//, '')} that ${mergedHead} lacks:\n${indent(commits)}`);
  }
  if (lost.length > 0) {
    throw new OverseerError('CONFLICT', `Nothing was removed; finishing ${item.id} would lose:\n${lost.map((entry) => `- ${entry}`).join('\n')}`, { lost });
  }

  const baseRef = [`refs/heads/${base}`, baseRemote === null ? null : `refs/remotes/${baseRemote}/${base}`].find((ref) => ref !== null && refExists(root, ref));
  const files = baseRef ? changedFiles(root, baseRef, head) : [];
  const codeRefs = files.length > 0 ? files : item.code_refs;

  if (remoteBranch !== null) deleteRemoteBranch(root, remote!, branch!);
  if (worktree !== undefined && existsSync(worktree.path)) gitOrThrow(root, ['worktree', 'remove', worktree.path], WORKTREE_TIMEOUT_MS);
  if (localRef !== null) gitOrThrow(root, ['branch', '--quiet', '-D', branch!], WORKTREE_TIMEOUT_MS);
  gitOrThrow(root, ['worktree', 'prune'], WORKTREE_TIMEOUT_MS);
  const baseUpdate = fastForwardBase(root, base, baseRemote);

  const removed = [worktree && `worktree ${worktree.path}`, localRef && `branch ${branch}`, remoteBranch && `remote branch ${remoteBranch}`].filter(Boolean);
  const comment = `Pull request merged: ${deliveredIn}${removed.length > 0 ? `; removed ${removed.join(', ')}` : ''}.`;
  const { item: updated } = await service.updateItem({ id: item.id, status: 'done', delivered_in: deliveredIn, code_refs: codeRefs, comment }, ctx);
  return {
    id: updated.id,
    status: updated.status,
    branch: localRef === null ? null : branch,
    path: worktree?.path ?? null,
    remote_branch: remoteBranch,
    base: baseUpdate,
    delivered_in: deliveredIn,
    code_refs: updated.code_refs,
  };
}

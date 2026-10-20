import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import type { OverseerService } from '../src/core/service.js';
import { detectSetupCommand, finishWorktree, listWorktrees, slugFromTitle, startWorktree } from '../src/core/worktree.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { ctx, openService } from './helpers/service.js';
import { git, tempDir, tempUserConfig } from './helpers/tmp.js';

const WRITE_MARKER = `node -e "require('fs').writeFileSync('setup-ran', process.cwd())"`;

interface Project {
  base: string;
  repo: string;
  origin: string;
  service: OverseerService;
}

/**
 * `<base>/main`: a repo with one commit pushed to the bare `<base>/origin.git`, an overseer project with TASK-0001
 * ("Create and reuse the issue worktrees") and BUG-0001. The default worktree_root is `<base>/main.worktrees`.
 */
async function project(): Promise<Project> {
  const base = tempDir('ovs-wt-');
  const origin = join(base, 'origin.git');
  const repo = join(base, 'main');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'init', '-q', '-b', 'main', repo);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  const service = openService(repo);
  await service.createItem({ kind: 'task', title: 'Create and reuse the issue worktrees', allow_duplicate: true }, ctx);
  await service.createItem({ kind: 'bug', title: 'Login fails on Safari', allow_duplicate: true }, ctx);
  return { base, repo, origin, service };
}

/** Clone of origin under `<base>/clone`, on an up-to-date main. */
function originClone(p: Project): string {
  const clone = join(p.base, 'clone');
  if (!existsSync(clone)) git(p.base, 'clone', '-q', p.origin, clone);
  git(clone, 'fetch', '-q', 'origin');
  git(clone, 'checkout', '-q', 'main');
  git(clone, 'merge', '-q', '--ff-only', 'origin/main');
  return clone;
}

/** Commits `file` on origin's main through a separate clone; returns the new commit. */
function pushToOrigin(p: Project, file: string): string {
  const clone = originClone(p);
  writeFileSync(join(clone, file), '{}\n');
  git(clone, 'add', file);
  git(clone, 'commit', '-q', '-m', `add ${file}`);
  git(clone, 'push', '-q', 'origin', 'main');
  return git(clone, 'rev-parse', 'HEAD');
}

/** Starts TASK-0001's worktree, commits `files` there and pushes the branch to origin with upstream tracking. */
async function pushedBranch(p: Project, files: Record<string, string> = { 'feature.txt': 'done\n' }): Promise<{ path: string; branch: string; head: string }> {
  const { path, branch } = await startWorktree(p.service, 'TASK-0001', { slug: 'start', setup: false });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(path, file), content);
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'feat: start');
  git(path, 'push', '-q', '-u', 'origin', branch);
  return { path, branch, head: git(path, 'rev-parse', 'HEAD') };
}

/** Merges origin's `branch` into origin's main like a pull request: squashed, or with a merge commit. Returns origin's new main. */
function mergeOnOrigin(p: Project, branch: string, how: 'squash' | 'merge' = 'squash'): string {
  const clone = originClone(p);
  if (how === 'squash') {
    git(clone, 'merge', '-q', '--squash', `origin/${branch}`);
    git(clone, 'commit', '-q', '-m', 'feat: start (#1)');
  } else {
    git(clone, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #1', `origin/${branch}`);
  }
  git(clone, 'push', '-q', 'origin', 'main');
  return git(clone, 'rev-parse', 'HEAD');
}

const PR = 'https://github.com/acme/app/pull/1';

async function rejection(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('expected a rejection');
}

describe('slugFromTitle', () => {
  it('strips accents, drops filler words and keeps the first four words', () => {
    expect(slugFromTitle('Create and reuse the issue worktrees')).toBe('create-reuse-issue-worktrees');
    expect(slugFromTitle('Añadir la búsqueda semántica')).toBe('anadir-la-busqueda-semantica');
    expect(slugFromTitle('Fix: the API’s 404 for /users/{id} with a trailing slash')).toBe('fix-api-s-404');
    expect(slugFromTitle('Store the constructor of an object')).toBe('store-constructor-object');
    expect(slugFromTitle('Create and reuse the issue worktrees')).toBe(slugFromTitle('Create and reuse the issue worktrees'));
    expect(slugFromTitle('¿¡ !?')).toBe('');
  });
});

describe('detectSetupCommand', () => {
  it('maps each lockfile to its install command, package-lock first', () => {
    const dir = tempDir();
    expect(detectSetupCommand(dir)).toBeNull();
    writeFileSync(join(dir, 'yarn.lock'), '');
    expect(detectSetupCommand(dir)).toBe('yarn install --immutable');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    expect(detectSetupCommand(dir)).toBe('pnpm install --frozen-lockfile');
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    expect(detectSetupCommand(dir)).toBe('npm ci');
  });
});

describe('startWorktree', () => {
  it('creates the branch from the freshly fetched origin/<base> under worktree_root and runs the setup there', async () => {
    const p = await project();
    const head = pushToOrigin(p, 'package-lock.json');
    p.service.setConfig('worktree_setup', WRITE_MARKER);
    let output = '';

    const result = await startWorktree(p.service, 'task-1', { output: (chunk) => (output += chunk) });

    const path = join(p.base, 'main.worktrees', 'TASK-0001-create-reuse-issue-worktrees');
    expect(result).toEqual({
      path,
      branch: 'feat/TASK-0001-create-reuse-issue-worktrees',
      base: 'main',
      reused: false,
      setup: { command: WRITE_MARKER, ran: true },
    });
    expect(git(path, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(path, 'symbolic-ref', '--short', 'HEAD')).toBe(result.branch);
    expect(git(path, 'for-each-ref', '--format=%(upstream)', `refs/heads/${result.branch}`)).toBe('');
    expect(readFileSync(join(path, 'setup-ran'), 'utf8')).toBe(path);
    expect(output).toBe('');
    expect(p.service.getItem('TASK-0001').item.status).toBe('backlog');
  });

  it('starts from the local base when origin lacks it, and NOT_FOUND when neither has it', async () => {
    const p = await project();
    git(p.repo, 'branch', 'develop');

    const result = await startWorktree(p.service, 'TASK-0001', { base: 'develop', setup: false });
    expect(result).toMatchObject({ base: 'develop', reused: false, setup: { command: null, ran: false } });
    expect(git(result.path, 'rev-parse', 'HEAD')).toBe(git(p.repo, 'rev-parse', 'develop'));

    const missing = await rejection(startWorktree(p.service, 'BUG-0001', { base: 'nope' }));
    expect(missing.code).toBe('NOT_FOUND');
    expect(missing.message).toContain('origin/nope');
    expect(git(p.repo, 'branch', '--list', 'fix/*')).toBe('');
  });

  it('surfaces fetch errors instead of starting from stale refs', async () => {
    const p = await project();
    git(p.repo, 'remote', 'set-url', 'origin', join(p.base, 'gone.git'));

    const error = await rejection(startWorktree(p.service, 'TASK-0001'));
    expect(error.code).toBe('GIT_FAILED');
    expect(error.message).toMatch(/git fetch --quiet origin failed: .*gone\.git/s);
    expect(existsSync(join(p.base, 'main.worktrees'))).toBe(false);
  });

  it('reuses the worktree already on the branch without setup, wherever it lives', async () => {
    const p = await project();
    const elsewhere = join(p.base, 'my-checkout');
    git(p.repo, 'worktree', 'add', '-q', '-b', 'feat/TASK-0001-start', elsewhere, 'main');
    writeFileSync(join(elsewhere, 'package-lock.json'), '{}');
    const before = git(p.repo, 'worktree', 'list', '--porcelain');

    const result = await startWorktree(p.service, 'TASK-0001', { slug: 'start' });

    expect(result).toEqual({ path: elsewhere, branch: 'feat/TASK-0001-start', base: 'main', reused: true, setup: { command: 'npm ci', ran: false } });
    expect(git(p.repo, 'worktree', 'list', '--porcelain')).toBe(before);
  });

  it('adds a worktree on an existing branch without creating a new one', async () => {
    const p = await project();
    git(p.repo, 'branch', 'feat/TASK-0001-start', 'main');
    git(p.repo, 'commit', '-q', '--allow-empty', '-m', 'later on main');

    const result = await startWorktree(p.service, 'TASK-0001', { slug: 'start', setup: false });

    expect(result).toMatchObject({ path: join(p.base, 'main.worktrees', 'TASK-0001-start'), branch: 'feat/TASK-0001-start', reused: false });
    expect(git(result.path, 'rev-parse', 'HEAD')).toBe(git(p.repo, 'rev-parse', 'main~1'));
    expect(git(p.repo, 'branch', '--list', 'feat/*')).toBe('+ feat/TASK-0001-start');
  });

  it('refuses a path that exists but is not the branch worktree, touching nothing', async () => {
    const p = await project();
    const path = join(p.base, 'main.worktrees', 'TASK-0001-start');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'notes.txt'), 'mine');

    const error = await rejection(startWorktree(p.service, 'TASK-0001', { slug: 'start' }));

    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain(path);
    expect(readFileSync(join(path, 'notes.txt'), 'utf8')).toBe('mine');
    expect(git(p.repo, 'branch', '--list', 'feat/*')).toBe('');
    expect(git(p.repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('validates kind, type and slug', async () => {
    const p = await project();
    await p.service.createItem({ kind: 'story', title: 'As a user I want worktrees so that I can work in parallel', allow_duplicate: true }, ctx);

    const story = await rejection(startWorktree(p.service, 'US-0001'));
    expect(story).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('is a story') });

    const bugFeat = await rejection(startWorktree(p.service, 'BUG-0001', { type: 'feat' }));
    expect(bugFeat).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('type fix') });

    expect((await rejection(startWorktree(p.service, 'TASK-0001', { type: 'feature' }))).code).toBe('INVALID_INPUT');
    expect((await rejection(startWorktree(p.service, 'TASK-0001', { slug: 'Bad_Slug' }))).code).toBe('INVALID_INPUT');
    expect((await rejection(startWorktree(p.service, 'TASK-0001', { slug: 'a--b' }))).code).toBe('INVALID_INPUT');
    expect((await rejection(startWorktree(p.service, 'TASK-0404'))).code).toBe('NOT_FOUND');
    expect(git(p.repo, 'worktree', 'list').split('\n')).toHaveLength(1);

    const bug = await startWorktree(p.service, 'BUG-0001', { setup: false });
    expect(bug.branch).toBe('fix/BUG-0001-login-fails-safari');
  });

  it('fills a custom branch_pattern and rejects one that gives an invalid ref', async () => {
    const p = await project();
    p.service.setConfig('branch_pattern', 'work/{id}/{type}-{slug}');
    p.service.setConfig('worktree_root', '../trees');

    const result = await startWorktree(p.service, 'TASK-0001', { type: 'docs', slug: 'readme', setup: false });
    expect(result).toMatchObject({ branch: 'work/TASK-0001/docs-readme', path: join(p.base, 'trees', 'TASK-0001-readme') });

    p.service.setConfig('branch_pattern', '{id}..{slug}');
    const error = await rejection(startWorktree(p.service, 'TASK-0001', { slug: 'other' }));
    expect(error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('TASK-0001..other') });
  });

  it('detects the setup from the new worktree lockfile; "none" and --no-setup skip it', async () => {
    const p = await project();
    pushToOrigin(p, 'pnpm-lock.yaml');

    const skipped = await startWorktree(p.service, 'TASK-0001', { slug: 'one', setup: false });
    expect(skipped.setup).toEqual({ command: 'pnpm install --frozen-lockfile', ran: false });

    p.service.setConfig('worktree_setup', 'none');
    const none = await startWorktree(p.service, 'TASK-0001', { slug: 'two' });
    expect(none.setup).toEqual({ command: null, ran: false });
    expect(p.service.configValue('worktree_setup')).toBe('none');
  });

  it('keeps the worktree and throws SETUP_FAILED when the setup fails', async () => {
    const p = await project();
    p.service.setConfig('worktree_setup', `node -e "console.log('installing'); console.error('boom'); process.exit(3)"`);
    let output = '';

    const error = await rejection(startWorktree(p.service, 'TASK-0001', { slug: 'start', output: (chunk) => (output += chunk) }));

    const path = join(p.base, 'main.worktrees', 'TASK-0001-start');
    expect(error.code).toBe('SETUP_FAILED');
    expect(error.message).toContain('exit code 3');
    expect(error.message).toContain(path);
    expect(error.message).toContain(`node -e`);
    expect(output).toContain('installing');
    expect(output).toContain('boom');
    expect(git(path, 'symbolic-ref', '--short', 'HEAD')).toBe('feat/TASK-0001-start');

    const again = await startWorktree(p.service, 'TASK-0001', { slug: 'start' });
    expect(again).toMatchObject({ path, reused: true, setup: { ran: false } });
  });

  it('refuses, creating nothing, while depends_on tasks or bugs are open, listing their status and branch', async () => {
    const p = await project();
    const dep = await pushedBranch(p);
    await p.service.updateItem({ id: 'TASK-0001', status: 'in_progress' }, ctx);
    await p.service.createItem({ kind: 'task', title: 'Stack the follow-up work', allow_duplicate: true }, ctx);
    p.service.link('TASK-0002', 'depends_on', 'TASK-0001', ctx);
    p.service.link('TASK-0002', 'depends_on', 'BUG-0001', ctx);

    const error = await rejection(startWorktree(p.service, 'TASK-0002', { slug: 'follow-up', setup: false }));
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain(`- TASK-0001 (in_progress): branch ${dep.branch}`);
    expect(error.message).toContain('- BUG-0001 (backlog): no branch yet');
    expect(git(p.repo, 'branch', '--list', 'feat/TASK-0002-*')).toBe('');
    expect(existsSync(join(p.base, 'main.worktrees', 'TASK-0002-follow-up'))).toBe(false);

    const stacked = await startWorktree(p.service, 'TASK-0002', { slug: 'follow-up', base: dep.branch, setup: false });
    expect(stacked).toMatchObject({ base: dep.branch, reused: false });
    expect(git(stacked.path, 'rev-parse', 'HEAD')).toBe(dep.head);
    expect(await startWorktree(p.service, 'TASK-0002', { slug: 'follow-up' })).toMatchObject({ path: stacked.path, reused: true });

    const anyway = await startWorktree(p.service, 'TASK-0002', { slug: 'on-main', base: 'main', setup: false });
    expect(anyway).toMatchObject({ base: 'main', reused: false });
    expect(git(anyway.path, 'rev-parse', 'HEAD')).toBe(git(p.repo, 'rev-parse', 'main'));
  });

  it('starts as usual once depends_on work is done or cancelled, ignoring requirements', async () => {
    const p = await project();
    await p.service.createItem({ kind: 'task', title: 'Stack the follow-up work', allow_duplicate: true }, ctx);
    await p.service.createItem({ kind: 'requirement', title: 'Worktrees per item', req_type: 'functional', allow_duplicate: true }, ctx);
    p.service.link('TASK-0002', 'depends_on', 'TASK-0001', ctx);
    p.service.link('TASK-0002', 'depends_on', 'BUG-0001', ctx);
    p.service.link('TASK-0002', 'depends_on', 'REQ-0001', ctx);
    await p.service.updateItem({ id: 'TASK-0001', status: 'done' }, ctx);
    await p.service.updateItem({ id: 'BUG-0001', status: 'cancelled' }, ctx);

    const result = await startWorktree(p.service, 'TASK-0002', { slug: 'follow-up', setup: false });
    expect(result).toMatchObject({ base: 'main', reused: false });
  });
});

describe('finishWorktree', () => {
  it('removes the worktree and both branches, fast-forwards the checked-out main and sets the item done', async () => {
    const p = await project();
    const shipped = await pushedBranch(p, { 'feature.txt': 'done\n', '.gitignore': 'deps/\n' });
    mkdirSync(join(shipped.path, 'deps'));
    writeFileSync(join(shipped.path, 'deps', 'lib.js'), 'ignored');
    const merged = mergeOnOrigin(p, shipped.branch);

    const result = await finishWorktree(p.service, 'task-1', { mergedHead: shipped.head, pr: PR }, ctx);

    expect(result).toEqual({
      id: 'TASK-0001',
      status: 'done',
      branch: shipped.branch,
      path: shipped.path,
      remote_branch: `origin/${shipped.branch}`,
      base: { branch: 'main', head: merged, fast_forwarded: true, reason: null },
      delivered_in: PR,
      code_refs: ['.gitignore', 'feature.txt'],
    });
    expect(existsSync(shipped.path)).toBe(false);
    expect(git(p.repo, 'branch', '--list', 'feat/*')).toBe('');
    expect(git(p.repo, 'branch', '-r', '--list', 'origin/feat/*')).toBe('');
    expect(git(p.repo, 'ls-remote', '--heads', 'origin')).not.toContain(shipped.branch);
    expect(git(p.repo, 'rev-parse', 'HEAD')).toBe(merged);
    expect(readFileSync(join(p.repo, 'feature.txt'), 'utf8')).toBe('done\n');
    expect(git(p.repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    const { item, history } = p.service.getItem('TASK-0001', { history: true });
    expect(item).toMatchObject({ status: 'done', delivered_in: PR, code_refs: ['.gitignore', 'feature.txt'] });
    expect(history?.find((event) => event.action === 'comment')?.new_value).toContain(PR);
  });

  it('refuses, removing nothing, when uncommitted changes or commits missing from the merged head would be lost', async () => {
    const p = await project();
    const shipped = await pushedBranch(p);
    mergeOnOrigin(p, shipped.branch);
    git(p.repo, 'fetch', '-q', 'origin');
    const state = () => [git(p.repo, 'worktree', 'list'), git(p.repo, 'for-each-ref'), git(p.origin, 'for-each-ref'), p.service.getItem('TASK-0001').item.status];

    writeFileSync(join(shipped.path, 'notes.txt'), 'draft');
    writeFileSync(join(shipped.path, 'feature.txt'), 'changed\n');
    let before = state();
    const dirty = await rejection(finishWorktree(p.service, 'TASK-0001', { mergedHead: shipped.head, pr: PR }, ctx));
    expect(dirty.code).toBe('CONFLICT');
    expect(dirty.message).toContain(`uncommitted changes in ${shipped.path}`);
    expect(dirty.message).toContain(' M feature.txt');
    expect(dirty.message).toContain('?? notes.txt');
    expect(state()).toEqual(before);

    git(shipped.path, 'add', '.');
    git(shipped.path, 'commit', '-q', '-m', 'late fix');
    before = state();
    const local = await rejection(finishWorktree(p.service, 'TASK-0001', { mergedHead: shipped.head, pr: PR }, ctx));
    expect(local.code).toBe('CONFLICT');
    expect(local.message).toMatch(new RegExp(`commits on ${shipped.branch} that ${shipped.head} lacks:\\n +[0-9a-f]+ late fix`));
    expect(local.message).not.toContain('uncommitted');
    expect(state()).toEqual(before);

    git(shipped.path, 'push', '-q', 'origin', shipped.branch);
    git(shipped.path, 'reset', '-q', '--hard', shipped.head);
    before = state();
    const remote = await rejection(finishWorktree(p.service, 'TASK-0001', { mergedHead: shipped.head, pr: PR }, ctx));
    expect(remote.message).toContain(`commits on origin/${shipped.branch} that ${shipped.head} lacks`);
    expect(remote.message).not.toContain(`commits on ${shipped.branch} `);
    expect(state()).toEqual(before);
  });

  it('diffs from before the merge commit already in the local base and skips a remote branch deleted on merge', async () => {
    const p = await project();
    const shipped = await pushedBranch(p);
    const merged = mergeOnOrigin(p, shipped.branch, 'merge');
    git(originClone(p), 'push', '-q', 'origin', '--delete', shipped.branch);
    git(p.repo, 'checkout', '-q', '--detach');
    git(p.repo, 'fetch', '-q', 'origin');
    git(p.repo, 'branch', '-q', '-f', 'main', 'origin/main');
    await p.service.updateItem({ id: 'TASK-0001', status: 'review', delivered_in: PR }, ctx);

    const result = await finishWorktree(p.service, 'TASK-0001', { mergedHead: shipped.head.slice(0, 12) }, ctx);

    expect(result).toMatchObject({
      branch: shipped.branch,
      remote_branch: null,
      base: { branch: 'main', head: merged, fast_forwarded: false, reason: null },
      delivered_in: PR,
      code_refs: ['feature.txt'],
    });
    expect(git(p.repo, 'branch', '-a', '--list', '*TASK-0001*')).toBe('');
  });

  it('moves a base checked out nowhere and leaves a diverged base alone', async () => {
    const p = await project();
    const shipped = await pushedBranch(p);
    const merged = mergeOnOrigin(p, shipped.branch);
    git(p.repo, 'checkout', '-q', '--detach');

    const moved = await finishWorktree(p.service, 'TASK-0001', { mergedHead: shipped.head, pr: PR }, ctx);
    expect(moved.base).toEqual({ branch: 'main', head: merged, fast_forwarded: true, reason: null });
    expect(git(p.repo, 'rev-parse', 'main')).toBe(merged);

    git(p.repo, 'checkout', '-q', 'main');
    git(p.repo, 'commit', '-q', '--allow-empty', '-m', 'local only');
    const local = git(p.repo, 'rev-parse', 'HEAD');
    const bug = await startWorktree(p.service, 'BUG-0001', { setup: false });
    pushToOrigin(p, 'other.txt');

    const kept = await finishWorktree(p.service, 'BUG-0001', { mergedHead: git(bug.path, 'rev-parse', 'HEAD'), pr: PR }, ctx);
    expect(kept.base).toEqual({ branch: 'main', head: local, fast_forwarded: false, reason: 'main has commits that are not on origin/main' });
    expect(kept.status).toBe('done');
    expect(git(p.repo, 'rev-parse', 'main')).toBe(local);
  });

  it('validates the item, the merged head and delivered_in before touching anything', async () => {
    const p = await project();
    const shipped = await pushedBranch(p);
    await p.service.createItem({ kind: 'story', title: 'As a user I want worktrees so that I can work in parallel', allow_duplicate: true }, ctx);
    const before = [git(p.repo, 'worktree', 'list'), git(p.repo, 'for-each-ref')];

    expect(await rejection(finishWorktree(p.service, 'US-0001', { mergedHead: shipped.head, pr: PR }, ctx))).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('is a story'),
    });
    expect((await rejection(finishWorktree(p.service, 'TASK-0001', { mergedHead: 'main', pr: PR }, ctx))).code).toBe('INVALID_INPUT');
    expect(await rejection(finishWorktree(p.service, 'TASK-0001', { mergedHead: shipped.head }, ctx))).toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('--pr'),
    });
    expect((await rejection(finishWorktree(p.service, 'TASK-0001', { mergedHead: 'deadbeefdeadbeef', pr: PR }, ctx))).code).toBe('NOT_FOUND');
    git(p.repo, 'branch', 'fix/TASK-0001-other', shipped.head);
    expect(await rejection(finishWorktree(p.service, 'TASK-0001', { mergedHead: shipped.head, pr: PR }, ctx))).toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('several branches'),
    });
    git(p.repo, 'branch', '-D', 'fix/TASK-0001-other');
    expect([git(p.repo, 'worktree', 'list'), git(p.repo, 'for-each-ref')]).toEqual(before);
    expect(p.service.getItem('TASK-0001').item.status).toBe('backlog');
  });
});

describe('listWorktrees', () => {
  it('lists worktrees on item branches with their ids, skipping the main checkout and other branches', async () => {
    const p = await project();
    const task = await startWorktree(p.service, 'TASK-0001', { setup: false });
    const bug = await startWorktree(p.service, 'BUG-0001', { setup: false });
    git(p.repo, 'worktree', 'add', '-q', '-b', 'spike', join(p.base, 'spike'), 'main');
    git(p.repo, 'checkout', '-q', '-b', 'feat/TASK-0002-main');

    expect(listWorktrees(p.service)).toEqual([
      { id: 'BUG-0001', branch: bug.branch, path: bug.path },
      { id: 'TASK-0001', branch: task.branch, path: task.path },
    ]);
  });
});

describe('overseer worktree start', () => {
  it('resolves to the main checkout from inside another worktree, prints JSON on stdout and setup output on stderr', async () => {
    const p = await project();
    p.service.setConfig('worktree_setup', `node -e "console.log('setup says hi')"`);
    p.service.close();
    const other = join(p.base, 'other');
    git(p.repo, 'worktree', 'add', '-q', '-b', 'feat/TASK-0099-other', other, 'main');
    let out = '';
    let err = '';
    const io = { stdout: { write: (chunk: string) => (out += chunk) }, stderr: { write: (chunk: string) => (err += chunk) }, stdin: Readable.from([]) };

    const code = await runCli(['worktree', 'start', 'TASK-0001', '--json'], io, {
      embedder: new HashEmbedder(),
      env: { OVERSEER_CONFIG_DIR: tempUserConfig() },
      cwd: other,
    });

    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({
      path: join(p.base, 'main.worktrees', 'TASK-0001-create-reuse-issue-worktrees'),
      reused: false,
      setup: { ran: true },
    });
    expect(err).toBe('setup says hi\n');
    expect(existsSync(join(other, '.overseer'))).toBe(false);

    out = '';
    expect(await runCli(['worktree', 'start', 'BUG-0001', '--type', 'feat', '--json'], io, { embedder: new HashEmbedder(), env: { OVERSEER_CONFIG_DIR: tempUserConfig() }, cwd: other })).toBe(1);
    expect(JSON.parse(out)).toEqual({ error: { code: 'INVALID_INPUT', message: expect.stringContaining('type fix') } });
  });
});

describe('overseer worktree list and finish', () => {
  it('lists the item worktree, refuses a dirty one with exit code 1 and finishes it once clean', async () => {
    const p = await project();
    const shipped = await pushedBranch(p);
    mergeOnOrigin(p, shipped.branch);
    p.service.close();
    writeFileSync(join(shipped.path, 'notes.txt'), 'draft');
    let out = '';
    const io = { stdout: { write: (chunk: string) => (out += chunk) }, stderr: { write: () => true }, stdin: Readable.from([]) };
    const run = (...args: string[]) => runCli(args, io, { embedder: new HashEmbedder(), env: { OVERSEER_CONFIG_DIR: tempUserConfig() }, cwd: p.repo });

    expect(await run('worktree', 'list', '--json')).toBe(0);
    expect(JSON.parse(out)).toEqual([{ id: 'TASK-0001', branch: shipped.branch, path: shipped.path }]);

    out = '';
    expect(await run('worktree', 'finish', 'TASK-0001', '--merged-head', shipped.head, '--pr', PR, '--json')).toBe(1);
    expect(JSON.parse(out)).toEqual({ error: { code: 'CONFLICT', message: expect.stringContaining('?? notes.txt') } });
    expect(existsSync(shipped.path)).toBe(true);

    rmSync(join(shipped.path, 'notes.txt'));
    out = '';
    expect(await run('worktree', 'finish', 'TASK-0001', '--merged-head', shipped.head, '--pr', PR, '--json')).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ id: 'TASK-0001', status: 'done', path: shipped.path, base: { fast_forwarded: true } });
    expect(existsSync(shipped.path)).toBe(false);
  });
});

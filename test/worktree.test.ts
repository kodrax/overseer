import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import type { OverseerService } from '../src/core/service.js';
import { detectSetupCommand, slugFromTitle, startWorktree } from '../src/core/worktree.js';
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

/** Commits `file` on origin's main through a separate clone; returns the new commit. */
function pushToOrigin(p: Project, file: string): string {
  const clone = join(p.base, 'clone');
  if (!existsSync(clone)) git(p.base, 'clone', '-q', p.origin, clone);
  writeFileSync(join(clone, file), '{}\n');
  git(clone, 'add', file);
  git(clone, 'commit', '-q', '-m', `add ${file}`);
  git(clone, 'push', '-q', 'origin', 'main');
  return git(clone, 'rev-parse', 'HEAD');
}

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

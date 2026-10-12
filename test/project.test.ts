import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/core/db.js';
import { assertWritableRoot, isGuardedRoot, resolveProjectRoot } from '../src/core/project.js';
import { git, tempDir, tempRepo } from './helpers/tmp.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveProjectRoot', () => {
  it('maps a linked worktree and subdirectories to the main checkout', () => {
    const main = tempRepo();
    const worktree = join(tempDir(), 'wt');
    git(main, 'worktree', 'add', '-q', worktree, '-b', 'feature');
    mkdirSync(join(worktree, 'src', 'deep'), { recursive: true });
    mkdirSync(join(main, 'pkg'), { recursive: true });

    expect(resolveProjectRoot(worktree)).toBe(main);
    expect(resolveProjectRoot(join(worktree, 'src', 'deep'))).toBe(main);
    expect(resolveProjectRoot(join(main, 'pkg'))).toBe(main);
  });

  it('walks up to the nearest .overseer folder outside git, else keeps the start dir', () => {
    const base = tempDir();
    mkdirSync(join(base, 'proj', '.overseer'), { recursive: true });
    mkdirSync(join(base, 'proj', 'a', 'b'), { recursive: true });
    mkdirSync(join(base, 'other', 'x'), { recursive: true });

    expect(resolveProjectRoot(join(base, 'proj', 'a', 'b'))).toBe(join(base, 'proj'));
    expect(resolveProjectRoot(join(base, 'other', 'x'))).toBe(join(base, 'other', 'x'));
  });
});

describe('home guard', () => {
  it('guards the filesystem root, the home dir and its ancestors, not projects below home', () => {
    const home = join(tempDir(), 'home', 'user');
    mkdirSync(join(home, 'code', 'app'), { recursive: true });
    vi.stubEnv('HOME', home);

    expect(isGuardedRoot('/')).toBe(true);
    expect(isGuardedRoot(home)).toBe(true);
    expect(isGuardedRoot(dirname(home))).toBe(true);
    expect(isGuardedRoot(join(home, 'code', 'app'))).toBe(false);
    expect(() => assertWritableRoot(home)).toThrow(/NO_PROJECT|No project detected/);
    expect(() => openDatabase(home, { create: true })).toThrow(/No project detected/);
    expect(existsSync(join(home, '.overseer'))).toBe(false);
  });
});

describe('data folder', () => {
  it('is self-ignored and leaves git status clean; reads never create it', () => {
    const repo = tempRepo();
    expect(openDatabase(repo, { create: false })).toBeUndefined();
    expect(existsSync(join(repo, '.overseer'))).toBe(false);

    const opened = openDatabase(repo, { create: true });
    expect(opened).toBeDefined();
    opened!.db.close();

    expect(readFileSync(join(repo, '.overseer', '.gitignore'), 'utf8')).toBe('*\n');
    expect(existsSync(join(repo, '.overseer', 'overseer.db'))).toBe(true);
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});

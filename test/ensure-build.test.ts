import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git, tempDir } from './helpers/tmp.js';

const REPO = join(import.meta.dirname, '..');

/** Counts builds in dist/builds; postbuild records the hash like the real package.json. */
const PACKAGE = {
  name: 'ensure-build-fixture',
  private: true,
  scripts: {
    build: `node -e "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});const f='dist/builds';fs.writeFileSync(f,String(Number(fs.existsSync(f)?fs.readFileSync(f,'utf8'):0)+1))"`,
    postbuild: 'node scripts/ensure-build.mjs --record',
  },
};

/** A git repo with the real scripts and hooks, a fake build, `node_modules/` and dist/ ignored, one commit. */
function fixture(): string {
  const dir = tempDir('ovs-build-');
  git(dir, 'init', '-q', '-b', 'main');
  cpSync(join(REPO, 'scripts'), join(dir, 'scripts'), { recursive: true });
  cpSync(join(REPO, '.githooks'), join(dir, '.githooks'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(PACKAGE, null, 2));
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndist/\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'cli.ts'), 'export const v = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function ensureBuild(dir: string): string {
  return execFileSync('node', ['scripts/ensure-build.mjs'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function builds(dir: string): number {
  const file = join(dir, 'dist', 'builds');
  return existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
}

describe('scripts/ensure-build.mjs', () => {
  it('builds when the hash is missing, then skips while the sources are unchanged', () => {
    const dir = fixture();
    ensureBuild(dir);
    expect(builds(dir)).toBe(1);
    expect(readFileSync(join(dir, 'dist', '.build-hash'), 'utf8')).toMatch(/^[0-9a-f]{64}\n$/);
    expect(ensureBuild(dir)).toBe('');
    expect(builds(dir)).toBe(1);
  });

  it('rebuilds after an uncommitted, untracked or committed change to a build input', () => {
    const dir = fixture();
    ensureBuild(dir);
    writeFileSync(join(dir, 'src', 'cli.ts'), 'export const v = 2;\n');
    ensureBuild(dir);
    expect(builds(dir)).toBe(2);
    writeFileSync(join(dir, 'src', 'new.ts'), 'export {};\n');
    ensureBuild(dir);
    expect(builds(dir)).toBe(3);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'change');
    ensureBuild(dir);
    expect(builds(dir)).toBe(3);
    writeFileSync(join(dir, 'README.md'), 'not an input\n');
    ensureBuild(dir);
    expect(builds(dir)).toBe(3);
  });

  it('does not rebuild after a manual npm run build', () => {
    const dir = fixture();
    execFileSync('npm', ['run', 'build', '--silent'], { cwd: dir, stdio: 'ignore' });
    expect(builds(dir)).toBe(1);
    ensureBuild(dir);
    expect(builds(dir)).toBe(1);
  });

  it('does not record the hash when the build fails', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...PACKAGE, scripts: { ...PACKAGE.scripts, build: 'node -e "process.exit(1)"' } }));
    const result = spawnSync('node', ['scripts/ensure-build.mjs'], { cwd: dir, stdio: 'ignore' });
    expect(result.status).not.toBe(0);
    expect(existsSync(join(dir, 'dist', '.build-hash'))).toBe(false);
  });
});

describe('.githooks', () => {
  /** `<base>/origin.git` and a clone `<base>/main` with the hooks installed by the prepare script. */
  function cloned(): { upstream: string; clone: string } {
    const upstream = fixture();
    const clone = join(tempDir('ovs-clone-'), 'main');
    git(upstream, 'clone', '-q', upstream, clone);
    execFileSync('node', ['scripts/install-hooks.mjs'], { cwd: clone });
    return { upstream, clone };
  }

  it('the prepare script points core.hooksPath at .githooks', () => {
    const { clone } = cloned();
    expect(git(clone, 'config', 'core.hooksPath')).toBe('.githooks');
  });

  it('git pull rebuilds dist when node_modules exists', () => {
    const { upstream, clone } = cloned();
    mkdirSync(join(clone, 'node_modules'));
    ensureBuild(clone);
    writeFileSync(join(upstream, 'src', 'cli.ts'), 'export const v = 2;\n');
    git(upstream, 'commit', '-q', '-am', 'change');
    git(clone, 'pull', '-q', '--ff-only');
    expect(builds(clone)).toBe(2);
  });

  it('skips with a message and lets git succeed when node_modules is missing', () => {
    const { clone } = cloned();
    const result = spawnSync('git', ['checkout', '-q', '-b', 'other'], { cwd: clone, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('node_modules is missing');
    expect(builds(clone)).toBe(0);
  });
});

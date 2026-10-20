#!/usr/bin/env node
// `prepare` script: points git at .githooks/ when this is a git checkout (.git is a directory, or a file in a worktree).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(root, '.git'))) {
  const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) console.warn('overseer: could not set core.hooksPath to .githooks');
}

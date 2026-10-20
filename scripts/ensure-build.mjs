#!/usr/bin/env node
// Keeps dist/ in step with its sources. Hashes the build inputs and compares them with dist/.build-hash:
//   node scripts/ensure-build.mjs           build with `npm run build` when the hash differs or is missing
//   node scripts/ensure-build.mjs --record  write the hash of the current inputs (the `postbuild` script)
// The hash is written only after a successful build: `npm run build` runs `postbuild` only when the build succeeds.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hashFile = join(root, 'dist', '.build-hash');
const INPUT_DIRS = ['src', 'web'];
const INPUT_FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsdown.config.ts', 'vite.config.ts'];

/** Tracked and untracked, not ignored, files under the input directories, plus the input files, sorted. */
function inputFiles() {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...INPUT_DIRS], {
    cwd: root,
    encoding: 'utf8',
  });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr || listed.error}`);
  const files = new Set(listed.stdout.split('\0').filter((file) => file !== ''));
  for (const file of INPUT_FILES) files.add(file);
  return [...files].sort();
}

function inputHash() {
  const hash = createHash('sha256');
  for (const file of inputFiles()) {
    const path = join(root, file);
    // Deleted but still tracked files and absent optional inputs hash as missing.
    const content = existsSync(path) ? readFileSync(path) : null;
    hash.update(`${file}\0${content === null ? 'missing' : content.length}\0`);
    if (content !== null) hash.update(content);
  }
  return hash.digest('hex');
}

const current = inputHash();
if (process.argv.includes('--record')) {
  mkdirSync(dirname(hashFile), { recursive: true });
  writeFileSync(hashFile, `${current}\n`);
  process.exit(0);
}

const recorded = existsSync(hashFile) ? readFileSync(hashFile, 'utf8').trim() : null;
if (recorded === current) process.exit(0);

console.log(`overseer: ${recorded === null ? 'dist has no build hash' : 'build inputs changed'}; running npm run build`);
const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(build.status ?? 1);

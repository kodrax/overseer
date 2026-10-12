import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | undefined;
let cachedVersion: string | undefined;

/**
 * Package root = nearest ancestor of this module that holds package.json.
 * Built: dist/cli.js → package dir (same as `new URL('../', import.meta.url)`); source/tests: repo root.
 */
export function packageRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('overseer: cannot locate package.json');
    dir = parent;
  }
}

export function templatesDir(): string {
  return join(packageRoot(), 'templates');
}

export function webDir(): string {
  return join(packageRoot(), 'dist', 'web');
}

/** Absolute path of the built CLI entry (used for user-scope MCP registrations). */
export function cliScriptPath(): string {
  return join(packageRoot(), 'dist', 'cli.js');
}

export function packageVersion(): string {
  if (cachedVersion) return cachedVersion;
  const pkg = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version: string };
  cachedVersion = pkg.version;
  return cachedVersion;
}

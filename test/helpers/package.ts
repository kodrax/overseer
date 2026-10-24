import { readFileSync } from 'node:fs';

function readVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  if (pkg && typeof pkg === 'object' && 'version' in pkg && typeof pkg.version === 'string') return pkg.version;
  throw new Error('package.json has no version');
}

/** Version in the repository's package.json, so tests follow release bumps. */
export const packageJsonVersion = readVersion();

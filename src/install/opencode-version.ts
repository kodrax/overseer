import { findExecutable, runCommand } from './exec.js';
import type { InstallContext } from './types.js';

export type OpencodeSchema = 'v1' | 'v2';

const cache = new WeakMap<InstallContext, OpencodeSchema>();

/** `opencode --version` major ≥ 2 → V2 config/frontmatter; older, failing or missing binary → V1. */
export function opencodeSchema(ctx: InstallContext): OpencodeSchema {
  const cached = cache.get(ctx);
  if (cached) return cached;
  const bin = findExecutable(ctx, 'opencode');
  let schema: OpencodeSchema = 'v1';
  if (bin) {
    const result = runCommand(ctx, bin, ['--version'], 10_000);
    const major = result.ok ? Number(/(\d+)\.\d+/.exec(result.stdout)?.[1]) : Number.NaN;
    if (major >= 2) schema = 'v2';
  }
  cache.set(ctx, schema);
  return schema;
}

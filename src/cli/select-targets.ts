import { createInterface } from 'node:readline';
import { isOverseerError, OverseerError } from '../core/errors.js';
import type { HarnessStatus, Scope, TargetId } from '../install/index.js';
import type { CliRuntime } from './runtime.js';

/** Parses `1,3`, `claude omp` or `all` against the listed harnesses (result in list order). */
export function parseTargetSelection(answer: string, statuses: readonly HarnessStatus[]): TargetId[] {
  const chosen = new Set<TargetId>();
  for (const token of answer.toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    if (token === 'all') {
      for (const status of statuses) chosen.add(status.target);
      continue;
    }
    const index = /^\d+$/.test(token) ? Number(token) - 1 : statuses.findIndex((status) => status.target === token);
    const status = statuses[index];
    if (!status) {
      throw new OverseerError(
        'INVALID_INPUT',
        `Unknown choice "${token}": use 1-${statuses.length}, a name (${statuses.map((entry) => entry.target).join(', ')}) or "all".`,
      );
    }
    chosen.add(status.target);
  }
  return statuses.map((status) => status.target).filter((target) => chosen.has(target));
}

/**
 * Lists every harness with its detection evidence and asks which ones to install for.
 * Enter keeps the pre-checked ones (`defaults`); end of input cancels.
 */
export async function promptTargets(
  rt: CliRuntime,
  statuses: readonly HarnessStatus[],
  defaults: readonly TargetId[],
  scope: Scope,
): Promise<TargetId[]> {
  const labelWidth = Math.max(...statuses.map((status) => status.label.length));
  rt.out(`Install overseer for which harnesses (${scope} scope)?`);
  statuses.forEach((status, index) => {
    const mark = defaults.includes(status.target) ? 'x' : ' ';
    const installed = status.installed ? ' · overseer installed' : '';
    rt.out(`  ${index + 1}. [${mark}] ${status.target.padEnd(8)} ${status.label.padEnd(labelWidth)}  ${status.evidence}${installed}`);
  });
  const reader = createInterface({ input: rt.io.stdin, terminal: false });
  const lines = reader[Symbol.asyncIterator]();
  try {
    for (;;) {
      rt.io.stdout.write(`Numbers or names (comma-separated), "all", or Enter for [${defaults.join(', ') || 'none'}]: `);
      const next = await lines.next();
      if (next.done) throw new OverseerError('INVALID_INPUT', 'Installation cancelled: no harness selected.');
      const answer = next.value.trim();
      if (answer === '') return [...defaults];
      try {
        return parseTargetSelection(answer, statuses);
      } catch (error) {
        if (!isOverseerError(error)) throw error;
        rt.err(`error: ${error.message}`);
      }
    }
  } finally {
    reader.close();
  }
}

import type { Database } from './db.js';
import type { CoverageState, ItemRef, Kind } from './schema.js';

export type DriftRule = 'work_done_status_open' | 'status_ahead_of_work' | 'unapproved_in_progress';

const ACTIVE = ['in_progress', 'review'];

/**
 * Requirement coverage (S5). `work` = items implementing the requirement (any status; cancelled ones are ignored here).
 */
export function computeCoverage(status: string, inBacklog: boolean, work: readonly Pick<ItemRef, 'status'>[]): CoverageState {
  if (status === 'deferred' || status === 'rejected' || status === 'obsolete') return 'not_applicable';
  if (status === 'verified') return 'verified';
  if (status === 'implemented') return 'delivered';
  const live = work.filter((item) => item.status !== 'cancelled');
  if (live.length > 0 && live.every((item) => item.status === 'done')) return 'delivered';
  if (live.some((item) => ACTIVE.includes(item.status))) return 'in_progress';
  if (live.length > 0 || inBacklog) return 'tracked';
  return 'untracked';
}

export const DRIFT_MESSAGES: Record<DriftRule, string> = {
  work_done_status_open: 'All implementing work is done but the requirement is still proposed/approved; set it to implemented (or verified).',
  status_ahead_of_work: 'The requirement is implemented/verified but some implementing work is not done.',
  unapproved_in_progress: 'Work on this requirement has started or finished while it is still only proposed; approve or reject it.',
};

export function driftRules(status: string, work: readonly Pick<ItemRef, 'status'>[]): DriftRule[] {
  const live = work.filter((item) => item.status !== 'cancelled');
  const rules: DriftRule[] = [];
  if (live.length > 0 && live.every((item) => item.status === 'done') && (status === 'proposed' || status === 'approved')) {
    rules.push('work_done_status_open');
  }
  if ((status === 'implemented' || status === 'verified') && live.some((item) => item.status !== 'done')) {
    rules.push('status_ahead_of_work');
  }
  if (status === 'proposed' && live.some((item) => ACTIVE.includes(item.status) || item.status === 'done')) {
    rules.push('unapproved_in_progress');
  }
  return rules;
}

/** requirement id → items with an `implements` link to it (all statuses, ID order). */
export function implementersByRequirement(db: Database, requirementId?: string): Map<string, ItemRef[]> {
  const rows = db
    .prepare(
      `SELECT l.dst AS req, i.id, i.kind, i.title, i.status FROM links l JOIN items i ON i.id = l.src
       WHERE l.rel = 'implements' ${requirementId ? 'AND l.dst = ?' : ''}
       ORDER BY substr(i.id, 1, instr(i.id, '-') - 1), CAST(substr(i.id, instr(i.id, '-') + 1) AS INTEGER)`,
    )
    .all(...(requirementId ? [requirementId] : [])) as unknown as (ItemRef & { req: string })[];
  const map = new Map<string, ItemRef[]>();
  for (const { req, id, kind, title, status } of rows) {
    const list = map.get(req) ?? [];
    list.push({ id, kind: kind as Kind, title, status });
    map.set(req, list);
  }
  return map;
}

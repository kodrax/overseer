// The client overview: every open item in one of three groups, with its kind and status in plain words.
import type { Kind } from './types';

export type OverviewGroup = 'planned' | 'in_progress' | 'done';

/** The groups in reading order, as the board's columns run: planned work, then work underway, then finished work. */
export const OVERVIEW_GROUPS: readonly OverviewGroup[] = ['planned', 'in_progress', 'done'];

export const GROUP_LABEL: Record<OverviewGroup, string> = {
  planned: 'Planned',
  in_progress: 'In progress',
  done: 'Done',
};

export const KIND_WORD: Record<Kind, string> = {
  requirement: 'Requirement',
  epic: 'Goal',
  story: 'Feature',
  task: 'Task',
  bug: 'Bug fix',
};

export interface OverviewState {
  group: OverviewGroup;
  /** The status in plain words, e.g. "In review" for `review`. */
  word: string;
}

const state = (group: OverviewGroup, word: string): OverviewState => ({ group, word });

const WORK_STATES: Record<string, OverviewState | null> = {
  backlog: state('planned', 'Not started'),
  ready: state('planned', 'Ready to start'),
  in_progress: state('in_progress', 'In progress'),
  review: state('in_progress', 'In review'),
  done: state('done', 'Done'),
  cancelled: null,
};

/** Every stored status of every kind; null marks a closed status, which the overview leaves out. */
const STATES: Record<Kind, Record<string, OverviewState | null>> = {
  requirement: {
    proposed: state('planned', 'Proposed'),
    approved: state('planned', 'Approved'),
    implemented: state('done', 'Built'),
    verified: state('done', 'Built and checked'),
    deferred: null,
    rejected: null,
    obsolete: null,
  },
  epic: {
    open: state('planned', 'Not started'),
    in_progress: state('in_progress', 'In progress'),
    done: state('done', 'Done'),
    cancelled: null,
  },
  story: WORK_STATES,
  task: WORK_STATES,
  bug: WORK_STATES,
};

/** The group and plain status word of an item, or null when its status is closed (or unknown) and it is not shown. */
export function overviewState(kind: Kind, status: string): OverviewState | null {
  return Object.hasOwn(STATES[kind], status) ? STATES[kind][status]! : null;
}

/** Splits items into the three groups, keeping their order, each with its plain status word; closed items are left out. */
export function groupForOverview<T extends { kind: Kind; status: string }>(
  items: readonly T[],
): Record<OverviewGroup, { item: T; word: string }[]> {
  const groups: Record<OverviewGroup, { item: T; word: string }[]> = { planned: [], in_progress: [], done: [] };
  for (const item of items) {
    const found = overviewState(item.kind, item.status);
    if (found) groups[found.group].push({ item, word: found.word });
  }
  return groups;
}

// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KINDS, STATUSES } from '../../src/core/schema.js';
import { App } from '../../web/src/App';
import { groupForOverview, overviewState, type OverviewGroup } from '../../web/src/overview';
import type { Kind, ListItemsResult } from '../../web/src/types';
import { listedItem, project, renderWithProviders, stubApi } from './harness';

const WORK: Record<string, OverviewGroup | null> = {
  backlog: 'planned',
  ready: 'planned',
  in_progress: 'in_progress',
  review: 'in_progress',
  done: 'done',
  cancelled: null,
};

// REQ-0267: the group of every stored status of every kind; null = closed, not shown.
const EXPECTED: Record<Kind, Record<string, OverviewGroup | null>> = {
  requirement: {
    proposed: 'planned',
    approved: 'planned',
    implemented: 'done',
    verified: 'done',
    deferred: null,
    rejected: null,
    obsolete: null,
  },
  epic: { open: 'planned', in_progress: 'in_progress', done: 'done', cancelled: null },
  story: WORK,
  task: WORK,
  bug: WORK,
};

/** One item for every status of every kind, titled `<kind> <status>`. */
const everyStatus = KINDS.flatMap((kind) =>
  STATUSES[kind].map((status, i) =>
    listedItem({ id: `${kind.toUpperCase()}-${String(i + 1).padStart(4, '0')}`, title: `${kind} ${status}`, kind, status }),
  ),
);

describe('overview grouping', () => {
  it('covers exactly the statuses each kind can store', () => {
    for (const kind of KINDS) expect(Object.keys(EXPECTED[kind]).sort()).toEqual([...STATUSES[kind]].sort());
  });

  it.each(KINDS.flatMap((kind) => STATUSES[kind].map((status) => [kind, status] as const)))(
    'puts a %s with status %s in its group',
    (kind, status) => {
      expect(overviewState(kind, status)?.group ?? null).toBe(EXPECTED[kind][status]);
    },
  );

  it('places every item that is not closed in exactly one group and leaves closed items out', () => {
    const groups = groupForOverview(everyStatus);
    const shown = Object.values(groups).flatMap((entries) => entries.map((e) => e.item.id));
    const open = everyStatus.filter((it) => EXPECTED[it.kind][it.status] !== null).map((it) => it.id);
    expect(shown.sort()).toEqual(open.sort());
    for (const item of everyStatus) {
      const group = EXPECTED[item.kind][item.status];
      if (group) expect(groups[group].map((e) => e.item)).toContain(item);
    }
  });

  it('names every shown state in plain words, never the stored value', () => {
    for (const kind of KINDS) {
      for (const status of STATUSES[kind]) {
        const state = overviewState(kind, status);
        if (!state) continue;
        expect(state.word).not.toBe(status);
        expect(state.word).toMatch(/^[A-Z][a-z]*( [a-z]+)*$/);
      }
    }
    expect(overviewState('task', 'in_progress')?.word).toBe('In progress');
  });
});

describe('overview page', () => {
  it('shows open items in plain words under their group and hides closed ones', async () => {
    // The server leaves cancelled, rejected and obsolete items out by default; deferred requirements still arrive.
    const list: ListItemsResult = { total: everyStatus.length, items: everyStatus };
    stubApi(({ method, path }) => {
      if (method === 'GET' && path === '/api/project') return project;
      if (method === 'GET' && path.startsWith('/api/items?')) return list;
      return undefined;
    });
    window.location.hash = '#/overview';
    renderWithProviders(<App />);

    const group = async (name: string) =>
      within((await screen.findByRole('heading', { level: 2, name: new RegExp(`^${name}`) })).closest('section')!);

    const planned = await group('Planned');
    const inProgress = await group('In progress');
    const done = await group('Done');
    expect(planned.getByText('story backlog').nextSibling?.textContent).toBe('Feature · Not started');
    expect(planned.getByText('requirement approved')).toBeTruthy();
    expect(inProgress.getByText('task in_progress').nextSibling?.textContent).toBe('Task · In progress');
    expect(inProgress.getByText('bug review')).toBeTruthy();
    expect(done.getByText('epic done')).toBeTruthy();
    expect(done.getByText('requirement verified')).toBeTruthy();
    for (const title of ['task cancelled', 'epic cancelled', 'requirement deferred', 'requirement rejected', 'requirement obsolete']) {
      expect(screen.queryByText(title)).toBeNull();
    }
    expect(screen.queryByText('in_progress')).toBeNull();
  });
});

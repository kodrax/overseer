// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CLOSED_STATUSES, COVERAGE_STATES, KINDS, PRIORITIES, STATUSES } from '../../src/core/schema.js';
import { coverageFilled, CoverageTrack, StatusBadge, statusStep } from '../../web/src/ds/components';
import { ThemeSwitch } from '../../web/src/ds/theme';
import { BoardPage } from '../../web/src/pages/BoardPage';
import { listedItem, project, renderWithProviders, stubApi } from './harness';

describe('StatusBadge', () => {
  it('shows every status value as stored', () => {
    for (const status of new Set(Object.values(STATUSES).flat())) {
      const { container, unmount } = render(<StatusBadge status={status} />);
      expect(container.textContent).toBe(status);
      unmount();
    }
  });

  it('starts every kind at an empty dot, fills it as work advances and dashes the closed states', () => {
    for (const kind of KINDS) {
      const statuses = STATUSES[kind];
      expect(statusStep(statuses[0]!), `${kind} ${statuses[0]}`).toBe('0');
      const closed = [...CLOSED_STATUSES[kind], ...(kind === 'requirement' ? ['deferred'] : [])];
      for (const status of closed) expect(statusStep(status), `${kind} ${status}`).toBe('closed');
      const open = statuses.filter((s) => !closed.includes(s)).map((s) => Number(statusStep(s)));
      expect(open, kind).toEqual([...open].sort((a, b) => a - b));
      expect(open.at(-1), kind).toBe(100);
    }
  });
});

describe('CoverageTrack', () => {
  it('shows the coverage word as stored and fills one more segment per step from untracked to verified', () => {
    for (const coverage of COVERAGE_STATES) {
      const { container, unmount } = render(<CoverageTrack coverage={coverage} />);
      expect(container.textContent).toBe(coverage);
      unmount();
    }
    expect(['untracked', 'tracked', 'in_progress', 'delivered', 'verified'].map(coverageFilled)).toEqual([0, 1, 2, 3, 4]);
    expect(coverageFilled('not_applicable')).toBe(0);
  });
});

describe('priority marks on board cards', () => {
  it('shows each priority word as stored with a mark of its own shape', async () => {
    const items = PRIORITIES.map((priority, i) => listedItem({ id: `TASK-000${i + 1}`, title: `Card ${priority}`, priority }));
    stubApi(({ method, path }) => (method === 'GET' && path.startsWith('/api/items?') ? { total: items.length, items } : undefined));
    renderWithProviders(<BoardPage project={project} />);

    const shapes = new Set<string>();
    for (const priority of PRIORITIES) {
      const card = (await screen.findByText(`Card ${priority}`)).closest('article')!;
      const mark = within(card as HTMLElement).getByText(priority);
      shapes.add(mark.querySelector('svg')!.innerHTML);
    }
    expect(shapes.size).toBe(PRIORITIES.length);
  });
});

describe('ThemeSwitch', () => {
  it('forces Terminal or Paper on the page, keeps the choice across reloads, and System defers to the OS', () => {
    const { unmount } = render(<ThemeSwitch />);
    const select = screen.getByRole('combobox', { name: 'Theme' });
    fireEvent.change(select, { target: { value: 'light' } });
    expect(document.documentElement.dataset.theme).toBe('light');
    unmount();

    render(<ThemeSwitch />);
    const again = screen.getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement;
    expect(again.value).toBe('light');
    fireEvent.change(again, { target: { value: 'dark' } });
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.change(again, { target: { value: 'system' } });
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

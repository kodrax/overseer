// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardPage } from '../../web/src/pages/BoardPage';
import type { ListItemsResult } from '../../web/src/types';
import { callsTo, DAY_MS, listedItem, project, renderWithProviders, stubApi } from './harness';

const COLUMN_WIDTH = 300;

/** The column element (droppable) around `el`: the nearest ancestor whose header holds an h2. */
function columnOf(el: Element): Element | null {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.querySelector(':scope > div > h2')) return node;
  }
  return null;
}

function column(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name });
  return columnOf(heading) as HTMLElement;
}

/**
 * jsdom does no layout, so every rect is empty and dnd-kit finds no drop target. Lay the columns out side by side,
 * COLUMN_WIDTH apart, and put each card at the top of its column. The drag overlay (position: fixed, outside the
 * columns) gets a card's size; dnd-kit uses it as the collision rect and places it over the dragged card.
 */
function layOutColumns(): void {
  const card = (left: number) => DOMRect.fromRect({ x: left + 10, y: 40, width: COLUMN_WIDTH - 40, height: 60 });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const col = columnOf(this);
    if (!col) return this.closest('[style*="position: fixed"]') ? card(0) : DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    const left = [...col.parentElement!.children].indexOf(col) * COLUMN_WIDTH;
    return col === this ? DOMRect.fromRect({ x: left, y: 0, width: COLUMN_WIDTH - 20, height: 600 }) : card(left);
  });
}

describe('BoardPage', () => {
  let list: ListItemsResult;

  beforeEach(() => {
    list = { total: 0, items: [] };
    stubApi(({ method, path, body }) => {
      if (method === 'GET' && path.startsWith('/api/items?')) return list;
      const patch = /^\/api\/items\/([^/?]+)$/.exec(path);
      if (method === 'PATCH' && patch) {
        // Store the change like the server does, so the refetch after the move returns it.
        const id = decodeURIComponent(patch[1]!);
        list = { ...list, items: list.items.map((it) => (it.id === id ? { ...it, ...(body as object) } : it)) };
        return { item: list.items.find((it) => it.id === id), changed_fields: Object.keys(body as object), warnings: [] };
      }
      return undefined;
    });
  });

  // dnd-kit swallows document clicks until 50 ms after a drop; wait until clicks get through so the next test can click.
  afterEach(async () => {
    await waitFor(() => {
      const seen = vi.fn();
      document.addEventListener('click', seen);
      fireEvent.click(document.body);
      document.removeEventListener('click', seen);
      expect(seen).toHaveBeenCalled();
    });
  });

  it('sends a PATCH with the new status when a card is dragged to another column', async () => {
    list.items = [listedItem({ id: 'TASK-0001', title: 'Drag me', status: 'backlog' })];
    renderWithProviders(<BoardPage project={project} />);
    const card = (await screen.findByText('Drag me')).closest('[aria-roledescription="draggable"]') as HTMLElement;
    layOutColumns();

    const targetIndex = project.enums.statuses.task.indexOf('review');
    const start = { clientX: 140, clientY: 70 };
    fireEvent.pointerDown(card, { ...start, button: 0, isPrimary: true });
    // Past the 5 px activation distance, then over the middle of the Review column.
    fireEvent.pointerMove(document, { clientX: start.clientX + 10, clientY: start.clientY });
    await act(async () => {});
    fireEvent.pointerMove(document, { clientX: start.clientX + targetIndex * COLUMN_WIDTH, clientY: start.clientY + 100 });
    await act(async () => {});
    fireEvent.pointerUp(document, { clientX: start.clientX + targetIndex * COLUMN_WIDTH, clientY: start.clientY + 100 });

    await waitFor(() => expect(callsTo('PATCH', '/api/items/TASK-0001')).toHaveLength(1));
    expect(callsTo('PATCH', '/api/items/TASK-0001')[0]!.body).toEqual({ status: 'review' });
    // The card moves at once (optimistic update) and stays there after the list is refetched.
    await waitFor(() => expect(callsTo('GET', '/api/items')).toHaveLength(2));
    await waitFor(() => expect(within(column('review')).queryByText('Drag me')).not.toBeNull());
    expect(within(column('backlog')).queryByText('Drag me')).toBeNull();
  });

  it('hides done cards older than 30 days until Show all done is ticked', async () => {
    const now = Date.now();
    list.items = [
      listedItem({ id: 'TASK-0001', title: 'Done recently', status: 'done', status_changed_at: new Date(now - 29 * DAY_MS).toISOString() }),
      listedItem({ id: 'TASK-0002', title: 'Done long ago', status: 'done', status_changed_at: new Date(now - 31 * DAY_MS).toISOString() }),
      listedItem({ id: 'TASK-0003', title: 'Old but open', status: 'review', status_changed_at: new Date(now - 90 * DAY_MS).toISOString() }),
    ];
    renderWithProviders(<BoardPage project={project} />);

    const done = await waitFor(() => column('done'));
    expect(within(done).queryByText('Done recently')).not.toBeNull();
    expect(within(done).queryByText('Done long ago')).toBeNull();
    expect(within(done).queryByText('1 done more than 30 days ago hidden')).not.toBeNull();
    expect(within(column('review')).queryByText('Old but open')).not.toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show all done' }));
    expect(within(column('done')).queryByText('Done long ago')).not.toBeNull();
    expect(within(column('done')).queryByText(/days ago hidden/)).toBeNull();
  });
});

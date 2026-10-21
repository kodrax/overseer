// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../web/src/App';
import type { ListItemsResult } from '../../web/src/types';
import { callsTo, FakeEventSource, listedItem, project, renderWithProviders, stubApi } from './harness';

describe('live updates', () => {
  it('refetches the open page when the server sends a changed event', async () => {
    let list: ListItemsResult = { total: 1, items: [listedItem({ id: 'TASK-0001', title: 'Before the change' })] };
    stubApi(({ method, path }) => {
      if (method === 'GET' && path === '/api/project') return project;
      if (method === 'GET' && path.startsWith('/api/items?')) return list;
      return undefined;
    });
    renderWithProviders(<App />);

    await screen.findByText('Before the change');
    expect(FakeEventSource.instances.map((s) => s.url)).toEqual(['/api/events']);
    const source = FakeEventSource.instances[0]!;
    act(() => source.emit('open'));
    await screen.findByText('Live');
    expect(callsTo('GET', '/api/items')).toHaveLength(1);
    expect(callsTo('GET', '/api/project')).toHaveLength(1);

    // Another client (CLI, MCP) changed the database; the board server announces it on /api/events.
    list = { total: 1, items: [listedItem({ id: 'TASK-0001', title: 'After the change' })] };
    act(() => source.emit('changed', JSON.stringify({ data_version: 2 })));

    await screen.findByText('After the change');
    expect(screen.queryByText('Before the change')).toBeNull();
    expect(callsTo('GET', '/api/items')).toHaveLength(2);
    await waitFor(() => expect(callsTo('GET', '/api/project')).toHaveLength(2));
  });

  it('drops the card of an item deleted elsewhere after the changed event', async () => {
    let list: ListItemsResult = {
      total: 2,
      items: [listedItem({ id: 'TASK-0001', title: 'Kept task' }), listedItem({ id: 'TASK-0002', title: 'Deleted task' })],
    };
    stubApi(({ method, path }) => {
      if (method === 'GET' && path === '/api/project') return project;
      if (method === 'GET' && path.startsWith('/api/items?')) return list;
      return undefined;
    });
    renderWithProviders(<App />);

    await screen.findByText('Deleted task');
    const source = FakeEventSource.instances[0]!;
    act(() => source.emit('open'));

    // `overseer delete TASK-0002` (or delete_item) commits; the board server announces the new data_version.
    list = { total: 1, items: [listedItem({ id: 'TASK-0001', title: 'Kept task' })] };
    act(() => source.emit('changed', JSON.stringify({ data_version: 3 })));

    await waitFor(() => expect(screen.queryByText('Deleted task')).toBeNull());
    expect(screen.getByText('Kept task')).toBeTruthy();
  });
});

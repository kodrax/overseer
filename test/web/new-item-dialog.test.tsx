// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewItemDialog } from '../../web/src/NewItemDialog';
import type { CreateItemInput, SimilarMatch } from '../../web/src/types';
import { callsTo, listedItem, project, renderWithProviders, stubApi } from './harness';

const duplicate: SimilarMatch = { id: 'TASK-0007', kind: 'task', title: 'Export the board as CSV', status: 'ready', similarity: 0.93, match: 'duplicate' };
const weak: SimilarMatch = { id: 'TASK-0008', kind: 'task', title: 'Tidy the CLI help', status: 'backlog', similarity: 0.41, match: 'weak' };

describe('NewItemDialog', () => {
  it('shows duplicate hints while typing and creates a possible duplicate only through Create anyway', async () => {
    stubApi(({ method, path, body }) => {
      if (method === 'POST' && path === '/api/similar') return { semantic: true, verdict: 'duplicate', matches: [duplicate, weak] };
      if (method === 'POST' && path === '/api/items') {
        const input = body as CreateItemInput;
        if (!input.allow_duplicate) return { created: false, reason: 'possible_duplicate', candidates: [duplicate] };
        return { created: true, item: listedItem({ id: 'TASK-0009', title: input.title }), warnings: [], similar: [duplicate] };
      }
      return undefined;
    });
    const onClose = vi.fn();
    renderWithProviders(<NewItemDialog project={project} initialKind="task" onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'New item' });

    fireEvent.change(within(dialog).getByRole('textbox', { name: /^Title/ }), { target: { value: 'Export board to CSV' } });

    // Hints come from POST /api/similar after a 400 ms debounce; weak matches are left out.
    const hints = (await within(dialog).findByText('Similar existing items', {}, { timeout: 3000 })).parentElement!;
    expect(within(hints).getByRole('link', { name: 'TASK-0007' })).not.toBeNull();
    expect(within(hints).queryByText('TASK-0008')).toBeNull();
    expect(callsTo('POST', '/api/similar').at(-1)!.body).toMatchObject({ text: 'Export board to CSV', kind: 'task' });
    expect(within(dialog).queryByRole('button', { name: 'Create anyway' })).toBeNull();

    // The server refuses a likely duplicate: nothing is created, the candidates and Create anyway appear.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }));
    const warning = await within(dialog).findByText(/Possible duplicate: nothing was created/);
    expect(within(warning.parentElement!).getByRole('link', { name: 'TASK-0007' })).not.toBeNull();
    expect(callsTo('POST', '/api/items')).toHaveLength(1);
    expect(callsTo('POST', '/api/items')[0]!.body).not.toHaveProperty('allow_duplicate');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create anyway' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(callsTo('POST', '/api/items')).toHaveLength(2);
    expect(callsTo('POST', '/api/items')[1]!.body).toMatchObject({ kind: 'task', title: 'Export board to CSV', allow_duplicate: true });
    expect(window.location.hash).toBe('#/items/TASK-0009');
  });
});

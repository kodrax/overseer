import { describe, expect, it, vi } from 'vitest';
import { MAX_BATCH_ITEMS } from '../src/core/batch.js';
import type { OverseerError } from '../src/core/errors.js';
import type { OverseerService } from '../src/core/service.js';
import { ctx, openService } from './helpers/service.js';
import { tempRepo } from './helpers/tmp.js';

async function seedEpic(service: OverseerService): Promise<string> {
  const result = await service.createItemCompact({ kind: 'epic', title: 'Checkout', description: 'Everything about paying for an order.' }, ctx);
  if (!result.created) throw new Error('seed failed');
  return result.id;
}

async function batchError(service: OverseerService, items: unknown[]): Promise<OverseerError> {
  return (await service.createBatchCompact({ items }, ctx).then(
    () => {
      throw new Error('expected the batch to fail');
    },
    (error: unknown) => error,
  )) as OverseerError;
}

describe('batch create', () => {
  it('creates every entry in one call, resolving keys and stored IDs in parent_id and links (AC1)', async () => {
    const service = openService();
    const epic = await seedEpic(service);
    const result = await service.createBatchCompact(
      {
        items: [
          // The task comes before its story: references may point forward.
          { key: 't1', kind: 'task', title: 'Add the coupon field', description: 'Field on the review step.', parent_id: '@s1', links: [{ rel: 'implements', to: '@r1' }] },
          { key: 's1', kind: 'story', title: 'Pay with a coupon', description: 'As a customer I want to pay with a coupon.', parent_id: epic, links: [{ rel: 'implements', to: '@r1' }] },
          { key: '@r1', kind: 'requirement', req_type: 'functional', title: 'Apply coupons at checkout', description: 'When a coupon is entered, the shop shall subtract its value.' },
          { kind: 'bug', title: 'Coupon total rounds wrong', description: 'Totals are off by one cent.', parent_id: 'epic-1', links: [{ rel: 'affects', to: '@r1' }, { rel: 'relates_to', to: '@s1' }] },
        ],
      },
      ctx,
    );
    expect(result).toMatchObject({
      created: true,
      items: [
        { key: 't1', id: 'TASK-0001', title: 'Add the coupon field', status: 'backlog' },
        { key: 's1', id: 'US-0001', status: 'backlog' },
        { key: 'r1', id: 'REQ-0001', status: 'proposed' },
        { id: 'BUG-0001', status: 'backlog' },
      ],
    });
    expect(result.created && result.items[3]).not.toHaveProperty('key');

    expect(service.getItem('TASK-0001').item.parent_id).toBe('US-0001');
    expect(service.getItem('US-0001').item.parent_id).toBe(epic);
    expect(service.getItem('BUG-0001').item.parent_id).toBe(epic);
    expect(service.links().map(({ src, rel, dst }) => `${src} ${rel} ${dst}`)).toEqual([
      'BUG-0001 affects REQ-0001',
      'BUG-0001 relates_to US-0001',
      'TASK-0001 implements REQ-0001',
      'US-0001 implements REQ-0001',
    ]);
    const requirement = service.getItem('REQ-0001', { history: true });
    // Same defaults as a single create: asked_by falls back to the project's default requester (the git user here).
    expect(requirement.item).toMatchObject({ in_backlog: true, coverage: 'tracked', recorded_via: 'test', asked_by: 'Test User' });
    expect(requirement.history!.map((event) => event.action)).toEqual(['create', 'link', 'update', 'link', 'link']);
    // FTS rows are written with the items; embeddings follow on the next query, as for a single create.
    expect((await service.search('coupon field')).results[0]).toMatchObject({ id: 'TASK-0001' });
  });

  it('accepts at most 50 entries and writes them in one transaction', async () => {
    const service = openService();
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ kind: 'task', title: `Unrelated chore number ${index} ${'x'.repeat(index + 1)}` }));
    expect((await batchError(service, many(MAX_BATCH_ITEMS + 1))).message).toBe('items: Too big: expected array to have <=50 items');
    expect((await batchError(service, [])).message).toBe('items: Too small: expected array to have >=1 items');

    // A failure while writing rolls the whole batch back, IDs included.
    const insertLink = vi.spyOn(service, 'insertLink').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const linked = [
      { key: 'r', kind: 'requirement', req_type: 'functional', title: 'Export orders as CSV' },
      { kind: 'task', title: 'Write the CSV exporter', links: [{ rel: 'implements', to: '@r' }] },
    ];
    await expect(service.createBatch({ items: linked }, ctx)).rejects.toThrow('disk full');
    expect(service.listItems({ include_closed: true }).total).toBe(0);
    insertLink.mockRestore();

    const created = await service.createBatchCompact({ items: many(MAX_BATCH_ITEMS) }, ctx);
    expect(created.created && created.items.map((item) => item.id)).toEqual(Array.from({ length: 50 }, (_, index) => `TASK-${String(index + 1).padStart(4, '0')}`));
  });

  it('validates the whole batch first and lists every problem by index and key, writing nothing (AC2)', async () => {
    const service = openService();
    const epic = await seedEpic(service);
    const error = await batchError(service, [
      { key: 'a', kind: 'requirement', req_type: 'functional', title: 'Alpha', parent_id: '@b' },
      { key: 'b', kind: 'requirement', req_type: 'functional', title: 'Beta', parent_id: '@a' },
      { key: 'c', kind: 'task', titel: 'Typo in the field name' },
      { key: 'd', kind: 'task', title: 'Wrong parent', parent_id: epic },
      { key: 'd', kind: 'story', title: 'Same key again', parent_id: '@nope' },
      { kind: 'task', title: 'Bad link', links: [{ rel: 'implements', to: '@d' }, { rel: 'implements', to: 'a' }] },
      { key: 'e', kind: 'story', title: 'Story under a task', parent_id: '@d', status: 'shipped' },
      { key: 'f', kind: 'requirement', req_type: 'functional', title: 'Self parent', parent_id: '@f' },
      { key: 'bad key!', kind: 'epic', title: 'Odd key', estimate: 3 },
    ]);
    expect(error.code).toBe('INVALID_INPUT');
    const problems = [
      'items[0] (@a): parent_id cycle: @a → @b → @a',
      'items[2] (@c): title: Invalid input: expected string, received undefined',
      'items[2] (@c): input: Unrecognized key: "titel"',
      `items[3] (@d): parent_id: A task can only have a story parent; ${epic} is a epic.`,
      'items[4] (@d): key "@d" is already used by items[3] (@d)',
      'items[4] (@d): parent_id "@nope": no entry of this batch has key "@nope"',
      'items[5]: links[0]: "implements" links story/task → requirement; got task → task (@d).',
      'items[5]: links[1].to "a": No item with id a. Write "@a" to refer to the batch entry with that key.',
      'items[6] (@e): Invalid status "shipped" for story; valid: backlog, ready, in_progress, review, done, cancelled.',
      'items[6] (@e): parent_id: A story can only have a epic parent; @d is a task.',
      'items[7] (@f): parent_id cycle: @f → @f',
      'items[8]: key: key must be 1–64 letters, digits, "_", "." or "-"',
    ];
    expect(error.details).toEqual({ problems });
    expect(error.message).toBe(`Nothing written: ${problems.length} problems in the batch: ${problems.join('; ')}`);
    expect(service.listItems({ include_closed: true }).items.map((item) => item.id)).toEqual([epic]);
    expect(service.links()).toEqual([]);
  });

  it('takes either the single-item fields or items, not both', async () => {
    const service = openService();
    await expect(service.createBatch({ items: [{ kind: 'task', title: 'One' }], kind: 'task', allow_duplicate: true }, ctx)).rejects.toThrow(
      "Pass either one item's fields or items, not both; move kind, allow_duplicate into the items entries.",
    );
  });

  it('checks each entry against the board and the earlier entries; any likely duplicate writes nothing (AC3)', async () => {
    const service = openService();
    await service.createItem({ kind: 'requirement', req_type: 'functional', title: 'Password reset by email', description: 'Forgotten passwords get a mailed link.' }, ctx);
    const items = [
      { key: 'login', kind: 'requirement', req_type: 'functional', title: 'Sign in with a passkey', description: 'Biometric login replaces typed secrets.' },
      { key: 'reset', kind: 'requirement', req_type: 'functional', title: 'Password reset by email', description: 'Forgotten passwords get a mailed link.' },
      { kind: 'requirement', req_type: 'functional', title: 'Sign in with a passkey', description: 'Biometric login replaces typed secrets.' },
      // Same text as the passkey requirement but another kind: entries are compared within their kind, like single creates.
      { kind: 'task', title: 'Sign in with a passkey', description: 'Biometric login replaces typed secrets.' },
    ];
    const refused = await service.createBatchCompact({ items }, ctx);
    expect(refused).toEqual({
      created: false,
      reason: 'possible_duplicate',
      duplicates: [
        { index: 1, key: 'reset', candidates: [{ id: 'REQ-0001', title: 'Password reset by email', similarity: 1, match: 'duplicate' }] },
        { index: 2, candidates: [{ index: 0, key: 'login', title: 'Sign in with a passkey', similarity: 1, match: 'duplicate' }] },
      ],
    });
    expect(service.listItems().total).toBe(1);

    const full = await service.createBatch({ items }, ctx);
    expect(full).toMatchObject({
      created: false,
      duplicates: [
        { index: 1, candidates: [{ id: 'REQ-0001', kind: 'requirement', status: 'proposed', coverage: 'untracked', match: 'duplicate' }] },
        { index: 2, candidates: [{ index: 0, key: 'login', kind: 'requirement', status: 'proposed', match: 'duplicate' }] },
      ],
    });

    const allowed = items.map((item, index) => (index === 1 || index === 2 ? { ...item, allow_duplicate: true } : item));
    const created = await service.createBatchCompact({ items: allowed }, ctx);
    expect(created).toMatchObject({
      created: true,
      items: [
        { key: 'login', id: 'REQ-0002', verdict: 'new', candidates: [] },
        { key: 'reset', id: 'REQ-0003', verdict: 'duplicate', candidates: [{ id: 'REQ-0001', match: 'duplicate' }] },
        { id: 'REQ-0004', verdict: 'duplicate', candidates: [{ id: 'REQ-0002', index: 0, key: 'login', title: 'Sign in with a passkey', similarity: 1, match: 'duplicate' }] },
        { id: 'TASK-0001', verdict: 'new', candidates: [] },
      ],
    });
  });

  it('returns compact entries, or full items with full:true (AC4)', async () => {
    const service = openService();
    const items = [
      { key: 'r', kind: 'requirement', req_type: 'functional', status: 'approved', title: 'Ship orders within a day', description: 'The shop shall ship paid orders.' },
      { kind: 'story', title: 'Track my parcel', description: 'Customers follow their parcel.', links: [{ rel: 'implements', to: '@r' }] },
    ];
    const compact = await service.createBatchCompact({ items }, ctx);
    expect(compact).toEqual({
      created: true,
      items: [
        {
          key: 'r',
          id: 'REQ-0001',
          title: 'Ship orders within a day',
          status: 'approved',
          verdict: 'new',
          candidates: [],
          warnings: [expect.objectContaining({ rule: expect.any(String) })],
        },
        { id: 'US-0001', title: 'Track my parcel', status: 'backlog', verdict: 'new', candidates: [], warnings: [expect.objectContaining({ rule: 'story_format' })] },
      ],
    });

    const full = await service.createBatch(
      { items: items.map((item, index) => ({ ...item, key: `n${index}`, title: `${item.title} again`, allow_duplicate: true, links: item.links?.map((link) => ({ ...link, to: '@n0' })) })) },
      ctx,
    );
    expect(full.created).toBe(true);
    if (!full.created) return;
    expect(full.items.map((entry) => Object.keys(entry).sort())).toEqual([
      ['item', 'key', 'similar', 'warnings'],
      ['item', 'key', 'similar', 'warnings'],
    ]);
    expect(full.items[0]).toMatchObject({ key: 'n0', item: { id: 'REQ-0002', kind: 'requirement', in_backlog: true, coverage: 'tracked' } });
    expect(full.items[1]!.item).toMatchObject({ id: 'US-0002', description: items[1]!.description });
  });

  it('falls back to keyword candidates and verdict unknown without vectors', async () => {
    const service = openService(tempRepo(), null);
    await service.createItem({ kind: 'task', title: 'Rotate the API keys' }, ctx);
    const result = await service.createBatchCompact(
      { items: [{ kind: 'task', title: 'Rotate the API keys' }, { kind: 'task', title: 'Rotate the API keys' }] },
      ctx,
    );
    expect(result).toMatchObject({
      created: true,
      items: [
        { id: 'TASK-0002', verdict: 'unknown', candidates: [{ id: 'TASK-0001', similarity: null, match: null }] },
        { id: 'TASK-0003', verdict: 'unknown', candidates: [{ id: 'TASK-0001', similarity: null, match: null }] },
      ],
    });
  });
});

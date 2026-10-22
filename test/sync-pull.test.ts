import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import type { OverseerService } from '../src/core/service.js';
import { planSync } from '../src/core/sync-plan.js';
import { pullSync, type SyncPullResult } from '../src/core/sync-pull.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { ctx, openService } from './helpers/service.js';
import { tempRepo, tempUserConfig } from './helpers/tmp.js';

/** A GitHub MCP list_issues MinimalIssue of acme/demo. */
const issue = (number: number, title: string, overrides: Record<string, unknown> = {}) => ({
  number,
  title,
  body: `Body of ${number}`,
  state: 'OPEN',
  labels: ['Task'],
  assignees: [],
  milestone: null,
  html_url: `https://github.com/acme/demo/issues/${number}`,
  updated_at: '2026-10-01T10:00:00Z',
  ...overrides,
});

const TABLES = ['items', 'events', 'links', 'sync_outbox', 'item_remote_refs', 'connection_mappings', 'connections', 'tombstones', 'meta', 'counters'];
const dump = (service: OverseerService) => Object.fromEntries(TABLES.map((table) => [table, service.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

const snapshotOf = (service: OverseerService, itemId: string, connectionId = 1) =>
  JSON.parse(String(service.db.prepare('SELECT synced_fields FROM item_remote_refs WHERE item_id = ? AND connection_id = ?').get(itemId, connectionId)!.synced_fields));

const eventsOf = (service: OverseerService, itemId: string, after = 0) =>
  service.db.prepare('SELECT via, action, field, old_value, new_value FROM events WHERE item_id = ? AND rowid > ? ORDER BY rowid').all(itemId, after);

const lastEvent = (service: OverseerService) => Number(service.db.prepare('SELECT max(rowid) AS id FROM events').get()!.id);

/**
 * A GitHub connection with four imported issues and local changes since: a title edit (TASK-0001) and a conflicting
 * title edit (TASK-0002). The listing changes #1's body (pull), #2's labels and assignee (pull), #3's title
 * (conflict, resolved by the source of truth), closes #4 and adds #5, a sub-issue of #2. A second GitLab connection
 * (auto-sync on) is added last.
 */
async function scenario(root = tempRepo()) {
  const service = openService(root);
  const connection = service.connections.add({ host: 'github', repository: 'acme/demo', mcp_server: 'github' });
  const imported = await service.importItems(
    {
      source: 'github',
      repo: 'acme/demo',
      payload: { issues: [issue(1, 'Export the backlog', { body: 'CSV' }), issue(2, 'Dark mode', { labels: ['Feature'] }), issue(3, 'Rename settings'), issue(4, 'Drop the beta flag')] },
    },
    ctx,
  );
  expect(imported.created).toEqual(['TASK-0001', 'US-0001', 'TASK-0002', 'TASK-0003']);
  await service.updateItem({ id: 'TASK-0001', title: 'Export the backlog as CSV' }, ctx);
  await service.updateItem({ id: 'TASK-0002', title: 'Rename the settings page' }, ctx);
  const other = service.connections.add({ host: 'gitlab', repository: 'acme/app' });
  const listing = {
    issues: [
      issue(1, 'Export the backlog', { body: 'CSV and JSON' }),
      issue(2, 'Dark mode', { labels: ['Feature', 'ui'], assignees: ['ana'] }),
      issue(3, 'Rename settings screen'),
      issue(4, 'Drop the beta flag', { state: 'CLOSED', state_reason: 'not_planned' }),
      issue(5, 'Dark mode toggle', { labels: ['Bug', 'in progress'], milestone: 'W4', created_at: '2026-09-30T08:00:00Z', parent: { number: 2 } }),
    ],
  };
  return { service, connection, other, listing, root };
}

describe('sync pull', () => {
  it('applies only the plan pull operations: creates, field updates, snapshot and sync:<host> events (AC1)', async () => {
    const { service, connection, listing } = await scenario();
    const plan = planSync(service, connection.id, listing);
    const before = lastEvent(service);

    const result = pullSync(service, connection.id, listing, ctx);
    expect(result.created).toEqual([{ item_id: 'BUG-0001', external_ref: 'acme/demo#5' }]);
    // Exactly the plan's pull updates, field for field.
    expect(result.updated).toEqual(plan.pull.filter((op) => op.op === 'update').map((op) => ({ item_id: op.item_id, external_ref: op.external_ref, fields: op.fields })));
    expect(result.updated).toEqual([
      { item_id: 'TASK-0001', external_ref: 'acme/demo#1', fields: ['body'] },
      { item_id: 'US-0001', external_ref: 'acme/demo#2', fields: ['labels', 'assignee'] },
      { item_id: 'TASK-0003', external_ref: 'acme/demo#4', fields: ['state'] },
    ]);

    // The local title of TASK-0001 is pending, so only the body is pulled.
    const task1 = service.getItem('TASK-0001').item;
    expect([task1.title, task1.description]).toEqual(['Export the backlog as CSV', 'CSV and JSON']);
    expect(eventsOf(service, 'TASK-0001', before)).toEqual([{ via: 'sync:github', action: 'update', field: 'description', old_value: 'CSV', new_value: 'CSV and JSON' }]);
    const story = service.getItem('US-0001').item;
    expect([story.tags, story.assignee]).toEqual([['Feature', 'ui'], 'ana']);
    // Closed as not planned: cancelled, as import maps it.
    expect(service.getItem('TASK-0003').item.status).toBe('cancelled');
    expect(eventsOf(service, 'TASK-0003', before)).toEqual([{ via: 'sync:github', action: 'status', field: 'status', old_value: 'backlog', new_value: 'cancelled' }]);

    // Created as import creates it: kind and status from the labels, parent from the listing.
    const bug = service.getItem('BUG-0001').item;
    expect(bug).toMatchObject({
      kind: 'bug',
      title: 'Dark mode toggle',
      description: 'Body of 5',
      status: 'in_progress',
      tags: ['Bug', 'in progress'],
      milestone: 'W4',
      parent_id: 'US-0001',
      recorded_via: 'sync:github',
      external_ref: 'github:acme/demo#5',
      external_url: 'https://github.com/acme/demo/issues/5',
      created_at: expect.stringMatching(/^2026-09-30T/),
    });
    expect(eventsOf(service, 'BUG-0001', before).map((event) => [event.via, event.action, event.field])).toEqual([
      ['sync:github', 'import', null],
      ['sync:github', 'update', 'parent_id'],
    ]);

    // Snapshots: every field of the new issue; only the applied fields of the updated ones.
    expect(snapshotOf(service, 'BUG-0001')).toEqual({ title: 'Dark mode toggle', body: 'Body of 5', labels: ['Bug', 'in progress'], state: 'open', assignee: null, milestone: 'W4' });
    expect(snapshotOf(service, 'TASK-0001')).toEqual({ title: 'Export the backlog', body: 'CSV and JSON', labels: ['Task'], state: 'open', assignee: null, milestone: null });
    expect(snapshotOf(service, 'US-0001')).toMatchObject({ labels: ['Feature', 'ui'], assignee: 'ana' });
    expect(snapshotOf(service, 'TASK-0003').state).toBe('closed');
    expect(service.db.prepare('SELECT state FROM item_remote_refs WHERE item_id = ?').get('TASK-0003')!.state).toBe('closed');

    // Nothing is left to pull; the local title edits are still to push (the board wins TASK-0002's conflict).
    const after = planSync(service, connection.id, listing);
    expect(after.pull).toEqual([]);
    expect(after.push.map((op) => `${op.op} ${op.item_id} ${op.fields.join(',')}`)).toEqual(['update TASK-0001 title', 'update TASK-0002 title']);
    service.close();
  });

  it('leaves a conflicting field the board wins untouched, for the push to overwrite (AC2)', async () => {
    const { service, connection, listing } = await scenario();
    const plan = planSync(service, connection.id, listing);
    const before = lastEvent(service);
    const result = pullSync(service, connection.id, listing, ctx);
    expect(result.conflicts).toEqual([]);
    expect(plan.overwritten).toEqual([
      { item_id: 'TASK-0002', external_ref: 'acme/demo#3', field: 'title', winner: 'local', value: 'Rename the settings page', overwritten: 'Rename settings screen' },
    ]);
    expect(service.getItem('TASK-0002').item.title).toBe('Rename the settings page');
    expect(snapshotOf(service, 'TASK-0002').title).toBe('Rename settings');
    expect(eventsOf(service, 'TASK-0002', before)).toEqual([]);
    expect(planSync(service, connection.id, listing).overwritten).toEqual(plan.overwritten);
    service.close();
  });

  it('overwrites a conflicting local field with the issue value when the connection is the source of truth (TASK-0053 AC1)', async () => {
    const { service, connection, listing } = await scenario();
    service.connections.setSourceOfTruth(connection.id);
    const seq = service.outbox.list(connection.id).find((entry) => entry.item_id === 'TASK-0002')!.seq;
    const plan = planSync(service, connection.id, listing);
    expect(plan.ack).toContain(seq);
    expect(plan.push.some((op) => op.item_id === 'TASK-0002')).toBe(false);
    expect(plan.overwritten).toEqual([
      { item_id: 'TASK-0002', external_ref: 'acme/demo#3', field: 'title', winner: 'remote', value: 'Rename settings screen', overwritten: 'Rename the settings page' },
    ]);
    const before = lastEvent(service);

    const result = pullSync(service, connection.id, listing, ctx);
    expect(result.conflicts).toEqual([]);
    expect(result.updated).toContainEqual({ item_id: 'TASK-0002', external_ref: 'acme/demo#3', fields: ['title'] });
    expect(service.getItem('TASK-0002').item.title).toBe('Rename settings screen');
    expect(snapshotOf(service, 'TASK-0002').title).toBe('Rename settings screen');
    expect(eventsOf(service, 'TASK-0002', before)).toEqual([
      { via: 'sync:github', action: 'update', field: 'title', old_value: 'Rename the settings page', new_value: 'Rename settings screen' },
    ]);

    // Applied: nothing left to pull or push for TASK-0002, and its pending entry is still only to acknowledge.
    const after = planSync(service, connection.id, listing);
    expect(after.pull).toEqual([]);
    expect(after.overwritten).toEqual([]);
    expect(after.push.some((op) => op.item_id === 'TASK-0002')).toBe(false);
    expect(after.ack).toContain(seq);
    service.close();
  });

  it('queues the pulled changes for the other connections only (AC3)', async () => {
    const { service, connection, other, listing } = await scenario();
    const own = service.outbox.list(connection.id);
    expect(service.outbox.list(other.id)).toEqual([]);
    pullSync(service, connection.id, listing, ctx);
    expect(service.outbox.list(connection.id)).toEqual(own);
    expect(service.outbox.list(other.id).map((entry) => [entry.item_id, entry.operation, entry.changed_fields])).toEqual([
      ['TASK-0001', 'update', ['description']],
      ['US-0001', 'update', ['tags', 'assignee']],
      ['TASK-0003', 'status', ['status']],
      ['BUG-0001', 'create', []],
    ]);
    service.close();
  });

  it('changes and records nothing when the same listing is applied again (AC4)', async () => {
    const { service, connection, listing } = await scenario();
    pullSync(service, connection.id, listing, ctx);
    const before = dump(service);
    const again = pullSync(service, connection.id, listing, ctx);
    expect(again.created).toEqual([]);
    expect(again.updated).toEqual([]);
    expect(again.conflicts).toEqual([]);
    expect(dump(service)).toEqual(before);
    service.close();
  });

  it('reopens an item whose issue was reopened and keeps the status when the item is already on that side', async () => {
    const service = openService();
    const connection = service.connections.add({ host: 'github', repository: 'acme/demo' });
    await service.importItems({ source: 'github', repo: 'acme/demo', payload: [issue(1, 'Cache avatars', { state: 'CLOSED' }), issue(2, 'Trim logs')] }, ctx);
    expect(service.getItem('TASK-0001').item.status).toBe('done');
    // TASK-0002 moved to done locally, then the push was acknowledged; the issue closes remotely as well.
    await service.updateItem({ id: 'TASK-0002', status: 'done' }, ctx);
    service.outbox.ack(service.outbox.list().map((entry) => entry.seq));

    const result = pullSync(service, connection.id, [issue(1, 'Cache avatars'), issue(2, 'Trim logs', { state: 'CLOSED' })], ctx);
    expect(result.updated.map((entry) => [entry.item_id, entry.fields])).toEqual([
      ['TASK-0001', ['state']],
      ['TASK-0002', ['state']],
    ]);
    const reopened = service.getItem('TASK-0001').item;
    expect([reopened.status, reopened.delivered_at, reopened.external_state]).toEqual(['backlog', null, 'open']);
    expect(service.getItem('TASK-0002').item.status).toBe('done');
    expect(snapshotOf(service, 'TASK-0002').state).toBe('closed');
    service.close();
  });

  it('writes nothing on a listing of the other host or an unknown connection', async () => {
    const { service, connection } = await scenario();
    const before = dump(service);
    expect(() => pullSync(service, connection.id, { items: [], pageInfo: {} }, ctx)).toThrow('The payload is a GitLab response but source is github.');
    expect(() => pullSync(service, 9, [], ctx)).toThrow('No connection with id 9.');
    expect(dump(service)).toEqual(before);
    service.close();
  });
});

async function cli(cwd: string, args: string[], stdin = '') {
  let out = '';
  let err = '';
  const io = {
    stdout: { write: (chunk: string) => (out += chunk) },
    stderr: { write: (chunk: string) => (err += chunk) },
    stdin: Readable.from([stdin]),
  };
  const code = await runCli(args, io, { embedder: new HashEmbedder(), env: { OVERSEER_CONFIG_DIR: tempUserConfig() }, cwd });
  return { code, out, err };
}

describe('sync pull CLI', () => {
  it('prints the result as JSON or text, and nothing changes on the second run (AC1, AC2, AC4)', async () => {
    const { service, listing, root } = await scenario();
    service.close();
    const first = await cli(root, ['sync', 'pull', '1', '-', '--json'], JSON.stringify(listing));
    expect(first.code).toBe(0);
    const result = JSON.parse(first.out) as SyncPullResult;
    expect(Object.keys(result)).toEqual(['created', 'updated', 'conflicts', 'warnings']);
    expect(result.created).toEqual([{ item_id: 'BUG-0001', external_ref: 'acme/demo#5' }]);
    expect(result.updated.map((entry) => entry.item_id)).toEqual(['TASK-0001', 'US-0001', 'TASK-0003']);
    expect(result.conflicts).toEqual([]);

    const second = await cli(root, ['sync', 'pull', '1', '-'], JSON.stringify(listing));
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/^Sync pull for connection 1: 0 created, 0 updated, 0 conflicts left untouched\.\n(?!\nConflicts:)/);
  });

  it('prints created and updated items as a table, and NOT_FOUND for an unknown connection', async () => {
    const { service, listing, root } = await scenario();
    service.close();
    const text = await cli(root, ['sync', 'pull', '1', '-'], JSON.stringify(listing));
    expect(text.out).toMatch(/^Sync pull for connection 1: 1 created, 3 updated, 0 conflicts left untouched\.\n\nOp +Issue +Item +Fields\n-[- ]+\ncreate +acme\/demo#5 +BUG-0001 +-\nupdate +acme\/demo#1 +TASK-0001 +body\n/);
    const unknown = await cli(root, ['sync', 'pull', '9', 'missing.json', '--json']);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.out).error).toEqual({ code: 'NOT_FOUND', message: 'No connection with id 9.' });
  });
});

describe('overseer-sync skill (AC5)', () => {
  it('has a Sync section that fetches every page of the listing and runs sync pull', () => {
    const text = readFileSync(join(import.meta.dirname, '..', 'templates', 'skills', 'overseer-sync', 'SKILL.md'), 'utf8');
    const section = text.slice(text.indexOf('\n## Sync\n'));
    expect(text.indexOf('\n## Sync\n')).toBeGreaterThan(0);
    expect(section).toMatch(/every issue of the repository[^]*pagination[^]*until the last page/);
    expect(section).toContain('overseer sync pull <id> <file> --json');
    expect(section).toMatch(/Pull before pushing/);
  });
});

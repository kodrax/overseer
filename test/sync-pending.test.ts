import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import type { OutboxEntry, SyncPending } from '../src/core/outbox.js';
import type { OverseerService } from '../src/core/service.js';
import type { SyncStatus } from '../src/core/connections.js';
import { startSync } from '../src/core/sync-start.js';
import { createMcpServer } from '../src/mcp/server.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { ctx, openService } from './helpers/service.js';
import { tempDir, tempRepo, tempUserConfig } from './helpers/tmp.js';

const GITHUB: SyncPending = { connection_id: 1, host: 'github', repository: 'acme/demo' };
const GITLAB: SyncPending = { connection_id: 2, host: 'gitlab', repository: 'acme/app' };

const gitlabIssue = (iid: number, title: string) => ({
  external_id: `acme/app#${iid}`,
  url: `https://gitlab.com/acme/app/-/issues/${iid}`,
  title,
  state: 'open',
});

/** Connection 1 github acme/demo, 2 gitlab acme/app, 3 github acme/off; `started` ones start sync with an empty listing. */
function connect(service: OverseerService, started: number[]): void {
  service.connections.add({ host: 'github', repository: 'acme/demo', mcp_server: 'github' });
  service.connections.add({ host: 'gitlab', repository: 'acme/app' });
  service.connections.add({ host: 'github', repository: 'acme/off' });
  for (const id of started) startSync(service, id, [], ctx);
}

/** Acks every pending entry, as a confirmed push would. */
function ackAll(service: OverseerService): void {
  const seqs = service.outbox.list().map((entry) => entry.seq);
  if (seqs.length > 0) service.outbox.ack(seqs);
}

describe('sync_pending in write results', () => {
  it('names each connection with auto-sync on and a started sync that a write queued for, by id (AC1)', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const service = openService();
    const task = (title: string) => service.createItemCompact({ kind: 'task', title, allow_duplicate: true }, ctx);

    // No connection.
    expect(await task('Write the CSV writer')).not.toHaveProperty('sync_pending');

    // Connections with auto-sync on but no sync started: queued, not pending a sync.
    connect(service, []);
    const notStarted = await task('Write the CSV header');
    expect(notStarted).not.toHaveProperty('sync_pending');
    expect(service.outbox.list(1).map((entry) => entry.item_id)).toContain('TASK-0002');

    // Sync started on 3 then auto-sync off there; started on 1 and 2.
    startSync(service, 3, [], ctx);
    service.connections.set(3, { auto_sync: false });
    startSync(service, 1, [], ctx);
    startSync(service, 2, [], ctx);
    const created = await task('Quote the CSV fields');
    expect(created).toMatchObject({ created: true, id: 'TASK-0003', sync_pending: [GITHUB, GITLAB] });
    expect(Object.keys(created).at(-1)).toBe('sync_pending');
    expect((await service.createItem({ kind: 'task', title: 'Escape CSV quotes', allow_duplicate: true }, ctx)).sync_pending).toEqual([GITHUB, GITLAB]);

    // Comment-only and no-op updates queue nothing.
    expect(await service.updateItemCompact({ id: 'TASK-0003', comment: 'Started on the parser.' }, ctx)).toEqual({
      id: 'TASK-0003',
      title: 'Quote the CSV fields',
      status: 'backlog',
      changed_fields: [],
      warnings: expect.any(Array),
    });
    expect(await service.updateItemCompact({ id: 'TASK-0003', title: 'Quote the CSV fields' }, ctx)).not.toHaveProperty('sync_pending');
    expect((await service.updateItemCompact({ id: 'TASK-0003', status: 'in_progress', comment: 'Parser done.' }, ctx)).sync_pending).toEqual([GITHUB, GITLAB]);
    expect((await service.updateItem({ id: 'TASK-0003', priority: 'must' }, ctx)).sync_pending).toEqual([GITHUB, GITLAB]);

    // A link that already exists, or an unlink of a missing link, changes nothing.
    expect(service.link('TASK-0003', 'depends_on', 'TASK-0001', ctx).sync_pending).toEqual([GITHUB, GITLAB]);
    expect(service.link('TASK-0003', 'depends_on', 'TASK-0001', ctx)).not.toHaveProperty('sync_pending');
    expect(service.link('TASK-0003', 'depends_on', 'TASK-0001', ctx, true)).toEqual({ linked: false, src: 'TASK-0003', rel: 'depends_on', dst: 'TASK-0001', sync_pending: [GITHUB, GITLAB] });
    expect(service.link('TASK-0003', 'depends_on', 'TASK-0001', ctx, true)).not.toHaveProperty('sync_pending');
    // Deleting an item whose create was never pushed leaves nothing to push; once pushed, the delete is pending.
    expect(service.deleteItem('TASK-0004', ctx)).not.toHaveProperty('sync_pending');
    ackAll(service);
    expect(service.deleteItem('TASK-0002', ctx).sync_pending).toEqual([GITHUB, GITLAB]);

    // Only connections with auto-sync on count, whatever the entries already pending elsewhere.
    service.connections.set(2, { auto_sync: false });
    expect((await task('Trim CSV whitespace')).sync_pending).toEqual([GITHUB]);
    service.connections.set(1, { auto_sync: false });
    expect(await task('Strip the CSV BOM')).not.toHaveProperty('sync_pending');
    // Nothing was pushed: the entries stay pending, counted by sync status.
    expect(service.connections.status().connections.map(({ id, pending_outbox }) => [id, pending_outbox])).toEqual([
      [1, 2],
      [2, 1],
      [3, 0],
    ]);

    // A likely duplicate writes nothing.
    service.connections.set(1, { auto_sync: true });
    expect(await service.createItemCompact({ kind: 'task', title: 'Strip the CSV BOM' }, ctx)).toEqual({
      created: false,
      reason: 'possible_duplicate',
      verdict: 'duplicate',
      candidates: expect.any(Array),
    });
    expect(fetch).not.toHaveBeenCalled();
    service.close();
  });

  it('gives one sync_pending for a whole batch, import or link, never one per item (AC2)', async () => {
    const service = openService();
    connect(service, [1, 2]);

    const batch = await service.createBatchCompact(
      { items: [{ key: 's', kind: 'story', title: 'As a lead I export the backlog' }, { kind: 'task', title: 'Write the CSV writer', parent_id: '@s' }, { kind: 'bug', title: 'Quotes break the CSV' }] },
      ctx,
    );
    expect(batch).toMatchObject({ created: true, sync_pending: [GITHUB, GITLAB] });
    if (!batch.created) throw new Error('not created');
    for (const entry of batch.items) expect(entry).not.toHaveProperty('sync_pending');
    const full = await service.createBatch({ items: [{ kind: 'task', title: 'Write the CSV header' }] }, ctx);
    expect(full.sync_pending).toEqual([GITHUB, GITLAB]);

    // The imported connection already holds the issues: only the other one waits for a sync.
    const items = [gitlabIssue(1, 'Sidebar overlaps the footer'), gitlabIssue(2, 'Footer hides the links')];
    const imported = await service.importItems({ source: 'gitlab', repo: 'acme/app', items }, ctx);
    expect(imported).toMatchObject({ created: ['TASK-0003', 'TASK-0004'], sync_pending: [GITHUB] });
    expect(await service.importItems({ source: 'gitlab', repo: 'acme/app', items }, ctx)).not.toHaveProperty('sync_pending');
    ackAll(service);
    const deletions = await service.importItems({ source: 'gitlab', repo: 'acme/app', items: [], deleted: ['acme/app#1', 'acme/app#2'] }, ctx);
    expect(deletions).toMatchObject({ deleted: ['TASK-0003', 'TASK-0004'], sync_pending: [GITHUB] });

    const linked = service.link('TASK-0001', 'relates_to', 'BUG-0001', ctx);
    expect(linked).toEqual({ linked: true, src: 'TASK-0001', rel: 'relates_to', dst: 'BUG-0001', sync_pending: [GITHUB, GITLAB] });
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
  return { code, out, err, json: <T = Record<string, unknown>,>(): T => JSON.parse(out) };
}

describe('sync_pending in CLI --json output', () => {
  it('shows it after add, add --batch, update, link, unlink, delete and import, omits it with auto-sync off, and leaves unpushed entries in sync status', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const root = tempDir();
    await cli(root, ['sync', 'connection', 'add', '--host', 'github', '--repo', 'acme/demo', '--json']);
    await cli(root, ['sync', 'connection', 'add', '--host', 'gitlab', '--repo', 'acme/app', '--json']);
    expect((await cli(root, ['add', 'task', '--title', 'Ship the changelog', '--json'])).json()).not.toHaveProperty('sync_pending');
    expect((await cli(root, ['sync', 'start', '1', '-', '--json'], '[]')).code).toBe(0);

    const pending = async (args: string[], stdin?: string) => {
      const result = await cli(root, [...args, '--json'], stdin);
      expect(result.code, result.out + result.err).toBe(0);
      return result.json().sync_pending;
    };
    expect(await pending(['add', 'task', '--title', 'Tag the release commit'])).toEqual([GITHUB]);
    expect(await pending(['add', 'task', '--title', 'Announce the release', '--full'])).toEqual([GITHUB]);
    expect(await pending(['add', '--batch', '-'], JSON.stringify([{ kind: 'task', title: 'Update the docs site' }, { kind: 'task', title: 'Close the milestone' }]))).toEqual([GITHUB]);
    expect(await pending(['update', 'TASK-0002', '--status', 'in_progress'])).toEqual([GITHUB]);
    expect(await pending(['update', 'TASK-0002', '--comment', 'Halfway there.'])).toBeUndefined();
    expect(await pending(['link', 'TASK-0002', 'depends_on', 'TASK-0001'])).toEqual([GITHUB]);
    expect(await pending(['unlink', 'TASK-0002', 'depends_on', 'TASK-0001'])).toEqual([GITHUB]);
    const seqs = (await cli(root, ['sync', 'outbox', '--json'])).json<OutboxEntry[]>().map((entry) => String(entry.seq));
    expect((await cli(root, ['sync', 'outbox', 'ack', ...seqs, '--json'])).code).toBe(0);
    expect(await pending(['delete', 'TASK-0005'])).toEqual([GITHUB]);
    expect(await pending(['import', '-', '--source', 'gitlab', '--repo', 'acme/app'], JSON.stringify([gitlabIssue(7, 'Sidebar overlaps the footer')]))).toEqual([GITHUB]);
    expect(await pending(['import', '-', '--source', 'github', '--repo', 'acme/demo'], JSON.stringify([{ ...gitlabIssue(8, 'Logo is blurry'), external_id: 'acme/demo#8', url: 'https://github.com/acme/demo/issues/8' }]))).toBeUndefined();

    // Nothing pushed (the push failed or never ran): the entries stay pending and sync status counts them.
    const status = (await cli(root, ['sync', 'status', '--json'])).json<SyncStatus>();
    expect(status.connections.find((connection) => connection.id === 1)!.pending_outbox).toBeGreaterThan(0);

    await cli(root, ['sync', 'connection', 'set', '1', '--auto-sync', 'off', '--json']);
    expect(await pending(['add', 'task', '--title', 'Archive the release branch'])).toBeUndefined();
    expect(await pending(['update', 'TASK-0002', '--status', 'review'])).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('sync_pending in MCP tool results', () => {
  const clients: Client[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
  });

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    expect(result.isError ?? false).toBe(false);
    const text = result.content[0]!.type === 'text' ? JSON.parse(result.content[0]!.text) : undefined;
    expect(text).toEqual(result.structuredContent);
    return result.structuredContent as Record<string, unknown>;
  }

  it('adds it to create_item (single, batch, full), update_item, link_items, delete_item and import_items', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const root = tempRepo();
    const setup = openService(root);
    connect(setup, [1, 2]);
    setup.close();
    const server = createMcpServer({ embedder: new HashEmbedder(), cwd: root, env: { OVERSEER_CONFIG_DIR: tempUserConfig() } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    clients.push(client);

    const both = [GITHUB, GITLAB];
    expect((await call(client, 'create_item', { kind: 'task', title: 'Translate the onboarding' })).sync_pending).toEqual(both);
    expect((await call(client, 'create_item', { kind: 'task', title: 'Translate the settings', full: true })).sync_pending).toEqual(both);
    const batch = await call(client, 'create_item', { items: [{ kind: 'task', title: 'Record the demo video' }, { kind: 'task', title: 'Publish the demo video' }] });
    expect(batch.sync_pending).toEqual(both);
    expect((batch.items as object[]).every((entry) => !('sync_pending' in entry))).toBe(true);
    expect((await call(client, 'update_item', { id: 'TASK-0001', status: 'in_progress' })).sync_pending).toEqual(both);
    expect(await call(client, 'update_item', { id: 'TASK-0001', comment: 'Waiting for the copy.' })).not.toHaveProperty('sync_pending');
    expect((await call(client, 'link_items', { src: 'TASK-0002', rel: 'depends_on', dst: 'TASK-0001' })).sync_pending).toEqual(both);
    const store = openService(root);
    ackAll(store);
    store.close();
    expect((await call(client, 'delete_item', { id: 'TASK-0004' })).sync_pending).toEqual(both);
    expect((await call(client, 'import_items', { source: 'gitlab', repo: 'acme/app', items: [gitlabIssue(3, 'Typo on the pricing page')] })).sync_pending).toEqual([GITHUB]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

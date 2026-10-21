import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createBoardApp } from '../src/board/server.js';
import { runCli } from '../src/cli/index.js';
import { isOverseerError } from '../src/core/errors.js';
import type { OutboxEntry } from '../src/core/outbox.js';
import type { OverseerService } from '../src/core/service.js';
import { createMcpServer } from '../src/mcp/server.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { ctx, openService } from './helpers/service.js';
import { tempDir, tempRepo, tempUserConfig } from './helpers/tmp.js';

type Pending = Omit<OutboxEntry, 'seq' | 'created_at'>;

/** Pending entries without seq and time, by seq. */
const pending = (service: OverseerService, connection?: number): Pending[] =>
  service.outbox.list(connection).map(({ seq: _seq, created_at: _at, ...entry }) => entry);

const entry = (connection_id: number, item_id: string, operation: OutboxEntry['operation'], changed_fields: string[] = []): Pending => ({
  connection_id,
  item_id,
  operation,
  changed_fields,
});

/** Acks every pending entry, as a confirmed push would. */
function ackAll(service: OverseerService): void {
  const seqs = service.outbox.list().map((row) => row.seq);
  if (seqs.length > 0) service.outbox.ack(seqs);
}

function failure(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (isOverseerError(error)) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected an OverseerError');
}

async function create(service: OverseerService, input: Record<string, unknown>): Promise<string> {
  const result = await service.createItem({ allow_duplicate: true, ...input }, ctx);
  if (!result.created) throw new Error('not created');
  return result.item.id;
}

const issue = (number: number, title: string, state: 'open' | 'closed' = 'open', repo = 'acme/demo') => ({
  external_id: `${repo}#${number}`,
  url: `https://github.com/${repo}/issues/${number}`,
  title,
  state,
});

describe('sync outbox recording', () => {
  it('records create, update, status, link, unlink and delete for each connection with auto-sync on', async () => {
    const service = openService();
    service.connections.add({ host: 'github', repository: 'acme/demo' });
    service.connections.add({ host: 'gitlab', repository: 'acme/demo' });
    service.connections.set(service.connections.add({ host: 'github', repository: 'acme/off' }).id, { auto_sync: false });

    const req = await create(service, { kind: 'requirement', req_type: 'functional', title: 'Export the backlog as CSV' });
    const task = await create(service, { kind: 'task', title: 'Write the CSV writer' });
    expect(pending(service)).toEqual([entry(1, req, 'create'), entry(2, req, 'create'), entry(1, task, 'create'), entry(2, task, 'create')]);
    ackAll(service);

    await service.updateItem({ id: task, title: 'Write the CSV exporter', priority: 'must' }, ctx);
    expect(pending(service)).toEqual([entry(1, task, 'update', ['title', 'priority']), entry(2, task, 'update', ['title', 'priority'])]);
    ackAll(service);

    await service.updateItem({ id: task, status: 'in_progress' }, ctx);
    expect(pending(service, 2)).toEqual([entry(2, task, 'status', ['status'])]);
    ackAll(service);

    // A link changes the source item's links; `implements` also puts the requirement in the backlog.
    service.link(task, 'implements', req, ctx);
    expect(pending(service, 1)).toEqual([entry(1, task, 'update', ['links']), entry(1, req, 'update', ['in_backlog'])]);
    ackAll(service);

    service.link(task, 'implements', req, ctx, true);
    expect(pending(service, 1)).toEqual([entry(1, task, 'update', ['links'])]);
    ackAll(service);

    // A comment changes no field; an update without changes writes nothing.
    await service.updateItem({ id: task, comment: 'Looks fine', title: 'Write the CSV exporter' }, ctx);
    expect(pending(service)).toEqual([]);

    service.deleteItem(task, ctx);
    expect(pending(service)).toEqual([entry(1, task, 'delete'), entry(2, task, 'delete')]);
    expect(pending(service, 3)).toEqual([]);
    service.close();
  });

  it('keeps one entry per item and connection: fields merged, delete replaces, create then delete leaves nothing', async () => {
    const service = openService();
    service.connections.add({ host: 'github', repository: 'acme/demo' });
    const task = await create(service, { kind: 'task', title: 'Rotate the signing keys' });
    ackAll(service);

    await service.updateItem({ id: task, status: 'in_progress' }, ctx);
    const [first] = service.outbox.list();
    await service.updateItem({ id: task, status: 'review' }, ctx);
    expect(pending(service)).toEqual([entry(1, task, 'status', ['status'])]);
    await service.updateItem({ id: task, description: 'Yearly rotation' }, ctx);
    await service.updateItem({ id: task, status: 'done', description: 'Yearly key rotation' }, ctx);
    expect(pending(service)).toEqual([entry(1, task, 'update', ['status', 'description'])]);
    // A merged entry gets a new seq: the seq read before the latest change is no longer pending.
    const [merged] = service.outbox.list();
    expect(merged!.seq).toBeGreaterThan(first!.seq);
    expect(failure(() => service.outbox.ack([first!.seq])).code).toBe('NOT_FOUND');

    service.deleteItem(task, ctx);
    expect(pending(service)).toEqual([entry(1, task, 'delete')]);

    // A create stays a create whatever follows; a delete before any push removes it.
    const draft = await create(service, { kind: 'task', title: 'Draft the migration guide' });
    await service.updateItem({ id: draft, title: 'Draft the upgrade guide', status: 'in_progress' }, ctx);
    expect(pending(service).filter((row) => row.item_id === draft)).toEqual([entry(1, draft, 'create')]);
    service.deleteItem(draft, ctx);
    expect(pending(service)).toEqual([entry(1, task, 'delete')]);
    service.close();
  });

  it('records the links of the other items a delete unlinks, and nothing when the delete is refused', async () => {
    const service = openService();
    service.connections.add({ host: 'github', repository: 'acme/demo' });
    const story = await create(service, { kind: 'story', title: 'Customers pay by card' });
    const child = await create(service, { kind: 'task', title: 'Add the card form', parent_id: story });
    const other = await create(service, { kind: 'task', title: 'Add the receipt e-mail', links: [{ rel: 'depends_on', to: child }] });
    ackAll(service);

    expect(failure(() => service.deleteItem(story, ctx)).code).toBe('CONFLICT');
    expect(pending(service)).toEqual([]);

    service.deleteItem(child, ctx);
    expect(pending(service)).toEqual([entry(1, other, 'update', ['links']), entry(1, child, 'delete')]);
    service.close();
  });

  it('writes nothing without a connection or with auto-sync off, and starts once auto-sync is on', async () => {
    const service = openService();
    const count = () => Number(service.db.prepare('SELECT count(*) AS n FROM sync_outbox').get()!.n);
    const first = await create(service, { kind: 'task', title: 'Cache the avatars' });
    await service.updateItem({ id: first, status: 'in_progress', title: 'Cache the user avatars' }, ctx);
    await service.createBatch({ items: [{ kind: 'task', title: 'Purge the avatar cache' }] }, ctx);
    await service.importItems({ source: 'github', repo: 'acme/demo', items: [issue(1, 'Avatars load slowly')] }, ctx);
    service.deleteItem(first, ctx);
    expect(count()).toBe(0);

    const { id } = service.connections.add({ host: 'github', repository: 'acme/demo' });
    service.connections.set(id, { auto_sync: false });
    const second = await create(service, { kind: 'task', title: 'Resize uploaded images' });
    await service.updateItem({ id: second, status: 'in_progress' }, ctx);
    expect(count()).toBe(0);

    service.connections.set(id, { auto_sync: true });
    await service.updateItem({ id: second, status: 'review' }, ctx);
    expect(pending(service)).toEqual([entry(id, second, 'status', ['status'])]);
    service.close();
  });

  it('records batch creates with their links for every connection with auto-sync on', async () => {
    const service = openService();
    service.connections.add({ host: 'github', repository: 'acme/demo' });
    service.connections.add({ host: 'gitlab', repository: 'acme/demo' });
    const req = await create(service, { kind: 'requirement', req_type: 'functional', title: 'Search the help center' });
    ackAll(service);

    const result = await service.createBatchCompact(
      {
        items: [
          { key: 'story', kind: 'story', title: 'Readers search the help articles' },
          { key: 'task', kind: 'task', title: 'Index the help articles', parent_id: '@story', links: [{ rel: 'implements', to: req }] },
        ],
      },
      ctx,
    );
    if (!result.created) throw new Error('batch not created');
    const [story, task] = result.items.map((item) => item.id);
    // Each change of a pending create re-queues it with a new seq, so the task (linked after its insert) comes last.
    expect(pending(service, 1)).toEqual([entry(1, story!, 'create'), entry(1, task!, 'create'), entry(1, req, 'update', ['in_backlog'])]);
    expect(pending(service, 2)).toEqual([entry(2, story!, 'create'), entry(2, task!, 'create'), entry(2, req, 'update', ['in_backlog'])]);
    service.close();
  });

  it('records imported changes for the other connections only, none for the imported one', async () => {
    const service = openService();
    const github = service.connections.add({ host: 'github', repository: 'acme/demo' }).id;
    const gitlab = service.connections.add({ host: 'gitlab', repository: 'acme/demo' }).id;

    const first = await service.importItems({ source: 'github', repo: 'Acme/Demo', items: [issue(1, 'Login fails on Safari'), issue(2, 'Add dark mode')] }, ctx);
    const [one, two] = first.created;
    expect(pending(service, github)).toEqual([]);
    expect(pending(service, gitlab)).toEqual([entry(gitlab, one!, 'create'), entry(gitlab, two!, 'create')]);
    ackAll(service);

    const second = await service.importItems(
      { source: 'github', repo: 'acme/demo', items: [issue(1, 'Login fails on Safari 17', 'closed'), issue(2, 'Add dark mode')] },
      ctx,
    );
    expect(second.updated).toEqual([one]);
    expect(pending(service, github)).toEqual([]);
    expect(pending(service, gitlab)).toEqual([entry(gitlab, one!, 'update', ['title', 'status'])]);
    ackAll(service);

    // Issues of a repository without a connection go to every connection with auto-sync on.
    const unconnected = await service.importItems({ source: 'github', repo: 'acme/other', items: [issue(7, 'Broken footer links', 'open', 'acme/other')] }, ctx);
    const [seven] = unconnected.created;
    expect(pending(service)).toEqual([entry(github, seven!, 'create'), entry(gitlab, seven!, 'create')]);
    service.close();
  });

  it('records deletions from an import deleted list for the other connections only, counted by sync status', async () => {
    const service = openService();
    const github = service.connections.add({ host: 'github', repository: 'acme/demo' }).id;
    const gitlab = service.connections.add({ host: 'gitlab', repository: 'acme/demo' }).id;
    const { created } = await service.importItems({ source: 'github', repo: 'acme/demo', items: [issue(1, 'Login fails on Safari'), issue(2, 'Add dark mode')] }, ctx);
    const [one, two] = created;
    ackAll(service);
    await service.updateItem({ id: two!, priority: 'must' }, ctx);

    const removed = await service.importItems({ source: 'github', repo: 'acme/demo', items: [], deleted: ['acme/demo#1', 'acme/demo#2'] }, ctx);
    expect(removed.deleted).toEqual([one, two]);
    // The local priority change of #2 was pending for the imported connection: its delete came from there, so it goes.
    expect(pending(service, github)).toEqual([]);
    expect(pending(service, gitlab)).toEqual([entry(gitlab, one!, 'delete'), entry(gitlab, two!, 'delete')]);
    const counts = service.connections.status().connections.map((connection) => [connection.id, connection.pending_outbox]);
    expect(counts).toEqual([
      [github, 0],
      [gitlab, 2],
    ]);
    service.close();
  });
});

describe('sync outbox list and ack', () => {
  it('lists by connection, acks all or nothing and rejects bad seqs', async () => {
    const service = openService();
    service.connections.add({ host: 'github', repository: 'acme/demo' });
    service.connections.add({ host: 'gitlab', repository: 'acme/demo' });
    await create(service, { kind: 'task', title: 'Archive old invoices' });
    const [a, b] = service.outbox.list();
    expect(service.outbox.list(2)).toEqual([b]);
    expect(service.outbox.list('1')).toEqual([a]);
    expect(failure(() => service.outbox.list(9))).toEqual({ code: 'NOT_FOUND', message: 'No connection with id 9.' });

    expect(failure(() => service.outbox.ack([a!.seq, 98, 99]))).toEqual({
      code: 'NOT_FOUND',
      message: 'No pending outbox entries with seqs 98, 99; nothing was removed.',
    });
    expect(service.outbox.list()).toHaveLength(2);
    expect(failure(() => service.outbox.ack(['x'])).code).toBe('INVALID_INPUT');
    expect(failure(() => service.outbox.ack([])).code).toBe('INVALID_INPUT');
    expect(service.outbox.ack([String(b!.seq), a!.seq, a!.seq])).toEqual({ acked: [a!.seq, b!.seq] });
    expect(service.outbox.list()).toEqual([]);
    expect(failure(() => service.outbox.ack([a!.seq]))).toEqual({ code: 'NOT_FOUND', message: `No pending outbox entry with seq ${a!.seq}; nothing was removed.` });
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
  return { code, out, err, json: <T,>(): T => JSON.parse(out) };
}

describe('sync outbox CLI', () => {
  it('records CLI writes and lists, filters and acks them', async () => {
    const root = tempDir();
    await cli(root, ['sync', 'connection', 'add', '--host', 'github', '--repo', 'acme/demo', '--json']);
    await cli(root, ['sync', 'connection', 'add', '--host', 'gitlab', '--repo', 'acme/demo', '--json']);
    expect((await cli(root, ['sync', 'outbox'])).out.trim()).toBe('No pending outbox entries.');

    expect((await cli(root, ['add', 'task', '--title', 'Ship the changelog', '--json'])).code).toBe(0);
    await cli(root, ['add', 'task', '--title', 'Tag the release commit', '--json']);
    await cli(root, ['update', 'TASK-0001', '--status', 'in_progress', '--json']);
    await cli(root, ['link', 'TASK-0002', 'depends_on', 'TASK-0001', '--json']);
    const all = (await cli(root, ['sync', 'outbox', '--json'])).json<OutboxEntry[]>();
    expect(all.map(({ connection_id, item_id, operation, changed_fields }) => entry(connection_id, item_id, operation, changed_fields))).toEqual([
      entry(1, 'TASK-0001', 'create'),
      entry(2, 'TASK-0001', 'create'),
      entry(1, 'TASK-0002', 'create'),
      entry(2, 'TASK-0002', 'create'),
    ]);
    expect(all[0]).toEqual({ seq: expect.any(Number), connection_id: 1, item_id: 'TASK-0001', operation: 'create', changed_fields: [], created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });

    const one = await cli(root, ['sync', 'outbox', '1', '--json']);
    expect(one.json<OutboxEntry[]>().map((row) => row.item_id)).toEqual(['TASK-0001', 'TASK-0002']);
    const text = await cli(root, ['sync', 'outbox', '2']);
    expect(text.out).toMatch(/Seq +Connection +Item +Operation +Changed fields +Changed at/);
    expect(text.out).toMatch(/TASK-0001 +create/);
    const unknown = await cli(root, ['sync', 'outbox', '9', '--json']);
    expect(unknown.code).toBe(1);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');

    const seqs = all.map((row) => String(row.seq));
    const missing = await cli(root, ['sync', 'outbox', 'ack', seqs[0]!, '999', '--json']);
    expect(missing.code).toBe(1);
    expect(missing.json<{ error: { code: string; message: string } }>().error).toEqual({
      code: 'NOT_FOUND',
      message: 'No pending outbox entry with seq 999; nothing was removed.',
    });
    expect((await cli(root, ['sync', 'outbox', '--json'])).json<OutboxEntry[]>()).toHaveLength(4);

    const acked = await cli(root, ['sync', 'outbox', 'ack', ...seqs, '--json']);
    expect(acked.code).toBe(0);
    expect(acked.json<{ acked: number[] }>()).toEqual({ acked: all.map((row) => row.seq) });

    await cli(root, ['unlink', 'TASK-0002', 'depends_on', 'TASK-0001', '--json']);
    await cli(root, ['update', 'TASK-0001', '--title', 'Ship the release notes', '--status', 'review', '--json']);
    await cli(root, ['delete', 'TASK-0002', '--json']);
    const after = (await cli(root, ['sync', 'outbox', '1', '--json'])).json<OutboxEntry[]>();
    expect(after.map(({ item_id, operation, changed_fields }) => [item_id, operation, changed_fields])).toEqual([
      ['TASK-0001', 'update', ['title', 'status']],
      ['TASK-0002', 'delete', []],
    ]);
    const textAck = await cli(root, ['sync', 'outbox', 'ack', String(after[0]!.seq)]);
    expect(textAck.out.trim()).toBe(`Removed 1 outbox entry: ${after[0]!.seq}.`);
    expect((await cli(root, ['sync', 'outbox', 'ack', 'abc', '--json'])).json<{ error: { code: string } }>().error.code).toBe('INVALID_INPUT');
  });

  it('records batch and import writes from the CLI, skipping the imported connection', async () => {
    const root = tempDir();
    await cli(root, ['sync', 'connection', 'add', '--host', 'github', '--repo', 'acme/demo', '--json']);
    await cli(root, ['sync', 'connection', 'add', '--host', 'gitlab', '--repo', 'acme/demo', '--json']);
    const batch = await cli(root, ['add', '--batch', '-', '--json'], JSON.stringify({ items: [{ kind: 'task', title: 'Rename the settings page' }] }));
    expect(batch.code).toBe(0);
    const imported = await cli(root, ['import', '-', '--source', 'gitlab', '--repo', 'acme/demo', '--json'], JSON.stringify([{ ...issue(4, 'Sidebar overlaps the footer'), url: 'https://gitlab.com/acme/demo/-/issues/4' }]));
    expect(imported.code).toBe(0);
    const rows = (await cli(root, ['sync', 'outbox', '--json'])).json<OutboxEntry[]>();
    expect(rows.map(({ connection_id, item_id, operation }) => [connection_id, item_id, operation])).toEqual([
      [1, 'TASK-0001', 'create'],
      [2, 'TASK-0001', 'create'],
      [1, 'TASK-0002', 'create'],
    ]);
  });
});

describe('sync outbox through MCP and the board', () => {
  const clients: Client[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
  });

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    expect(result.isError ?? false).toBe(false);
    return result.structuredContent as Record<string, unknown>;
  }

  it('records MCP creates (single and batch), updates, links, imports and deletes', async () => {
    const root = tempRepo();
    const setup = openService(root);
    setup.connections.add({ host: 'github', repository: 'acme/demo' });
    setup.connections.add({ host: 'gitlab', repository: 'acme/demo' });
    setup.close();
    const server = createMcpServer({ embedder: new HashEmbedder(), cwd: root, env: { OVERSEER_CONFIG_DIR: tempUserConfig() } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    clients.push(client);

    await call(client, 'create_item', { kind: 'task', title: 'Translate the onboarding' });
    await call(client, 'create_item', { items: [{ kind: 'task', title: 'Record the demo video' }] });
    await call(client, 'import_items', { source: 'github', repo: 'acme/demo', items: [issue(3, 'Typo on the pricing page')] });
    const service = openService(root);
    expect(pending(service)).toEqual([
      entry(1, 'TASK-0001', 'create'),
      entry(2, 'TASK-0001', 'create'),
      entry(1, 'TASK-0002', 'create'),
      entry(2, 'TASK-0002', 'create'),
      entry(2, 'TASK-0003', 'create'),
    ]);
    ackAll(service);

    await call(client, 'update_item', { id: 'TASK-0001', status: 'in_progress', assignee: 'ana' });
    await call(client, 'link_items', { src: 'TASK-0002', rel: 'depends_on', dst: 'TASK-0001' });
    await call(client, 'delete_item', { id: 'TASK-0003' });
    expect(pending(service, 1)).toEqual([entry(1, 'TASK-0001', 'update', ['assignee', 'status']), entry(1, 'TASK-0002', 'update', ['links']), entry(1, 'TASK-0003', 'delete')]);
    expect(pending(service, 2)).toHaveLength(3);
    service.close();
  });

  it('records board creates, updates and links', async () => {
    const service = openService();
    service.connections.add({ host: 'github', repository: 'acme/demo' });
    const webDir = tempDir('ovs-web-');
    writeFileSync(join(webDir, 'index.html'), '<html><head><!--OVERSEER_BOOT--></head><body></body></html>');
    const { app, dispose } = createBoardApp(service, { token: 't', port: () => 4477, webDir, pollMs: 20 });
    const request = (method: string, path: string, body: unknown) =>
      app.request(path, {
        method,
        headers: { host: '127.0.0.1:4477', 'x-overseer-token': 't', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await request('POST', '/api/items', { kind: 'task', title: 'Draw the empty state' })).status).toBe(200);
    expect((await request('POST', '/api/items', { kind: 'task', title: 'Write the 404 copy' })).status).toBe(200);
    ackAll(service);
    expect((await request('PATCH', '/api/items/TASK-0001', { status: 'done' })).status).toBe(200);
    expect((await request('POST', '/api/links', { src: 'TASK-0002', rel: 'depends_on', dst: 'TASK-0001' })).status).toBe(200);
    expect(pending(service)).toEqual([entry(1, 'TASK-0001', 'status', ['status']), entry(1, 'TASK-0002', 'update', ['links'])]);
    dispose();
    service.close();
  });
});

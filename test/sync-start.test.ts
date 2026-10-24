import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { isOverseerError } from '../src/core/errors.js';
import type { OverseerService } from '../src/core/service.js';
import { confirmSync } from '../src/core/sync-confirm.js';
import { planSync } from '../src/core/sync-plan.js';
import { startSync } from '../src/core/sync-start.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { ctx, openService } from './helpers/service.js';
import { tempRepo, tempUserConfig } from './helpers/tmp.js';

function failure(run: () => unknown): { code: string; message: string; details?: unknown } {
  try {
    run();
  } catch (error) {
    if (isOverseerError(error)) return { code: error.code, message: error.message, details: error.details };
    throw error;
  }
  throw new Error('expected an OverseerError');
}

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

const ISSUE = { number: 1, title: 'Existing issue', body: '', state: 'OPEN', labels: [], assignees: [], milestone: null, html_url: 'https://github.com/acme/demo/issues/1' };

const outboxRows = (service: OverseerService) =>
  service.db.prepare('SELECT seq, connection_id, item_id, operation, changed_fields FROM sync_outbox ORDER BY seq').all();

/**
 * A board with every kind, open and closed items (REQ-0002 rejected, EPIC-0001 cancelled, TASK-0002 done), and a
 * GitHub connection with auto-sync off: no outbox entry is pending before the start.
 */
async function board(root = tempRepo()) {
  const service = openService(root);
  const create = (input: Record<string, unknown>) => service.createItem({ ...input, allow_duplicate: true }, ctx);
  await create({ kind: 'requirement', req_type: 'functional', title: 'Export the backlog as CSV' });
  await create({ kind: 'requirement', req_type: 'functional', title: 'Print the board on paper' });
  await create({ kind: 'epic', title: 'Reporting' });
  await create({ kind: 'story', title: 'As a lead I export the backlog' });
  await create({ kind: 'task', title: 'Write the CSV writer' });
  await create({ kind: 'task', title: 'Write the CSV header' });
  await create({ kind: 'bug', title: 'Quotes break the CSV' });
  await service.updateItem({ id: 'REQ-0002', status: 'rejected' }, ctx);
  await service.updateItem({ id: 'EPIC-0001', status: 'cancelled' }, ctx);
  await service.updateItem({ id: 'TASK-0002', status: 'done' }, ctx);
  const github = service.connections.add({ host: 'github', repository: 'acme/demo', mcp_server: 'github' });
  service.connections.set(github.id, { auto_sync: false });
  return { service, github, root };
}

const ALL = ['REQ-0001', 'REQ-0002', 'EPIC-0001', 'US-0001', 'TASK-0001', 'TASK-0002', 'BUG-0001'];

describe('sync start', () => {
  it('queues one create per item of every kind and status, records the start time, and plan then confirm link every item (AC1, AC2)', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { service, github } = await board();
    expect(service.outbox.list(github.id)).toEqual([]);

    const started = startSync(service, github.id, { issues: [] });
    expect(started).toEqual({
      connection: { ...github, auto_sync: false, sync_started_at: started.started_at },
      started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      queued: 7,
      by_kind: { requirement: 2, epic: 1, story: 1, task: 2, bug: 1 },
      next: expect.stringMatching(/^Run sync plan 1 <listing>, run each create op through github .*sync confirm 1 <results>\.$/),
    });
    const entries = service.outbox.list(github.id);
    expect(entries.map((entry) => [entry.item_id, entry.operation, entry.changed_fields])).toEqual(ALL.map((id) => [id, 'create', []]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));
    expect(service.connections.require(github.id).sync_started_at).toBe(started.started_at);

    const plan = planSync(service, github.id, []);
    expect(plan).toMatchObject({ pull: [], conflicts: [], ack: [], overwritten: [] });
    expect(plan.push.map((op) => [op.op, op.item_id, op.issue.state])).toEqual([
      ['create', 'BUG-0001', 'open'],
      ['create', 'EPIC-0001', 'closed'],
      ['create', 'REQ-0001', 'open'],
      ['create', 'REQ-0002', 'closed'],
      ['create', 'TASK-0001', 'open'],
      ['create', 'TASK-0002', 'closed'],
      ['create', 'US-0001', 'open'],
    ]);
    expect(plan.push.every((op) => op.external_ref === null && op.fields.length === 6)).toBe(true);

    const results = plan.push.map((op, index) => ({
      seqs: [op.seq],
      item_id: op.item_id,
      external_id: `acme/demo#${index + 1}`,
      url: `https://github.com/acme/demo/issues/${index + 1}`,
      state: op.issue.state,
      fields: op.fields,
    }));
    expect(confirmSync(service, github.id, results).acked).toEqual(plan.push.map((op) => op.seq).sort((a, b) => a - b));
    expect(service.outbox.list(github.id)).toEqual([]);
    const refs = service.db.prepare('SELECT item_id, external_ref, state FROM item_remote_refs WHERE connection_id = ? ORDER BY external_ref').all(github.id);
    expect(refs).toEqual(results.map((result) => ({ item_id: result.item_id, external_ref: result.external_id, state: result.state })));
    expect(service.getItem('TASK-0002').item).toMatchObject({ external_ref: 'github:acme/demo#6' });
    expect(fetch).not.toHaveBeenCalled();
    service.close();
  });

  it('skips items already linked on the connection and turns a pending update into the create', async () => {
    const { service, github } = await board();
    service.db
      .prepare("INSERT INTO item_remote_refs(item_id, connection_id, external_ref, url, state) VALUES ('BUG-0001', ?, 'acme/demo#9', 'https://github.com/acme/demo/issues/9', 'open')")
      .run(github.id);
    service.connections.set(github.id, { auto_sync: true });
    await service.updateItem({ id: 'TASK-0001', title: 'Write the CSV writer fast' }, ctx);
    await service.createItem({ kind: 'task', title: 'Document the CSV format', allow_duplicate: true }, ctx);
    expect(service.outbox.list(github.id).map((entry) => [entry.item_id, entry.operation])).toEqual([
      ['TASK-0001', 'update'],
      ['TASK-0003', 'create'],
    ]);

    const started = startSync(service, github.id, []);
    expect([started.queued, started.by_kind]).toEqual([7, { requirement: 2, epic: 1, story: 1, task: 3, bug: 0 }]);
    const entries = service.outbox.list(github.id);
    expect(entries.map((entry) => entry.item_id).sort()).toEqual([...ALL.filter((id) => id !== 'BUG-0001'), 'TASK-0003'].sort());
    expect(entries.every((entry) => entry.operation === 'create' && entry.changed_fields.length === 0)).toBe(true);
    expect(planSync(service, github.id, []).push.map((op) => op.op)).toEqual(Array(7).fill('create'));
    service.close();
  });

  it('gives CONFLICT and queues nothing once the sync of the connection has started (AC3)', async () => {
    const { service, github } = await board();
    const { started_at } = startSync(service, github.id, []);
    service.outbox.ack(service.outbox.list(github.id).slice(0, 3).map((entry) => entry.seq));
    const before = outboxRows(service);

    expect(failure(() => startSync(service, github.id, []))).toEqual({
      code: 'CONFLICT',
      message: `Sync of connection 1 (github acme/demo) already started at ${started_at}; nothing was queued.`,
      details: { connection_id: 1, sync_started_at: started_at },
    });
    expect(outboxRows(service)).toEqual(before);
    expect(service.connections.require(github.id).sync_started_at).toBe(started_at);
    service.close();
  });

  it('refuses a listing that has issues and changes nothing', async () => {
    const { service, github } = await board();
    for (const listing of [[ISSUE], { issues: [ISSUE, { ...ISSUE, number: 2 }] }]) {
      const count = Array.isArray(listing) ? 1 : 2;
      expect(failure(() => startSync(service, github.id, listing))).toEqual({
        code: 'INVALID_INPUT',
        message: `github acme/demo already has ${count} issue${count === 1 ? '' : 's'}; sync start currently supports only empty repositories. Nothing was queued.`,
        details: { connection_id: 1, issues: count },
      });
    }
    expect(outboxRows(service)).toEqual([]);
    expect(service.connections.require(github.id).sync_started_at).toBeNull();
    // A GitLab listing for a GitHub connection is not a listing of its issues.
    expect(failure(() => startSync(service, github.id, { items: [], pageInfo: {} })).code).toBe('INVALID_INPUT');
    expect(failure(() => startSync(service, 9, [])).code).toBe('NOT_FOUND');
    service.close();
  });

  it('runs from the CLI with a listing on stdin, in JSON and as text', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { service, root } = await board();
    service.connections.add({ host: 'gitlab', repository: 'acme/app' });
    service.close();

    const text = await cli(root, ['sync', 'start', '2', '-'], JSON.stringify({ items: [], pageInfo: { hasNextPage: false } }));
    expect(text.code).toBe(0);
    expect(text.out).toMatch(
      /^Started sync of connection 2 \(gitlab acme\/app\) at \S+: queued 7 creates \(requirement 2, epic 1, story 1, task 2, bug 1\)\.\nNext: Run sync plan 2 <listing>, run each create op through the connection's MCP server /,
    );
    const json = await cli(root, ['sync', 'start', '1', '-', '--json'], '[]');
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ connection: { id: 1, sync_started_at: expect.any(String) }, queued: 7 });

    const again = await cli(root, ['sync', 'start', '1', '-', '--json'], '[]');
    expect(again.code).toBe(1);
    expect(JSON.parse(again.out).error.code).toBe('CONFLICT');
    const status = await cli(root, ['sync', 'status', '--json']);
    expect(JSON.parse(status.out).connections.map((connection: { pending_outbox: number }) => connection.pending_outbox)).toEqual([7, 7]);

    const unknown = await cli(root, ['sync', 'start', '9', 'missing.json', '--json']);
    expect(JSON.parse(unknown.out).error).toEqual({ code: 'NOT_FOUND', message: 'No connection with id 9.' });
    const bad = await cli(root, ['sync', 'start', '1', '-'], '{not json');
    expect(bad.err).toMatch(/^error: INVALID_INPUT: Listing input is not valid JSON/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

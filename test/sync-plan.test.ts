import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { isOverseerError } from '../src/core/errors.js';
import type { OverseerService } from '../src/core/service.js';
import { planSync, type SyncPlan } from '../src/core/sync-plan.js';
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

const url = (number: number) => `https://github.com/acme/demo/issues/${number}`;

const MAPPING = {
  kind: { task: 'Task', bug: 'Bug' },
  status: { done: 'closed', cancelled: 'closed', in_progress: 'In progress' },
  priority: { must: 'P1', should: 'P2' },
};

function failure(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (isOverseerError(error)) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected an OverseerError');
}

const snapshotOf = (service: OverseerService, itemId: string) =>
  JSON.parse(String(service.db.prepare('SELECT synced_fields FROM item_remote_refs WHERE item_id = ?').get(itemId)!.synced_fields));

/**
 * A GitHub connection with a mapping, six imported issues (#1–#6) and local changes since: a title edit (TASK-0001),
 * a close (BUG-0001), a reopen (BUG-0002), a delete (TASK-0002), a conflicting title edit (TASK-0003), a new story
 * and a pending create whose item already has issue #8 (TASK-0005). The listing has remote changes to #1, #5 and #6,
 * and a new issue #7.
 */
async function scenario(root = tempRepo()) {
  const service = openService(root);
  const connection = service.connections.add({ host: 'github', repository: 'acme/demo', mcp_server: 'github' });
  service.mappings.replace(connection.id, MAPPING);
  const imported = await service.importItems(
    {
      source: 'github',
      repo: 'acme/demo',
      payload: {
        issues: [
          issue(1, 'Export the backlog', { body: 'CSV' }),
          issue(2, 'Login fails', { labels: ['Bug'] }),
          issue(3, 'Old crash', { labels: ['Bug'], state: 'CLOSED' }),
          issue(4, 'Obsolete page'),
          issue(5, 'Rename settings', { labels: [] }),
          issue(6, 'Dark mode'),
        ],
      },
    },
    ctx,
  );
  expect(imported.created).toEqual(['TASK-0001', 'BUG-0001', 'BUG-0002', 'TASK-0002', 'TASK-0003', 'TASK-0004']);
  // The import comes from this connection: nothing is queued for it.
  expect(service.outbox.list(connection.id)).toEqual([]);

  await service.updateItem({ id: 'TASK-0001', title: 'Export the backlog as CSV' }, ctx);
  await service.updateItem({ id: 'BUG-0001', status: 'done' }, ctx);
  await service.updateItem({ id: 'BUG-0002', status: 'in_progress' }, ctx);
  service.deleteItem('TASK-0002', ctx);
  await service.updateItem({ id: 'TASK-0003', title: 'Rename the settings page' }, ctx);
  const story = await service.createItem({ kind: 'story', title: 'Guided onboarding tour', description: 'First-run walkthrough.', allow_duplicate: true }, ctx);
  expect(story.created && story.item.id).toBe('US-0001');
  await service.createItem({ kind: 'task', title: 'Archive old invoices', priority: 'must', allow_duplicate: true }, ctx);
  // A push that opened #8 but was not acknowledged yet (TASK-0018): the create is still pending.
  service.db.prepare("INSERT INTO item_remote_refs(item_id, connection_id, external_ref, url, state) VALUES ('TASK-0005', ?, 'acme/demo#8', ?, 'open')").run(connection.id, url(8));

  const listing = {
    issues: [
      issue(1, 'Export the backlog', { body: 'CSV and JSON' }),
      issue(2, 'Login fails', { labels: ['Bug'] }),
      issue(3, 'Old crash', { labels: ['Bug'], state: 'CLOSED' }),
      issue(4, 'Obsolete page'),
      issue(5, 'Rename settings screen', { labels: [] }),
      issue(6, 'Dark mode', { labels: ['Task', 'ui'], assignees: ['ana'] }),
      issue(7, 'Single sign-on', { labels: ['Bug'], milestone: 'W4' }),
      issue(8, 'Archive old invoices', { labels: [] }),
      { ...issue(9, 'Bump the lockfile'), html_url: 'https://github.com/acme/demo/pull/9', pull_request: {} },
    ],
  };
  return { service, connection, listing, root };
}

const seqOf = (service: OverseerService, itemId: string) => service.outbox.list().find((entry) => entry.item_id === itemId)!.seq;

describe('sync plan', () => {
  it('plans push, pull and conflict operations from the outbox, remote refs, mapping and listing (AC1–AC4)', async () => {
    const { service, connection, listing } = await scenario();
    const seq = (id: string) => seqOf(service, id);
    const plan = planSync(service, connection.id, listing);
    expect(Object.keys(plan)).toEqual(['push', 'pull', 'conflicts', 'warnings']);

    expect(plan.push).toEqual([
      // done maps to the closed state; the mapped kind and priority become labels.
      {
        op: 'close',
        item_id: 'BUG-0001',
        seq: seq('BUG-0001'),
        external_ref: 'acme/demo#2',
        url: url(2),
        fields: ['labels', 'state'],
        issue: { title: 'Login fails', body: 'Body of 2', labels: ['Bug', 'P2'], state: 'closed', assignee: null, milestone: null },
      },
      // in_progress maps to a label; without a state in the mapping, an open status reopens the issue.
      {
        op: 'reopen',
        item_id: 'BUG-0002',
        seq: seq('BUG-0002'),
        external_ref: 'acme/demo#3',
        url: url(3),
        fields: ['labels', 'state'],
        issue: { title: 'Old crash', body: 'Body of 3', labels: ['Bug', 'In progress', 'P2'], state: 'open', assignee: null, milestone: null },
      },
      {
        op: 'update',
        item_id: 'TASK-0001',
        seq: seq('TASK-0001'),
        external_ref: 'acme/demo#1',
        url: url(1),
        fields: ['title'],
        issue: { title: 'Export the backlog as CSV', body: 'CSV', labels: ['P2', 'Task'], state: 'open', assignee: null, milestone: null },
      },
      // A delete closes the issue and leaves its other fields as the listing has them.
      {
        op: 'close',
        item_id: 'TASK-0002',
        seq: seq('TASK-0002'),
        external_ref: 'acme/demo#4',
        url: url(4),
        fields: ['state'],
        issue: { title: 'Obsolete page', body: 'Body of 4', labels: ['Task'], state: 'closed', assignee: null, milestone: null },
      },
      // A pending create whose item already has an issue here updates it (TASK-0018); the empty snapshot hides nothing.
      {
        op: 'update',
        item_id: 'TASK-0005',
        seq: seq('TASK-0005'),
        external_ref: 'acme/demo#8',
        url: url(8),
        fields: ['title', 'body', 'labels', 'assignee', 'milestone'],
        issue: { title: 'Archive old invoices', body: '', labels: ['P1', 'Task'], state: 'open', assignee: null, milestone: null },
      },
      {
        op: 'create',
        item_id: 'US-0001',
        seq: seq('US-0001'),
        external_ref: null,
        url: null,
        fields: ['title', 'body', 'labels', 'state', 'assignee', 'milestone'],
        issue: { title: 'Guided onboarding tour', body: 'First-run walkthrough.', labels: ['P2'], state: 'open', assignee: null, milestone: null },
      },
    ]);

    expect(plan.pull).toEqual([
      // TASK-0001 changed its title locally, the body remotely: the body is pulled.
      {
        op: 'update',
        external_ref: 'acme/demo#1',
        url: url(1),
        item_id: 'TASK-0001',
        fields: ['body'],
        issue: { title: 'Export the backlog', body: 'CSV and JSON', labels: ['Task'], state: 'open', assignee: null, milestone: null },
      },
      {
        op: 'update',
        external_ref: 'acme/demo#6',
        url: url(6),
        item_id: 'TASK-0004',
        fields: ['labels', 'assignee'],
        issue: { title: 'Dark mode', body: 'Body of 6', labels: ['Task', 'ui'], state: 'open', assignee: 'ana', milestone: null },
      },
      {
        op: 'create',
        external_ref: 'acme/demo#7',
        url: url(7),
        item_id: null,
        fields: ['title', 'body', 'labels', 'state', 'assignee', 'milestone'],
        issue: { title: 'Single sign-on', body: 'Body of 7', labels: ['Bug'], state: 'open', assignee: null, milestone: 'W4' },
      },
    ]);

    expect(plan.conflicts).toEqual([
      {
        item_id: 'TASK-0003',
        seq: seq('TASK-0003'),
        external_ref: 'acme/demo#5',
        url: url(5),
        field: 'title',
        local: 'Rename the settings page',
        remote: 'Rename settings screen',
        snapshot: 'Rename settings',
      },
    ]);
    expect(plan.warnings).toEqual([
      'acme/demo#9: pull request skipped.',
      'kind "story" is unmapped on connection 1 (US-0001): no label sent.',
      'status "backlog" is unmapped on connection 1 (TASK-0001, TASK-0005, US-0001): no label sent; the state follows the status.',
    ]);
    service.close();
  });

  it('skips unchanged fields, matching values and fields that are not synced, naming the seq to acknowledge', async () => {
    const service = openService();
    const connection = service.connections.add({ host: 'github', repository: 'acme/demo' });
    service.mappings.replace(connection.id, { status: { done: 'closed' } });
    await service.importItems({ source: 'github', repo: 'acme/demo', payload: [issue(1, 'Write the docs'), issue(2, 'Fix the build'), issue(3, 'Tag the release')] }, ctx);
    // A title edited and edited back; a status change that keeps the state and the labels; a field the issue lacks.
    await service.updateItem({ id: 'TASK-0001', title: 'Write the user docs' }, ctx);
    await service.updateItem({ id: 'TASK-0001', title: 'Write the docs' }, ctx);
    await service.updateItem({ id: 'TASK-0002', status: 'ready' }, ctx);
    await service.updateItem({ id: 'TASK-0003', component: 'release', title: 'Tag the release commit' }, ctx);
    const seq = (id: string) => seqOf(service, id);

    // #1 changed remotely: the local title is back to the snapshot, so the remote title is pulled. #3 holds the
    // same new title on both sides: no conflict and nothing to push or pull for it.
    const plan = planSync(service, connection.id, [issue(1, 'Write the guide'), issue(2, 'Fix the build'), issue(3, 'Tag the release commit')]);
    expect(plan.push).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.pull).toEqual([expect.objectContaining({ op: 'update', item_id: 'TASK-0001', fields: ['title'] })]);
    expect(plan.warnings).toEqual([
      `TASK-0001: nothing to push to connection 1 (acme/demo#1 already matches); outbox seq ${seq('TASK-0001')} can be acknowledged.`,
      `TASK-0002: nothing to push to connection 1 (acme/demo#2 already matches); outbox seq ${seq('TASK-0002')} can be acknowledged.`,
      `TASK-0003: nothing to push to connection 1 (acme/demo#3 already matches); outbox seq ${seq('TASK-0003')} can be acknowledged.`,
    ]);

    service.outbox.ack(service.outbox.list().map((entry) => entry.seq));
    await service.updateItem({ id: 'TASK-0002', component: 'ci' }, ctx);
    expect(planSync(service, connection.id, [issue(2, 'Fix the build')]).warnings).toEqual([
      `TASK-0002: nothing to push to connection 1 (component not synced); outbox seq ${seq('TASK-0002')} can be acknowledged.`,
    ]);
    service.close();
  });

  it('closes nothing for a deleted item the connection has no issue of, or whose issue is closed', async () => {
    const service = openService();
    const connection = service.connections.add({ host: 'github', repository: 'acme/demo' });
    await service.importItems({ source: 'github', repo: 'acme/demo', payload: [issue(1, 'Drop the beta flag')] }, ctx);
    const local = await service.createItem({ kind: 'task', title: 'Draft the FAQ', allow_duplicate: true }, ctx);
    service.outbox.ack(service.outbox.list().map((entry) => entry.seq));
    service.deleteItem('TASK-0001', ctx);
    service.deleteItem(local.created ? local.item.id : '', ctx);
    const [closed, never] = service.outbox.list(connection.id);

    const plan = planSync(service, connection.id, [issue(1, 'Drop the beta flag', { state: 'CLOSED' })]);
    // The deleted item's issue is no pull create.
    expect(plan).toEqual({
      push: [],
      pull: [],
      conflicts: [],
      warnings: [
        `TASK-0001: nothing to push to connection 1 (deleted locally, acme/demo#1 is already closed); outbox seq ${closed!.seq} can be acknowledged.`,
        `TASK-0002: nothing to push to connection 1 (deleted locally, linked to no issue there); outbox seq ${never!.seq} can be acknowledged.`,
      ],
    });
    // Missing from the listing: the close keeps the tombstone's title and leaves the other fields alone.
    expect(planSync(service, connection.id, []).push).toEqual([
      {
        op: 'close',
        item_id: 'TASK-0001',
        seq: closed!.seq,
        external_ref: 'acme/demo#1',
        url: url(1),
        fields: ['state'],
        issue: { title: 'Drop the beta flag', body: null, labels: null, state: 'closed', assignee: null, milestone: null },
      },
    ]);
    service.close();
  });

  it('warns for an issue imported before the connection existed instead of pulling it as new', async () => {
    const service = openService();
    await service.importItems({ source: 'github', repo: 'acme/demo', payload: [issue(1, 'Cache the avatars')] }, ctx);
    const connection = service.connections.add({ host: 'github', repository: 'acme/demo' });
    expect(planSync(service, connection.id, { issues: [issue(1, 'Cache the avatars')] })).toEqual({
      push: [],
      pull: [],
      conflicts: [],
      warnings: ['acme/demo#1: imported as TASK-0001 but not linked to it in connection 1; import the issue again to link it.'],
    });
    service.close();
  });

  it('plans a GitLab connection from list_work_items, which has no bodies', async () => {
    const service = openService();
    const connection = service.connections.add({ host: 'gitlab', repository: 'acme/app' });
    const workItem = (iid: number, title: string, overrides: Record<string, unknown> = {}) => ({
      iid,
      title,
      state: 'OPEN',
      type: 'Task',
      webUrl: `https://gitlab.com/acme/app/-/work_items/${iid}`,
      labels: [],
      ...overrides,
    });
    await service.importItems({ source: 'gitlab', repo: 'acme/app', payload: { items: [workItem(1, 'Split the worker')], pageInfo: {} } }, ctx);
    const plan = planSync(service, connection.id, { items: [workItem(1, 'Split the worker', { state: 'CLOSED' }), workItem(2, 'Retry the upload')], pageInfo: {} });
    expect(plan.pull).toEqual([
      {
        op: 'update',
        external_ref: 'acme/app#1',
        url: 'https://gitlab.com/acme/app/-/work_items/1',
        item_id: 'TASK-0001',
        fields: ['state'],
        issue: { title: 'Split the worker', body: null, labels: [], state: 'closed', assignee: null, milestone: null },
      },
      {
        op: 'create',
        external_ref: 'acme/app#2',
        url: 'https://gitlab.com/acme/app/-/work_items/2',
        item_id: null,
        fields: ['title', 'labels', 'state', 'assignee', 'milestone'],
        issue: { title: 'Retry the upload', body: null, labels: [], state: 'open', assignee: null, milestone: null },
      },
    ]);
    service.close();
  });

  it('rejects a listing of the other host, an unknown format and an unknown connection (AC1)', async () => {
    const service = openService();
    const github = service.connections.add({ host: 'github', repository: 'acme/demo' });
    const gitlab = service.connections.add({ host: 'gitlab', repository: 'acme/demo' });
    expect(failure(() => planSync(service, github.id, { items: [{ iid: 1, title: 'x', state: 'opened' }], pageInfo: {} }))).toEqual({
      code: 'INVALID_INPUT',
      message: 'The payload is a GitLab response but source is github.',
    });
    expect(failure(() => planSync(service, gitlab.id, { issues: [issue(1, 'x')] }))).toEqual({
      code: 'INVALID_INPUT',
      message: 'The payload is a GitHub response but source is gitlab.',
    });
    const unknown = failure(() => planSync(service, github.id, [{ external_id: 'acme/demo#1' }]));
    expect(unknown.code).toBe('INVALID_INPUT');
    expect(unknown.message).toMatch(/^Unrecognized import format; accepted formats: a GitHub MCP list_issues response/);
    expect(failure(() => planSync(service, 9, []))).toEqual({ code: 'NOT_FOUND', message: 'No connection with id 9.' });
    service.close();
  });
});

describe('import snapshot (AC5)', () => {
  it('stores title, body, labels, state, assignee and milestone on the remote ref and keeps a body the listing lacks', async () => {
    const service = openService();
    service.connections.add({ host: 'github', repository: 'acme/demo' });
    await service.importItems(
      { source: 'github', repo: 'acme/demo', payload: [issue(1, 'Speed up search', { labels: ['perf', 'Task', 'perf'], assignees: ['ana', 'bo'], milestone: 'W3', body: null })] },
      ctx,
    );
    expect(snapshotOf(service, 'TASK-0001')).toEqual({ title: 'Speed up search', body: '', labels: ['Task', 'perf'], state: 'open', assignee: 'ana', milestone: 'W3' });
    expect(Object.keys(snapshotOf(service, 'TASK-0001'))).toEqual(['title', 'body', 'labels', 'state', 'assignee', 'milestone']);

    const gitlab = service.connections.add({ host: 'gitlab', repository: 'acme/app' });
    const workItem = (state: string, extra: Record<string, unknown> = {}) => ({
      iid: 4,
      title: 'Split the worker',
      state,
      webUrl: 'https://gitlab.com/acme/app/-/work_items/4',
      labels: [{ title: 'backend' }],
      assignees: [],
      ...extra,
    });
    await service.importItems({ source: 'gitlab', repo: 'acme/app', payload: workItem('opened', { id: 'gid://gitlab/WorkItem/40', description: 'Two queues.' }) }, ctx);
    expect(snapshotOf(service, 'TASK-0002')).toEqual({ title: 'Split the worker', body: 'Two queues.', labels: ['backend'], state: 'open', assignee: null, milestone: null });
    // list_work_items has no description: the snapshot keeps the body from get_work_item.
    await service.importItems({ source: 'gitlab', repo: 'acme/app', payload: { items: [workItem('CLOSED', { milestone: { title: 'W4' } })], pageInfo: {} } }, ctx);
    const row = service.db.prepare('SELECT connection_id, synced_fields FROM item_remote_refs WHERE item_id = ?').get('TASK-0002')!;
    expect(row.connection_id).toBe(gitlab.id);
    expect(JSON.parse(String(row.synced_fields))).toEqual({ title: 'Split the worker', body: 'Two queues.', labels: ['backend'], state: 'closed', assignee: null, milestone: 'W4' });
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

/** Deterministic Fisher–Yates shuffle (mulberry32 seed), so a failure reproduces. */
function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

describe('sync plan CLI', () => {
  it('prints the same bytes for the same state and a shuffled listing, and writes nothing (AC1)', async () => {
    const { service, listing, root } = await scenario();
    const tables = ['items', 'events', 'links', 'sync_outbox', 'item_remote_refs', 'connection_mappings', 'connections', 'tombstones', 'meta', 'counters'];
    const dump = () => Object.fromEntries(tables.map((table) => [table, service.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = dump();
    service.close();

    // A repeated issue (an overlapping page) is resolved the same way whatever the order.
    const issues = [...listing.issues, issue(6, 'Dark mode', { updated_at: '2026-09-01T00:00:00Z' })];
    const first = await cli(root, ['sync', 'plan', '1', '-', '--json'], JSON.stringify({ issues }));
    expect(first.code).toBe(0);
    const plan = JSON.parse(first.out) as SyncPlan;
    expect(plan.push.map((op) => `${op.op} ${op.item_id}`)).toEqual(['close BUG-0001', 'reopen BUG-0002', 'update TASK-0001', 'close TASK-0002', 'update TASK-0005', 'create US-0001']);
    expect(plan.warnings).toContain('acme/demo#6: listed 2 times; the entry updated last was used.');
    for (const seed of [1, 2, 3]) {
      const again = await cli(root, ['sync', 'plan', '1', '-', '--json'], JSON.stringify({ issues: shuffled(issues, seed) }));
      expect(again.out).toBe(first.out);
    }

    const text = await cli(root, ['sync', 'plan', '1', '-'], JSON.stringify({ issues: shuffled(issues, 4) }));
    expect(text.code).toBe(0);
    expect(text.out).toBe((await cli(root, ['sync', 'plan', '1', '-'], JSON.stringify({ issues }))).out);
    expect(text.out).toMatch(/^Sync plan for connection 1: 6 push, 3 pull, 1 conflict\.\n\nPush:\nOp +Item +Issue +Seq +Fields\n/);
    expect(text.out).toMatch(/\ncreate +US-0001 +- +\d+ +title, body, labels, state, assignee, milestone\n/);
    expect(text.out).toMatch(/\nPull:\nOp +Issue +Item +Fields\n[^]*\ncreate +acme\/demo#7 +- +title, body/);
    expect(text.out).toMatch(/\nConflicts:\nItem +Issue +Field +Local +Remote +Snapshot\n-[- ]+\nTASK-0003 +acme\/demo#5 +title +"Rename the settings page" +"Rename settings screen" +"Rename settings"\n/);
    expect(text.out).toMatch(/\nwarning: acme\/demo#9: pull request skipped\.\n/);

    const after = openService(root);
    expect(Object.fromEntries(tables.map((table) => [table, after.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))).toEqual(before);
    after.close();
  });

  it('gives NOT_FOUND for an unknown connection before reading the listing, and INVALID_INPUT for bad JSON', async () => {
    const { service, root } = await scenario();
    service.close();
    const unknown = await cli(root, ['sync', 'plan', '9', 'missing.json', '--json']);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.out).error).toEqual({ code: 'NOT_FOUND', message: 'No connection with id 9.' });
    const bad = await cli(root, ['sync', 'plan', '1', '-'], '{not json');
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/^error: INVALID_INPUT: Listing input is not valid JSON/);
  });
});

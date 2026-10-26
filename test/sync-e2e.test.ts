import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { mapImportPayload } from '../src/core/import.js';
import type { ItemEvent } from '../src/core/schema.js';
import type { ItemDetail } from '../src/core/service.js';
import type { SyncConfirmation } from '../src/core/sync-confirm.js';
import type { SyncPlan } from '../src/core/sync-plan.js';
import type { SyncPullResult } from '../src/core/sync-pull.js';
import { FakeRepository } from './helpers/fake-repo.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { openService } from './helpers/service.js';
import { git, isolateGitConfig, tempRepo, tempUserConfig } from './helpers/tmp.js';

/** One run of the overseer-sync skill's Sync step for a connection: what each command answered. */
interface SyncRound {
  pull: SyncPullResult;
  plan: SyncPlan;
  confirm: SyncConfirmation | null;
}

interface OutboxRow {
  seq: number;
  connection_id: number;
  item_id: string;
  operation: string;
  changed_fields: string[];
}

interface StatusOverwrite {
  step: 'pull' | 'confirm';
  item_id: string;
  external_ref: string;
  field: string;
  winner: 'local' | 'remote';
  value: unknown;
  overwritten: unknown;
  at: string;
}

/** A project driven only through the CLI, as an agent following the skills would. */
class Board {
  readonly root = tempRepo();
  private readonly config = tempUserConfig();

  constructor() {
    openService(this.root).close();
  }

  async run(args: string[], stdin = ''): Promise<{ code: number; out: string; err: string }> {
    let out = '';
    let err = '';
    const io = {
      stdout: { write: (chunk: string) => (out += chunk) },
      stderr: { write: (chunk: string) => (err += chunk) },
      stdin: Readable.from([stdin]),
    };
    const code = await runCli(args, io, { embedder: new HashEmbedder(), env: { OVERSEER_CONFIG_DIR: this.config }, cwd: this.root });
    return { code, out, err };
  }

  /** `overseer <args> --json`, which must succeed; its parsed output (untyped unless `T` is given). */
  async json<T = any>(args: string[], stdin = ''): Promise<T> {
    const { code, out, err } = await this.run([...args, '--json'], stdin);
    expect(code, `overseer ${args.join(' ')}: ${out}${err}`).toBe(0);
    return JSON.parse(out) as T;
  }

  async connect(host: 'github' | 'gitlab', repository: string): Promise<number> {
    return (await this.json<{ id: number }>(['sync', 'connection', 'add', '--host', host, '--repo', repository, '--mcp-server', host])).id;
  }

  plan(connection: number, listing: unknown): Promise<SyncPlan> {
    return this.json<SyncPlan>(['sync', 'plan', String(connection), '-'], JSON.stringify(listing));
  }

  /** The skill's Sync step: listing, sync pull, sync plan, the pushes through the repository, sync confirm, outbox ack. */
  async sync(connection: number, repo: FakeRepository): Promise<SyncRound> {
    const listing = JSON.stringify(repo.listing());
    const pull = await this.json<SyncPullResult>(['sync', 'pull', String(connection), '-'], listing);
    const plan = await this.json<SyncPlan>(['sync', 'plan', String(connection), '-'], listing);
    const results = repo.push(plan.push);
    const confirm = results.length > 0 ? await this.json<SyncConfirmation>(['sync', 'confirm', String(connection), '-'], JSON.stringify(results)) : null;
    if (plan.ack.length > 0) await this.json(['sync', 'outbox', 'ack', ...plan.ack.map(String)]);
    return { pull, plan, confirm };
  }

  /** After a completed sync, a new plan has nothing left to push, pull, acknowledge or resolve. */
  async expectSettled(connection: number, repo: FakeRepository): Promise<void> {
    const plan = await this.plan(connection, repo.listing());
    expect({ push: plan.push, pull: plan.pull, ack: plan.ack, conflicts: plan.conflicts }, `connection ${connection}`).toEqual({ push: [], pull: [], ack: [], conflicts: [] });
  }

  async item(id: string): Promise<ItemDetail['item']> {
    return (await this.json<ItemDetail>(['show', id])).item;
  }

  async history(id: string): Promise<Pick<ItemEvent, 'via' | 'action' | 'field' | 'old_value' | 'new_value'>[]> {
    const detail = await this.json<ItemDetail>(['show', id, '--history']);
    return detail.history!.map(({ via, action, field, old_value, new_value }) => ({ via, action, field, old_value, new_value }));
  }

  async outbox(): Promise<[number, string, string, string[]][]> {
    return (await this.json<OutboxRow[]>(['sync', 'outbox'])).map((entry) => [entry.connection_id, entry.item_id, entry.operation, entry.changed_fields]);
  }

  async overwritten(connection: number): Promise<Omit<StatusOverwrite, 'at'>[]> {
    const status = await this.json<{ connections: { id: number; overwritten: StatusOverwrite[] }[] }>(['sync', 'status']);
    return status.connections.find((entry) => entry.id === connection)!.overwritten.map(({ at, ...entry }) => {
      expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      return entry;
    });
  }
}

/** The synced fields of an issue, to compare with the item. */
const fieldsOf = (repo: FakeRepository, number: number) => {
  const { title, body, labels, state, assignee, milestone } = repo.issue(number);
  return { title, body, labels, state, assignee, milestone };
};

interface TwoRepositories {
  board: Board;
  github: FakeRepository;
  gitlab: FakeRepository;
}

/** A GitHub and a GitLab connection started on empty repositories (GitHub first: the source of truth). */
async function twoRepositories(): Promise<TwoRepositories> {
  const board = new Board();
  const github = new FakeRepository('github', 'acme/demo');
  const gitlab = new FakeRepository('gitlab', 'acme/app');
  expect(await board.connect('github', 'acme/demo')).toBe(1);
  expect(await board.connect('gitlab', 'acme/app')).toBe(2);
  expect(await board.json(['sync', 'start', '1', '-'], JSON.stringify(github.listing()))).toMatchObject({ from: 'board', queued: 0 });
  expect(await board.json(['sync', 'start', '2', '-'], JSON.stringify(gitlab.listing()))).toMatchObject({ from: 'board', queued: 0 });
  expect(await board.json(['sync', 'source-of-truth'])).toMatchObject({ source_of_truth: 1 });
  return { board, github, gitlab };
}

/** Both connections synced in the skill's order (the source of truth first), each left settled. */
async function syncBoth({ board, github, gitlab }: TwoRepositories): Promise<[SyncRound, SyncRound]> {
  const rounds: [SyncRound, SyncRound] = [await board.sync(1, github), await board.sync(2, gitlab)];
  await board.expectSettled(1, github);
  await board.expectSettled(2, gitlab);
  return rounds;
}

describe('fake repository', () => {
  const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'import', name), 'utf8'));
  const keys = (entries: object[]) => new Set(entries.flatMap((entry) => Object.keys(entry)));

  it('renders listings in the shapes of the recorded MCP answers, which the payload adapters map', () => {
    for (const [host, gitlabListing, files, container] of [
      ['github', 'list_issues', ['github-list-issues.json', 'github-list-issues-rest.json'], 'issues'],
      ['gitlab', 'list_issues', ['gitlab-list-issues.json'], null],
      ['gitlab', 'list_work_items', ['gitlab-list-work-items.json'], 'items'],
    ] as const) {
      const repo = new FakeRepository(host, 'acme/demo');
      repo.gitlabListing = gitlabListing;
      repo.open({ title: 'Open', body: 'Text', labels: ['bug'], assignee: 'ana', milestone: 'W4' });
      repo.close(repo.open({ title: 'Closed' }));
      const listing = repo.listing() as Record<string, object[]> | object[];
      const recorded = files.map(fixture);
      // Top-level keys of the MCP answer (GitHub list_issues {issues, totalCount, pageInfo}, GitLab list_work_items
      // {items, pageInfo}); GitLab list_issues answers an array.
      expect(Array.isArray(listing) ? [] : Object.keys(listing)).toEqual(Array.isArray(recorded[0]) ? [] : Object.keys(recorded[0]));
      const entries = (answer: Record<string, object[]> | object[]) => (Array.isArray(answer) ? answer : answer[container!]!);
      const known = keys(recorded.flatMap(entries));
      // MinimalIssue also has state_reason (github-mcp-server pkg/github/minimal_types.go); the fixtures have no closed reason.
      if (host === 'github') known.add('state_reason');
      expect([...keys(entries(listing))].filter((key) => !known.has(key))).toEqual([]);
      const body = gitlabListing === 'list_issues' ? [{ body: 'Text' }, { body: '' }] : [{}, {}];
      expect(mapImportPayload(listing, host, 'acme/demo').items).toEqual([
        expect.objectContaining({ external_id: 'acme/demo#1', url: repo.url(1), title: 'Open', state: 'open', labels: ['bug'], assignees: ['ana'], milestone: 'W4', ...body[0] }),
        expect.objectContaining({ external_id: 'acme/demo#2', url: repo.url(2), title: 'Closed', state: 'closed', labels: [], assignees: [], milestone: null, ...body[1] }),
      ]);
      if (gitlabListing === 'list_work_items') expect(mapImportPayload(listing, host, 'acme/demo').items.map((item) => 'body' in item)).toEqual([false, false]);
    }
  });
});

describe('sync end to end: board to repository (TASK-0025 AC1)', () => {
  it('creates, updates, closes, reopens and on delete closes the issue, whose title the tombstone keeps', async () => {
    const board = new Board();
    const github = new FakeRepository('github', 'acme/demo');
    expect(await board.connect('github', 'acme/demo')).toBe(1);
    await board.json(['sync', 'mapping', 'import', '1', '-'], JSON.stringify({ kind: { task: 'Task' }, priority: { must: 'priority: high' } }));
    expect(await board.json(['sync', 'start', '1', '-'], JSON.stringify(github.listing()))).toMatchObject({ from: 'board', queued: 0 });

    // Create.
    const added = await board.json(['add', 'task', '--title', 'Write the CSV writer', '--description', 'Quote every field.', '--tag', 'csv', '--assignee', 'ana', '--milestone', 'W4']);
    expect(added).toMatchObject({ id: 'TASK-0001', sync_pending: [{ connection_id: 1, host: 'github', repository: 'acme/demo' }] });
    let round = await board.sync(1, github);
    expect(round.plan.push.map((op) => [op.op, op.item_id, op.fields])).toEqual([['create', 'TASK-0001', ['title', 'body', 'labels', 'state', 'assignee', 'milestone']]]);
    expect(github.numbers()).toEqual([1]);
    expect(fieldsOf(github, 1)).toEqual({ title: 'Write the CSV writer', body: 'Quote every field.', labels: ['Task', 'csv'], state: 'open', assignee: 'ana', milestone: 'W4' });
    expect(round.confirm).toMatchObject({ confirmed: [{ item_id: 'TASK-0001', external_id: 'acme/demo#1', url: github.url(1), state: 'open' }], acked: [round.plan.push[0]!.seq] });
    expect(await board.item('TASK-0001')).toMatchObject({ external_ref: 'github:acme/demo#1', external_url: github.url(1) });
    await board.expectSettled(1, github);

    // Update: only the fields the change touches.
    await board.json(['update', 'TASK-0001', '--title', 'Write the CSV writer and reader', '--description', 'Quote and unquote every field.', '--priority', 'must']);
    round = await board.sync(1, github);
    expect(round.plan.push.map((op) => [op.op, op.external_ref, op.fields])).toEqual([['update', 'acme/demo#1', ['title', 'body', 'labels']]]);
    expect(fieldsOf(github, 1)).toEqual({
      title: 'Write the CSV writer and reader',
      body: 'Quote and unquote every field.',
      labels: ['Task', 'csv', 'priority: high'],
      state: 'open',
      assignee: 'ana',
      milestone: 'W4',
    });
    await board.expectSettled(1, github);

    // Close and reopen through the status.
    await board.json(['update', 'TASK-0001', '--status', 'done']);
    round = await board.sync(1, github);
    expect(round.plan.push.map((op) => [op.op, op.fields])).toEqual([['close', ['state']]]);
    expect(github.issue(1)).toMatchObject({ state: 'closed', title: 'Write the CSV writer and reader' });
    await board.expectSettled(1, github);
    await board.json(['update', 'TASK-0001', '--status', 'in_progress']);
    round = await board.sync(1, github);
    expect(round.plan.push.map((op) => [op.op, op.fields])).toEqual([['reopen', ['state']]]);
    expect(github.issue(1).state).toBe('open');
    await board.expectSettled(1, github);

    // Delete: the issue is closed, the tombstone keeps the title.
    const deleted = await board.json(['delete', 'TASK-0001']);
    expect(deleted).toMatchObject({ deleted: true, id: 'TASK-0001', title: 'Write the CSV writer and reader', sync_pending: [{ connection_id: 1 }] });
    // A listing missing the issue (a lost page): the close takes the title from the tombstone and sets the state alone.
    const blind = await board.plan(1, { issues: [] });
    expect(blind.push).toEqual([
      {
        op: 'close',
        item_id: 'TASK-0001',
        seq: expect.any(Number),
        external_ref: 'acme/demo#1',
        url: github.url(1),
        fields: ['state'],
        issue: { title: 'Write the CSV writer and reader', body: null, labels: null, state: 'closed', assignee: null, milestone: null },
      },
    ]);
    round = await board.sync(1, github);
    expect(round.plan.push.map((op) => [op.op, op.item_id, op.fields, op.issue.title])).toEqual([['close', 'TASK-0001', ['state'], 'Write the CSV writer and reader']]);
    expect(round.confirm).toEqual({ connection_id: 1, confirmed: [{ item_id: 'TASK-0001', external_id: 'acme/demo#1', url: github.url(1), state: 'closed', fields: [] }], acked: [round.plan.push[0]!.seq] });
    expect(fieldsOf(github, 1)).toEqual({
      title: 'Write the CSV writer and reader',
      body: 'Quote and unquote every field.',
      labels: ['Task', 'csv', 'priority: high'],
      state: 'closed',
      assignee: 'ana',
      milestone: 'W4',
    });
    const service = openService(board.root);
    expect(service.db.prepare('SELECT item_id, kind, title, external_refs FROM tombstones').all()).toEqual([
      {
        item_id: 'TASK-0001',
        kind: 'task',
        title: 'Write the CSV writer and reader',
        external_refs: JSON.stringify(deleted.external_refs),
      },
    ]);
    service.close();
    expect(deleted.external_refs).toEqual(expect.arrayContaining([expect.objectContaining({ connection_id: 1, external_ref: 'acme/demo#1' })]));
    // The closed issue of the deleted item never comes back as a new item.
    await board.expectSettled(1, github);
    expect(await board.outbox()).toEqual([]);
    expect(github.calls.map((call) => [call.tool, call.args.method, Object.keys(call.args).filter((key) => key !== 'method' && key !== 'number')])).toEqual([
      ['issue_write', 'create', ['title', 'body', 'labels', 'assignees', 'milestone']],
      ['issue_write', 'update', ['title', 'body', 'labels']],
      ['issue_write', 'update', ['state']],
      ['issue_write', 'update', ['state']],
      ['issue_write', 'update', ['state']],
    ]);
  });
});

describe('sync end to end: repository to board (TASK-0025 AC2)', () => {
  it('pulls new, edited, closed and reopened issues, and the import deleted list deletes the item of a removed issue', async () => {
    const board = new Board();
    const github = new FakeRepository('github', 'acme/demo');
    github.open({ title: 'Export the backlog', body: 'CSV.' });
    github.open({ title: 'Dark mode' });
    github.close(github.open({ title: 'Drop the beta flag' }));
    expect(await board.connect('github', 'acme/demo')).toBe(1);
    expect(await board.json(['sync', 'start', '1', '-'], JSON.stringify(github.listing()))).toMatchObject({ from: 'repository', created: 3, queued: 0 });
    expect((await board.json<{ items: { id: string; status: string }[] }>(['list', '--all'])).items.map((item) => [item.id, item.status])).toEqual([
      ['TASK-0001', 'backlog'],
      ['TASK-0002', 'backlog'],
      ['TASK-0003', 'done'],
    ]);
    await board.expectSettled(1, github);

    github.open({ title: 'Login fails on Safari', body: 'Nothing happens.', labels: ['bug'], assignee: 'hubot' });
    github.edit(1, { title: 'Export the backlog as CSV', body: 'CSV with a header.', labels: ['export'], assignee: 'ana', milestone: 'W4' });
    github.close(2);
    github.reopen(3);
    const round = await board.sync(1, github);
    expect(round.pull).toEqual({
      created: [{ item_id: 'BUG-0001', external_ref: 'acme/demo#4' }],
      updated: [
        { item_id: 'TASK-0001', external_ref: 'acme/demo#1', fields: ['title', 'body', 'labels', 'assignee', 'milestone'] },
        { item_id: 'TASK-0002', external_ref: 'acme/demo#2', fields: ['state'] },
        { item_id: 'TASK-0003', external_ref: 'acme/demo#3', fields: ['state'] },
      ],
      conflicts: [],
      warnings: [],
    });
    expect(round.plan.push).toEqual([]);
    expect(await board.item('TASK-0001')).toMatchObject({
      title: 'Export the backlog as CSV',
      description: 'CSV with a header.',
      tags: ['export'],
      assignee: 'ana',
      milestone: 'W4',
      status: 'backlog',
    });
    expect(await board.item('TASK-0002')).toMatchObject({ status: 'done' });
    expect(await board.item('TASK-0003')).toMatchObject({ status: 'backlog' });
    expect(await board.item('BUG-0001')).toMatchObject({ title: 'Login fails on Safari', description: 'Nothing happens.', tags: ['bug'], assignee: 'hubot', external_ref: 'github:acme/demo#4' });
    expect((await board.history('TASK-0002')).at(-1)).toEqual({ via: 'sync:github', action: 'status', field: 'status', old_value: 'backlog', new_value: 'done' });
    // Pulled changes are already in the repository: nothing is queued back for it.
    expect(await board.outbox()).toEqual([]);
    await board.expectSettled(1, github);

    // A deleted issue drops out of the listing; the import deleted list (next to the page, as the import skill does) deletes its item.
    const removed = github.remove(1);
    const imported = await board.json(['import', '-', '--source', 'github', '--repo', 'acme/demo'], JSON.stringify({ ...(github.listing() as object), deleted: [removed] }));
    expect(imported).toMatchObject({ created: [], updated: [], deleted: ['TASK-0001'], warnings: [] });
    const missing = await board.run(['show', 'TASK-0001', '--json']);
    expect(JSON.parse(missing.out).error.code).toBe('NOT_FOUND');
    const again = await board.sync(1, github);
    expect([again.pull.created, again.pull.updated, again.plan.push]).toEqual([[], [], []]);
    expect(await board.outbox()).toEqual([]);
    await board.expectSettled(1, github);
  });

  it('a deletion imported from one repository closes the issue in the other', async () => {
    const repos = await twoRepositories();
    const { board, github, gitlab } = repos;
    await board.json(['add', 'task', '--title', 'Retry uploads']);
    await syncBoth(repos);
    const imported = await board.json(['import', '-', '--source', 'github', '--repo', 'acme/demo'], JSON.stringify({ deleted: [github.remove(1)] }));
    expect(imported).toMatchObject({ deleted: ['TASK-0001'], warnings: [], sync_pending: [{ connection_id: 2 }] });
    expect(await board.outbox()).toEqual([[2, 'TASK-0001', 'delete', []]]);
    const round = await board.sync(2, gitlab);
    expect(round.plan.push.map((op) => [op.op, op.item_id, op.issue.title])).toEqual([['close', 'TASK-0001', 'Retry uploads']]);
    expect(gitlab.issue(1).state).toBe('closed');
    await board.expectSettled(1, github);
    await board.expectSettled(2, gitlab);
  });

  // BUG-0014: import matched issues to items by items.external_ref only. An item pushed to GitHub first keeps
  // external_ref github:…, so the deleted list of its GitLab issue found no item. The connection's remote ref comes first.
  it('the import deleted list of a GitLab issue deletes its item when the item was pushed to GitHub first', async () => {
    const repos = await twoRepositories();
    const { board, gitlab } = repos;
    await board.json(['add', 'task', '--title', 'Retry uploads']);
    await syncBoth(repos);
    const imported = await board.json(['import', '-', '--source', 'gitlab', '--repo', 'acme/app'], JSON.stringify({ deleted: [gitlab.remove(1)] }));
    expect(imported).toMatchObject({ deleted: ['TASK-0001'], warnings: [] });
    expect(await board.outbox()).toEqual([[1, 'TASK-0001', 'delete', []]]);
  });

  // BUG-0014: same cause. Importing the GitLab listing created a second item for every GitLab issue whose item has a
  // GitHub external_ref, queued as a create for GitHub.
  it('importing the GitLab listing links its issues to their items instead of creating duplicates', async () => {
    const repos = await twoRepositories();
    const { board, gitlab } = repos;
    await board.json(['add', 'task', '--title', 'Retry uploads']);
    await syncBoth(repos);
    const imported = await board.json(['import', '-', '--source', 'gitlab', '--repo', 'acme/app'], JSON.stringify(gitlab.listing()));
    expect(imported).toMatchObject({ created: [], warnings: [] });
    expect(await board.outbox()).toEqual([]);

    // An edit in GitLab updates the same item, keeps its GitHub external_ref and goes to GitHub only (no create).
    gitlab.edit(1, { title: 'Retry failed uploads' });
    const updated = await board.json(['import', '-', '--source', 'gitlab', '--repo', 'acme/app'], JSON.stringify(gitlab.listing()));
    expect(updated).toMatchObject({ created: [], updated: ['TASK-0001'], warnings: [] });
    expect(await board.json(['show', 'TASK-0001'])).toMatchObject({ item: { title: 'Retry failed uploads', external_ref: 'github:acme/demo#1' } });
    expect(await board.outbox()).toEqual([[1, 'TASK-0001', 'update', ['title']]]);
    await board.sync(1, repos.github);
    expect(repos.github.issue(1).title).toBe('Retry failed uploads');
    await board.expectSettled(1, repos.github);
    await board.expectSettled(2, gitlab);
  });
});

describe('sync end to end: conflicts (TASK-0025 AC3)', () => {
  it('lets the repository win when it is the source of truth: the pull overwrites the local value, recorded in history and sync status', async () => {
    const board = new Board();
    const github = new FakeRepository('github', 'acme/demo');
    await board.connect('github', 'acme/demo');
    await board.json(['sync', 'start', '1', '-'], JSON.stringify(github.listing()));
    expect(await board.json(['sync', 'source-of-truth'])).toMatchObject({ source_of_truth: 1 });
    await board.json(['add', 'task', '--title', 'Rename settings', '--description', 'Old text.']);
    await board.sync(1, github);

    await board.json(['update', 'TASK-0001', '--title', 'Rename the settings page', '--description', 'New text.']);
    github.edit(1, { title: 'Rename settings screen' });
    const plan = await board.plan(1, github.listing());
    expect(plan.conflicts).toEqual([]);
    expect(plan.overwritten).toEqual([
      { item_id: 'TASK-0001', external_ref: 'acme/demo#1', field: 'title', winner: 'remote', value: 'Rename settings screen', overwritten: 'Rename the settings page' },
    ]);
    expect(plan.pull).toEqual([expect.objectContaining({ op: 'update', item_id: 'TASK-0001', fields: ['title'], overwritten: { title: 'Rename the settings page' } })]);
    // The push sends the description alone and leaves the title the issue won.
    expect(plan.push).toEqual([expect.objectContaining({ op: 'update', fields: ['body'], issue: expect.objectContaining({ title: 'Rename settings screen', body: 'New text.' }) })]);
    expect(plan.push[0]).not.toHaveProperty('overwritten');

    const round = await board.sync(1, github);
    expect(round.pull.conflicts).toEqual([]);
    expect(await board.item('TASK-0001')).toMatchObject({ title: 'Rename settings screen', description: 'New text.' });
    expect(fieldsOf(github, 1)).toMatchObject({ title: 'Rename settings screen', body: 'New text.' });
    expect(await board.history('TASK-0001')).toContainEqual({ via: 'sync:github', action: 'overwrite', field: 'title', old_value: 'Rename the settings page', new_value: 'Rename settings screen' });
    expect(await board.overwritten(1)).toEqual([
      { step: 'pull', item_id: 'TASK-0001', external_ref: 'acme/demo#1', field: 'title', winner: 'remote', value: 'Rename settings screen', overwritten: 'Rename the settings page' },
    ]);
    expect(await board.outbox()).toEqual([]);
    await board.expectSettled(1, github);
  });

  it("brings the source of truth's value to the board and the other repository when all three changed a field", async () => {
    const repos = await twoRepositories();
    const { board, github, gitlab } = repos;
    await board.json(['add', 'task', '--title', 'Retry uploads']);
    await syncBoth(repos);
    await board.json(['update', 'TASK-0001', '--title', 'Retry on the board']);
    github.edit(1, { title: 'Retry on GitHub' });
    gitlab.edit(1, { title: 'Retry on GitLab' });

    // GitHub, the source of truth, first: its value overwrites the local edit, which then goes to GitLab.
    const fromGithub = await board.sync(1, github);
    expect(fromGithub.pull.updated).toEqual([{ item_id: 'TASK-0001', external_ref: 'acme/demo#1', fields: ['title'] }]);
    expect(fromGithub.plan.push).toEqual([]);
    expect(await board.outbox()).toEqual([[2, 'TASK-0001', 'update', ['title']]]);
    const toGitlab = await board.sync(2, gitlab);
    expect(toGitlab.plan.overwritten).toEqual([
      { item_id: 'TASK-0001', external_ref: 'acme/app#1', field: 'title', winner: 'local', value: 'Retry on GitHub', overwritten: 'Retry on GitLab' },
    ]);
    expect([(await board.item('TASK-0001')).title, github.issue(1).title, gitlab.issue(1).title]).toEqual(['Retry on GitHub', 'Retry on GitHub', 'Retry on GitHub']);
    expect((await board.history('TASK-0001')).filter((event) => event.action === 'overwrite')).toEqual([
      { via: 'sync:github', action: 'overwrite', field: 'title', old_value: 'Retry on the board', new_value: 'Retry on GitHub' },
      { via: 'sync:gitlab', action: 'overwrite', field: 'title', old_value: 'Retry on GitLab', new_value: 'Retry on GitHub' },
    ]);
    expect([await board.overwritten(1), await board.overwritten(2)]).toEqual([
      [{ step: 'pull', item_id: 'TASK-0001', external_ref: 'acme/demo#1', field: 'title', winner: 'remote', value: 'Retry on GitHub', overwritten: 'Retry on the board' }],
      [{ step: 'confirm', item_id: 'TASK-0001', external_ref: 'acme/app#1', field: 'title', winner: 'local', value: 'Retry on GitHub', overwritten: 'Retry on GitLab' }],
    ]);
    await board.expectSettled(1, github);
    await board.expectSettled(2, gitlab);
  });

  it('lets the board win when another connection or the board is the source of truth: the push overwrites the issue value', async () => {
    const repos = await twoRepositories();
    const { board, gitlab } = repos;
    await board.json(['add', 'task', '--title', 'Retry uploads']);
    await syncBoth(repos);

    // GitHub (connection 1) is the source of truth; GitLab is planned with the board's value winning.
    await board.json(['update', 'TASK-0001', '--title', 'Retry failed uploads']);
    gitlab.edit(1, { title: 'Retry uploads twice' });
    await board.sync(1, repos.github);
    let plan = await board.plan(2, gitlab.listing());
    expect(plan.conflicts).toEqual([]);
    expect(plan.overwritten).toEqual([
      { item_id: 'TASK-0001', external_ref: 'acme/app#1', field: 'title', winner: 'local', value: 'Retry failed uploads', overwritten: 'Retry uploads twice' },
    ]);
    expect(plan.pull).toEqual([]);
    expect(plan.push).toEqual([expect.objectContaining({ op: 'update', fields: ['title'], overwritten: { title: 'Retry uploads twice' } })]);
    let round = await board.sync(2, gitlab);
    expect(round.confirm?.confirmed).toEqual([expect.objectContaining({ item_id: 'TASK-0001', fields: ['title'] })]);
    expect(gitlab.issue(1).title).toBe('Retry failed uploads');
    expect(await board.item('TASK-0001')).toMatchObject({ title: 'Retry failed uploads' });
    expect((await board.history('TASK-0001')).at(-1)).toEqual({ via: 'sync:gitlab', action: 'overwrite', field: 'title', old_value: 'Retry uploads twice', new_value: 'Retry failed uploads' });
    expect(await board.overwritten(2)).toEqual([
      { step: 'confirm', item_id: 'TASK-0001', external_ref: 'acme/app#1', field: 'title', winner: 'local', value: 'Retry failed uploads', overwritten: 'Retry uploads twice' },
    ]);
    await board.expectSettled(1, repos.github);
    await board.expectSettled(2, gitlab);

    // Removing the source of truth makes the board the source of truth: the board's value still wins.
    expect(await board.json(['sync', 'connection', 'remove', '1'])).toMatchObject({ source_of_truth_reset: true });
    expect(await board.json(['sync', 'source-of-truth'])).toMatchObject({ source_of_truth: 'board' });
    await board.json(['update', 'TASK-0001', '--milestone', 'W5', '--assignee', 'ana']);
    gitlab.edit(1, { milestone: 'W6' });
    plan = await board.plan(2, gitlab.listing());
    expect([plan.conflicts, plan.pull]).toEqual([[], []]);
    expect(plan.overwritten).toEqual([{ item_id: 'TASK-0001', external_ref: 'acme/app#1', field: 'milestone', winner: 'local', value: 'W5', overwritten: 'W6' }]);
    round = await board.sync(2, gitlab);
    expect(round.plan.push).toEqual([expect.objectContaining({ fields: ['assignee', 'milestone'], overwritten: { milestone: 'W6' } })]);
    expect(fieldsOf(gitlab, 1)).toMatchObject({ assignee: 'ana', milestone: 'W5' });
    expect((await board.history('TASK-0001')).at(-1)).toEqual({ via: 'sync:gitlab', action: 'overwrite', field: 'milestone', old_value: 'W6', new_value: 'W5' });
    expect(await board.overwritten(2)).toEqual([
      { step: 'confirm', item_id: 'TASK-0001', external_ref: 'acme/app#1', field: 'milestone', winner: 'local', value: 'W5', overwritten: 'W6' },
    ]);
    await board.expectSettled(2, gitlab);
  });
});

describe('sync end to end: one item on a GitHub and a GitLab connection (TASK-0025 AC4)', () => {
  beforeEach(isolateGitConfig);
  afterEach(() => vi.unstubAllEnvs());

  it('pushes local changes to both, queues a pulled change for the other connection only, and pr draft closes on the PR host', async () => {
    const repos = await twoRepositories();
    const { board, github, gitlab } = repos;
    const added = await board.json(['add', 'task', '--title', 'Retry uploads', '--description', 'Three times.']);
    expect(added.sync_pending.map((entry: { connection_id: number }) => entry.connection_id)).toEqual([1, 2]);
    const [first, second] = await syncBoth(repos);
    expect([first.plan.push.map((op) => op.op), second.plan.push.map((op) => op.op)]).toEqual([['create'], ['create']]);
    expect([fieldsOf(github, 1), fieldsOf(gitlab, 1)]).toEqual([
      { title: 'Retry uploads', body: 'Three times.', labels: [], state: 'open', assignee: null, milestone: null },
      { title: 'Retry uploads', body: 'Three times.', labels: [], state: 'open', assignee: null, milestone: null },
    ]);

    // A local change goes to both.
    const updated = await board.json(['update', 'TASK-0001', '--title', 'Retry failed uploads', '--tag', 'upload']);
    expect(updated.sync_pending.map((entry: { connection_id: number }) => entry.connection_id)).toEqual([1, 2]);
    expect(await board.outbox()).toEqual([
      [1, 'TASK-0001', 'update', ['title', 'tags']],
      [2, 'TASK-0001', 'update', ['title', 'tags']],
    ]);
    const [toGithub, toGitlab] = await syncBoth(repos);
    for (const round of [toGithub, toGitlab]) expect(round.plan.push.map((op) => [op.op, op.fields])).toEqual([['update', ['title', 'labels']]]);
    expect([github.issue(1), gitlab.issue(1)]).toEqual([
      expect.objectContaining({ title: 'Retry failed uploads', labels: ['upload'] }),
      expect.objectContaining({ title: 'Retry failed uploads', labels: ['upload'] }),
    ]);

    // A change pulled from GitHub is queued for GitLab, not for GitHub.
    github.edit(1, { title: 'Retry failed uploads with backoff' });
    const fromGithub = await board.sync(1, github);
    expect(fromGithub.pull.updated).toEqual([{ item_id: 'TASK-0001', external_ref: 'acme/demo#1', fields: ['title'] }]);
    expect(fromGithub.plan.push).toEqual([]);
    expect(await board.outbox()).toEqual([[2, 'TASK-0001', 'update', ['title']]]);
    await board.sync(2, gitlab);
    expect(gitlab.issue(1).title).toBe('Retry failed uploads with backoff');

    // A change pulled from GitLab is queued for GitHub, not for GitLab.
    gitlab.edit(1, { labels: ['upload', 'network'], assignee: 'ana' });
    const fromGitlab = await board.sync(2, gitlab);
    expect(fromGitlab.pull.updated).toEqual([{ item_id: 'TASK-0001', external_ref: 'acme/app#1', fields: ['labels', 'assignee'] }]);
    expect(await board.outbox()).toEqual([[1, 'TASK-0001', 'update', ['tags', 'assignee']]]);
    await board.sync(1, github);
    expect(fieldsOf(github, 1)).toMatchObject({ labels: ['network', 'upload'], assignee: 'ana' });
    await board.expectSettled(1, github);
    await board.expectSettled(2, gitlab);

    // pr draft closes the issue on the pull request's host and names the other.
    git(board.root, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git');
    const onGithub = await board.json<{ body: string }>(['pr', 'draft', 'TASK-0001']);
    expect(onGithub.body).toContain(`Item: TASK-0001\nCloses acme/demo#1\nAlso tracked in GitLab: ${gitlab.url(1)}\n`);
    expect(onGithub.body).not.toMatch(/(closes|fixes|resolves) acme\/app/i);
    git(board.root, 'remote', 'set-url', 'origin', 'https://gitlab.com/acme/app.git');
    const onGitlab = await board.json<{ body: string }>(['pr', 'draft', 'TASK-0001']);
    expect(onGitlab.body).toContain(`Item: TASK-0001\nCloses acme/app#1\nAlso tracked in GitHub: ${github.url(1)}\n`);
    expect(onGitlab.body).not.toMatch(/(closes|fixes|resolves) acme\/demo/i);
    // Issue references of either repository resolve to the item.
    for (const ref of ['acme/demo#1', github.url(1), 'gitlab:acme/app#1', gitlab.url(1)]) expect((await board.item(ref)).id).toBe('TASK-0001');

    // A delete closes the issue on both.
    await board.json(['delete', 'TASK-0001']);
    const closes = await syncBoth(repos);
    for (const round of closes) expect(round.plan.push.map((op) => [op.op, op.item_id, op.issue.title])).toEqual([['close', 'TASK-0001', 'Retry failed uploads with backoff']]);
    expect([github.issue(1).state, gitlab.issue(1).state]).toEqual(['closed', 'closed']);
    expect(await board.outbox()).toEqual([]);
  });

  // BUG-0015: sync pull stored the issue's labels as tags as they were, mapped kind, priority and status labels of the
  // pulled connection included, and the other connection's push sent them: GitHub's kind label "Task" landed on the
  // GitLab issue next to "type::task". A pulled connection's mapped labels are no tags.
  it("a label GitHub's mapping gives the kind does not reach the GitLab issue through pulled tags (BUG-0015)", async () => {
    const repos = await twoRepositories();
    const { board, github, gitlab } = repos;
    await board.json(['sync', 'mapping', 'import', '1', '-'], JSON.stringify({ kind: { task: 'Task' } }));
    await board.json(['sync', 'mapping', 'import', '2', '-'], JSON.stringify({ kind: { task: 'type::task' } }));
    await board.json(['add', 'task', '--title', 'Retry uploads']);
    await syncBoth(repos);
    expect([github.issue(1).labels, gitlab.issue(1).labels]).toEqual([['Task'], ['type::task']]);
    github.edit(1, { labels: ['Task', 'ui'] });
    await syncBoth(repos);
    expect(gitlab.issue(1).labels).toEqual(['type::task', 'ui']);
  });
});

// BUG-0017: issues reaching the board took neither priority nor a mapped status from their labels (priority "should",
// a closed issue labelled "wontfix" "done") and kept the mapped labels as tags; the next push touching labels then
// replaced the issue's priority label with "priority: should".
describe("sync end to end: labels the connection's mapping names become fields (BUG-0017)", () => {
  const mapping = {
    kind: { story: 'type: user-facing' },
    status: { in_progress: 'status: in progress', cancelled: 'wontfix' },
    priority: { must: 'priority: must', should: 'priority: should', could: 'priority: could' },
  };
  const fieldsOfItem = async (board: Board, id: string) => {
    const { kind, priority, status, tags } = await board.item(id);
    return { kind, priority, status, tags };
  };

  it('a pull creates items with the kind, priority and status their mapped labels name, and a later push keeps the priority label', async () => {
    const board = new Board();
    const github = new FakeRepository('github', 'acme/demo');
    await board.connect('github', 'acme/demo');
    await board.json(['sync', 'mapping', 'import', '1', '-'], JSON.stringify(mapping));
    expect(await board.json(['sync', 'start', '1', '-'], JSON.stringify(github.listing()))).toMatchObject({ from: 'board', queued: 0 });
    github.open({ title: 'Retry uploads', labels: ['priority: could', 'ui'] });
    // Closed as completed (GitHub's list_issues has no close reason): the label mapped to cancelled tells.
    github.close(github.open({ title: 'Drop the beta flag', labels: ['wontfix', 'priority: must'] }));
    github.open({ title: 'Export the backlog', labels: ['status: in progress'] });
    // An unmapped value's label stays a tag.
    github.open({ title: 'Share the board', labels: ['type: user-facing', 'priority: wont'] });
    // A closed issue with a label mapped to an open status: the state wins.
    github.close(github.open({ title: 'Print the board', labels: ['status: in progress'] }));

    const round = await board.sync(1, github);
    expect(round.pull.created.map((entry) => entry.item_id)).toEqual(['TASK-0001', 'TASK-0002', 'TASK-0003', 'US-0001', 'TASK-0004']);
    expect(round.plan.push).toEqual([]);
    expect(await fieldsOfItem(board, 'TASK-0001')).toEqual({ kind: 'task', priority: 'could', status: 'backlog', tags: ['ui'] });
    expect(await fieldsOfItem(board, 'TASK-0002')).toEqual({ kind: 'task', priority: 'must', status: 'cancelled', tags: [] });
    expect(await fieldsOfItem(board, 'TASK-0003')).toEqual({ kind: 'task', priority: 'should', status: 'in_progress', tags: [] });
    expect(await fieldsOfItem(board, 'US-0001')).toEqual({ kind: 'story', priority: 'should', status: 'backlog', tags: ['priority: wont'] });
    expect(await fieldsOfItem(board, 'TASK-0004')).toEqual({ kind: 'task', priority: 'should', status: 'done', tags: [] });
    await board.expectSettled(1, github);

    // A later push that touches labels keeps the issue's priority label.
    await board.json(['update', 'TASK-0001', '--tag', 'ui', '--tag', 'backend']);
    const push = await board.sync(1, github);
    expect(push.plan.push.map((op) => [op.op, op.item_id, op.fields])).toEqual([['update', 'TASK-0001', ['labels']]]);
    expect(github.issue(1).labels).toEqual(['backend', 'priority: could', 'ui']);
    await board.expectSettled(1, github);
  });

  it('a pull update turns a changed mapped label into the field instead of a tag, and pushes nothing back', async () => {
    const board = new Board();
    const github = new FakeRepository('github', 'acme/demo');
    await board.connect('github', 'acme/demo');
    await board.json(['sync', 'mapping', 'import', '1', '-'], JSON.stringify(mapping));
    await board.json(['sync', 'start', '1', '-'], JSON.stringify(github.listing()));
    github.open({ title: 'Retry uploads', labels: ['priority: could', 'ui'] });
    github.open({ title: 'Drop the beta flag', labels: ['priority: should'] });
    await board.sync(1, github);

    github.edit(1, { labels: ['priority: must', 'ui', 'status: in progress'] });
    github.edit(2, { labels: ['priority: should', 'wontfix'] });
    github.close(2);
    const round = await board.sync(1, github);
    expect(round.pull.updated).toEqual([
      { item_id: 'TASK-0001', external_ref: 'acme/demo#1', fields: ['labels'] },
      { item_id: 'TASK-0002', external_ref: 'acme/demo#2', fields: ['labels', 'state'] },
    ]);
    expect([round.plan.push, round.plan.ack, round.plan.conflicts]).toEqual([[], [], []]);
    expect(await fieldsOfItem(board, 'TASK-0001')).toEqual({ kind: 'task', priority: 'must', status: 'in_progress', tags: ['ui'] });
    expect(await fieldsOfItem(board, 'TASK-0002')).toEqual({ kind: 'task', priority: 'should', status: 'cancelled', tags: [] });
    expect((await board.history('TASK-0001')).slice(1)).toEqual([
      { via: 'sync:github', action: 'update', field: 'priority', old_value: 'could', new_value: 'must' },
      { via: 'sync:github', action: 'status', field: 'status', old_value: 'backlog', new_value: 'in_progress' },
    ]);
    expect(await board.outbox()).toEqual([]);
    await board.expectSettled(1, github);
    expect(github.issue(1).labels).toEqual(['priority: must', 'ui', 'status: in progress']);
  });

  it("a priority one connection's label sets reaches the other repository as that connection's label", async () => {
    const repos = await twoRepositories();
    const { board, github, gitlab } = repos;
    await board.json(['sync', 'mapping', 'import', '1', '-'], JSON.stringify({ priority: { must: 'P1', should: 'P2' } }));
    await board.json(['sync', 'mapping', 'import', '2', '-'], JSON.stringify({ priority: { must: 'priority::1', should: 'priority::2' } }));
    await board.json(['add', 'task', '--title', 'Retry uploads']);
    await syncBoth(repos);
    expect([github.issue(1).labels, gitlab.issue(1).labels]).toEqual([['P2'], ['priority::2']]);
    github.edit(1, { labels: ['P1', 'ui'] });
    await syncBoth(repos);
    expect(await fieldsOfItem(board, 'TASK-0001')).toEqual({ kind: 'task', priority: 'must', status: 'backlog', tags: ['ui'] });
    expect([github.issue(1).labels, gitlab.issue(1).labels]).toEqual([['P1', 'ui'], ['priority::1', 'ui']]);
  });

  it('sync start from a GitLab repository with issues sets priority and status from mapped labels', async () => {
    const board = new Board();
    const gitlab = new FakeRepository('gitlab', 'acme/app');
    gitlab.open({ title: 'Retry uploads', labels: ['priority: could', 'backend'] });
    // GitLab has no close reason at all: the label mapped to cancelled is the only way to tell.
    gitlab.close(gitlab.open({ title: 'Drop the beta flag', labels: ['wontfix', 'priority: must'] }));
    gitlab.open({ title: 'Export the backlog', labels: ['status: in progress'] });
    await board.connect('gitlab', 'acme/app');
    await board.json(['sync', 'mapping', 'import', '1', '-'], JSON.stringify(mapping));
    expect(await board.json(['sync', 'start', '1', '-'], JSON.stringify(gitlab.listing()))).toMatchObject({ from: 'repository', created: 3, queued: 0 });
    expect(await fieldsOfItem(board, 'TASK-0001')).toEqual({ kind: 'task', priority: 'could', status: 'backlog', tags: ['backend'] });
    expect(await fieldsOfItem(board, 'TASK-0002')).toEqual({ kind: 'task', priority: 'must', status: 'cancelled', tags: [] });
    expect(await fieldsOfItem(board, 'TASK-0003')).toEqual({ kind: 'task', priority: 'should', status: 'in_progress', tags: [] });
    await board.expectSettled(1, gitlab);

    await board.json(['update', 'TASK-0001', '--tag', 'backend', '--tag', 'api']);
    await board.sync(1, gitlab);
    expect(gitlab.issue(1).labels).toEqual(['api', 'backend', 'priority: could']);
    await board.expectSettled(1, gitlab);
  });

  it("import reads the labels through the mapping of the repository's connection, and stores them as tags without one", async () => {
    const board = new Board();
    const demo = new FakeRepository('github', 'acme/demo');
    const other = new FakeRepository('github', 'acme/other');
    for (const repo of [demo, other]) {
      repo.open({ title: `Retry uploads in ${repo.repository}`, labels: ['priority: could', 'ui'] });
      repo.close(repo.open({ title: `Drop the beta flag in ${repo.repository}`, labels: ['wontfix', 'priority: must'] }));
    }
    await board.connect('github', 'acme/demo');
    await board.json(['sync', 'mapping', 'import', '1', '-'], JSON.stringify(mapping));
    const importRepo = (repo: FakeRepository) => board.json(['import', '-', '--source', 'github', '--repo', repo.repository], JSON.stringify(repo.listing()));
    expect(await importRepo(demo)).toMatchObject({ created: ['TASK-0001', 'TASK-0002'] });
    expect(await fieldsOfItem(board, 'TASK-0001')).toEqual({ kind: 'task', priority: 'could', status: 'backlog', tags: ['ui'] });
    expect(await fieldsOfItem(board, 'TASK-0002')).toEqual({ kind: 'task', priority: 'must', status: 'cancelled', tags: [] });
    // No connection for acme/other: no mapping, every label is a tag.
    expect(await importRepo(other)).toMatchObject({ created: ['TASK-0003', 'TASK-0004'] });
    expect(await fieldsOfItem(board, 'TASK-0003')).toEqual({ kind: 'task', priority: 'should', status: 'backlog', tags: ['priority: could', 'ui'] });
    expect(await fieldsOfItem(board, 'TASK-0004')).toEqual({ kind: 'task', priority: 'should', status: 'done', tags: ['wontfix', 'priority: must'] });

    // A re-import updates the fields the changed labels name.
    demo.edit(1, { labels: ['priority: must', 'ui', 'status: in progress'] });
    expect(await importRepo(demo)).toMatchObject({ updated: ['TASK-0001'], unchanged: ['TASK-0002'] });
    expect(await fieldsOfItem(board, 'TASK-0001')).toEqual({ kind: 'task', priority: 'must', status: 'in_progress', tags: ['ui'] });
  });
});

describe('sync end to end: sync start (TASK-0025 AC5)', () => {
  it('seeds an empty repository with every item, its closed items closed', async () => {
    const board = new Board();
    await board.json(['add', 'requirement', '--type', 'functional', '--title', 'Export the backlog as CSV']);
    await board.json(['add', 'requirement', '--type', 'functional', '--title', 'Print the board on paper', '--status', 'rejected']);
    await board.json(['add', 'task', '--title', 'Write the CSV writer']);
    await board.json(['add', 'task', '--title', 'Write the CSV header', '--status', 'done']);
    await board.json(['add', 'bug', '--title', 'Quotes break the CSV']);
    const gitlab = new FakeRepository('gitlab', 'acme/app');
    expect(await board.connect('gitlab', 'acme/app')).toBe(1);
    expect(await board.json(['sync', 'start', '1', '-'], JSON.stringify(gitlab.listing()))).toMatchObject({
      from: 'board',
      queued: 5,
      by_kind: { requirement: 2, epic: 0, story: 0, task: 2, bug: 1 },
    });

    const round = await board.sync(1, gitlab);
    expect(round.plan.push.map((op) => [op.op, op.item_id, op.issue.state])).toEqual([
      ['create', 'BUG-0001', 'open'],
      ['create', 'REQ-0001', 'open'],
      ['create', 'REQ-0002', 'closed'],
      ['create', 'TASK-0001', 'open'],
      ['create', 'TASK-0002', 'closed'],
    ]);
    expect(gitlab.numbers().map((number) => [gitlab.issue(number).title, gitlab.issue(number).state])).toEqual([
      ['Quotes break the CSV', 'open'],
      ['Export the backlog as CSV', 'open'],
      ['Print the board on paper', 'closed'],
      ['Write the CSV writer', 'open'],
      ['Write the CSV header', 'closed'],
    ]);
    // A closed create is created, then closed.
    expect(gitlab.calls.map((call) => [call.tool, call.args.state_event ?? null])).toEqual([
      ['create_issue', null],
      ['create_issue', null],
      ['create_issue', null],
      ['update_issue', 'close'],
      ['create_issue', null],
      ['create_issue', null],
      ['update_issue', 'close'],
    ]);
    expect(await board.item('REQ-0002')).toMatchObject({ status: 'rejected', external_ref: 'gitlab:acme/app#3' });
    expect(await board.outbox()).toEqual([]);
    await board.expectSettled(1, gitlab);
  });

  it('brings the issues of a repository that has some to the board and never pushes the items that existed before the start', async () => {
    const board = new Board();
    await board.json(['add', 'task', '--title', 'Write the CSV writer']);
    await board.json(['add', 'task', '--title', 'Write the CSV header', '--status', 'done']);
    const github = new FakeRepository('github', 'acme/demo');
    github.open({ title: 'Export the backlog', body: 'CSV.' });
    github.close(github.open({ title: 'Drop the beta flag' }));
    expect(await board.connect('github', 'acme/demo')).toBe(1);
    // Changed after connecting, before the start: queued, then dropped by the start.
    await board.json(['update', 'TASK-0001', '--title', 'Write the CSV writer fast']);
    expect(await board.outbox()).toEqual([[1, 'TASK-0001', 'update', ['title']]]);
    expect(await board.json(['sync', 'start', '1', '-'], JSON.stringify(github.listing()))).toMatchObject({ from: 'repository', created: 2, linked: 0, queued: 0 });
    expect(await board.outbox()).toEqual([]);
    let round = await board.sync(1, github);
    expect([round.pull.created, round.pull.updated, round.plan.push, round.plan.ack]).toEqual([[], [], [], []]);
    expect(await board.item('TASK-0004')).toMatchObject({ title: 'Drop the beta flag', status: 'done', external_ref: 'github:acme/demo#2' });

    // Items from before the start: acknowledged, never pushed. Issue items: updated. New items: created.
    await board.json(['update', 'TASK-0001', '--title', 'Write the CSV writer faster']);
    await board.json(['update', 'TASK-0002', '--status', 'in_progress']);
    await board.json(['update', 'TASK-0003', '--title', 'Export the backlog as CSV']);
    await board.json(['add', 'task', '--title', 'Document the CSV format']);
    round = await board.sync(1, github);
    expect(round.plan.push.map((op) => [op.op, op.item_id])).toEqual([
      ['update', 'TASK-0003'],
      ['create', 'TASK-0005'],
    ]);
    expect(round.plan.ack).toHaveLength(2);
    expect(github.numbers().map((number) => github.issue(number).title)).toEqual(['Export the backlog as CSV', 'Drop the beta flag', 'Document the CSV format']);
    expect(await board.outbox()).toEqual([]);
    await board.expectSettled(1, github);
  });
});

/**
 * One board item (TASK-0001), a GitHub connection started on a repository with two issues (TASK-0002, TASK-0003), and
 * a GitLab repository with three issues, not connected yet.
 */
async function twoRepositoriesWithIssues(): Promise<TwoRepositories> {
  const board = new Board();
  await board.json(['add', 'task', '--title', 'Write the CSV writer']);
  const github = new FakeRepository('github', 'acme/demo');
  github.open({ title: 'Export the backlog', body: 'CSV.' });
  github.close(github.open({ title: 'Drop the beta flag' }));
  const gitlab = new FakeRepository('gitlab', 'acme/app');
  gitlab.open({ title: 'Upload size limit' });
  gitlab.open({ title: 'Retry uploads' });
  gitlab.close(gitlab.open({ title: 'Resume uploads' }));
  expect(await board.connect('github', 'acme/demo')).toBe(1);
  expect(await board.json(['sync', 'start', '1', '-'], JSON.stringify(github.listing()))).toMatchObject({ from: 'repository', created: 2, queued: 0 });
  return { board, github, gitlab };
}

/** The GitLab connection (2) added and started from its issues. */
async function startGitlab({ board, gitlab }: TwoRepositories): Promise<unknown> {
  expect(await board.connect('gitlab', 'acme/app')).toBe(2);
  return board.json(['sync', 'start', '2', '-'], JSON.stringify(gitlab.listing()));
}

describe('sync end to end: each repository keeps its issues (BUG-0019)', () => {
  it('starts a second connection from its issues without queueing or planning a create on the first (AC1)', async () => {
    const repos = await twoRepositoriesWithIssues();
    const { board, github, gitlab } = repos;
    expect(await startGitlab(repos)).toMatchObject({ from: 'repository', created: 3, linked: 0, queued: 0 });
    expect(await board.item('TASK-0004')).toMatchObject({ title: 'Upload size limit', external_ref: 'gitlab:acme/app#1' });
    expect(await board.outbox()).toEqual([]);
    const plan = await board.plan(1, github.listing());
    expect([plan.push, plan.ack]).toEqual([[], []]);
    await syncBoth(repos);
    expect([github.numbers(), gitlab.numbers()]).toEqual([[1, 2], [1, 2, 3]]);
    expect([github.calls, gitlab.calls]).toEqual([[], []]);
  });

  it('never creates on the first connection an item the second start linked, queueing nothing for it (AC1)', async () => {
    const repos = await twoRepositoriesWithIssues();
    const { board, github, gitlab } = repos;
    // Imported before acme/app had a connection: an import of an unconnected repository is queued for every connection.
    await board.json(['import', '-', '--source', 'gitlab', '--repo', 'acme/app'], JSON.stringify(gitlab.listing()));
    const imported: [number, string, string, string[]][] = [
      [1, 'TASK-0004', 'create', []],
      [1, 'TASK-0005', 'create', []],
      [1, 'TASK-0006', 'create', []],
    ];
    expect(await board.outbox()).toEqual(imported);
    gitlab.edit(2, { title: 'Retry failed uploads' });
    expect(await startGitlab(repos)).toMatchObject({ from: 'repository', created: 0, linked: 3, queued: 0 });
    expect(await board.item('TASK-0005')).toMatchObject({ title: 'Retry failed uploads' });
    // The start's update of TASK-0005 is queued nowhere; the pending creates on GitHub are acknowledged, never pushed.
    expect(await board.outbox()).toEqual(imported);
    const round = await board.sync(1, github);
    expect([round.plan.push, round.plan.ack.length]).toEqual([[], 3]);
    await board.sync(2, gitlab);
    await board.expectSettled(1, github);
    await board.expectSettled(2, gitlab);
    expect([github.numbers(), github.calls]).toEqual([[1, 2], []]);
  });

  it("pushes later changes of a repository's items only to it, and new board items to every started connection (AC2)", async () => {
    const repos = await twoRepositoriesWithIssues();
    const { board, github, gitlab } = repos;
    await startGitlab(repos);
    await syncBoth(repos);

    // A GitLab item and a GitHub item change: each goes to its own repository, the other connection acknowledges it.
    await board.json(['update', 'TASK-0005', '--title', 'Retry failed uploads']);
    await board.json(['update', 'TASK-0002', '--title', 'Export the backlog as CSV']);
    let [toGithub, toGitlab] = await syncBoth(repos);
    expect([toGithub.plan.push.map((op) => [op.op, op.item_id]), toGithub.plan.ack.length]).toEqual([[['update', 'TASK-0002']], 1]);
    expect([toGitlab.plan.push.map((op) => [op.op, op.item_id]), toGitlab.plan.ack.length]).toEqual([[['update', 'TASK-0005']], 1]);
    expect([github.issue(1).title, gitlab.issue(2).title]).toEqual(['Export the backlog as CSV', 'Retry failed uploads']);
    expect([github.numbers(), gitlab.numbers()]).toEqual([[1, 2], [1, 2, 3]]);

    // An item created on the board after the starts fans out to both.
    const added = await board.json(['add', 'task', '--title', 'Document the CSV format']);
    expect(added.sync_pending.map((entry: { connection_id: number }) => entry.connection_id)).toEqual([1, 2]);
    [toGithub, toGitlab] = await syncBoth(repos);
    for (const round of [toGithub, toGitlab]) expect(round.plan.push.map((op) => [op.op, op.item_id])).toEqual([['create', 'TASK-0007']]);
    expect([github.issue(3).title, gitlab.issue(4).title]).toEqual(['Document the CSV format', 'Document the CSV format']);

    // A new GitLab issue pulled to the board stays on GitLab: nothing is queued for GitHub, now or when it changes.
    gitlab.open({ title: 'Upload progress bar' });
    const pulled = await board.sync(2, gitlab);
    expect(pulled.pull.created).toEqual([{ item_id: 'TASK-0008', external_ref: 'acme/app#5' }]);
    expect(await board.outbox()).toEqual([]);
    await board.json(['update', 'TASK-0008', '--title', 'Show upload progress']);
    [toGithub, toGitlab] = await syncBoth(repos);
    expect([toGithub.plan.push, toGithub.plan.ack.length]).toEqual([[], 1]);
    expect(toGitlab.plan.push.map((op) => [op.op, op.item_id])).toEqual([['update', 'TASK-0008']]);
    expect([github.numbers(), gitlab.issue(5).title]).toEqual([[1, 2, 3], 'Show upload progress']);
  });
});

describe('sync end to end: idempotency (TASK-0025 AC6)', () => {
  it('after a full sync of both connections, plan has nothing left and a second sync makes no MCP call and changes nothing', async () => {
    const repos = await twoRepositories();
    const { board, github, gitlab } = repos;
    await board.json(['add', 'task', '--title', 'Retry uploads', '--tag', 'upload']);
    await board.json(['add', 'bug', '--title', 'Upload hangs', '--status', 'done']);
    await board.json(['add', 'story', '--title', 'As a user I resume uploads']);
    await syncBoth(repos);
    // Creates go by item ID: #1 BUG-0001 (closed), #2 TASK-0001, #3 US-0001 on both repositories.
    expect([github.issue(2).title, gitlab.issue(2).title]).toEqual(['Retry uploads', 'Retry uploads']);
    // Changes on every side at once: a local edit and a delete, a remote edit and a new issue on GitHub, a close and a new issue on GitLab.
    await board.json(['update', 'TASK-0001', '--description', 'Three times.']);
    await board.json(['delete', 'US-0001']);
    github.edit(1, { title: 'Upload hangs at 99%' });
    github.open({ title: 'Upload progress bar' });
    gitlab.close(2);
    gitlab.open({ title: 'Upload size limit', labels: ['bug'] });
    // What GitLab's pull brings reaches the board after GitHub's turn: it waits in GitHub's outbox for the next round.
    // Each new issue stays in its repository (BUG-0019): GitLab's pulled issue queues no create for GitHub.
    await board.sync(1, github);
    await board.sync(2, gitlab);
    expect(await board.outbox()).toEqual([[1, 'TASK-0001', 'status', ['status']]]);
    await syncBoth(repos);
    const issues = (repo: FakeRepository) => repo.numbers().map((number) => [repo.issue(number).title, repo.issue(number).state]);
    expect(issues(github)).toEqual([
      ['Upload hangs at 99%', 'closed'],
      ['Retry uploads', 'closed'],
      ['As a user I resume uploads', 'closed'],
      ['Upload progress bar', 'open'],
    ]);
    expect(issues(gitlab)).toEqual([
      ['Upload hangs at 99%', 'closed'],
      ['Retry uploads', 'closed'],
      ['As a user I resume uploads', 'closed'],
      ['Upload size limit', 'open'],
    ]);
    expect(fieldsOf(github, 2)).toMatchObject({ body: 'Three times.', state: 'closed' });
    expect(await board.item('TASK-0001')).toMatchObject({ status: 'done', description: 'Three times.' });

    const calls = [github.calls.length, gitlab.calls.length];
    const items = await board.json(['list', '--all']);
    const again = await syncBoth(repos);
    for (const round of again) {
      expect(round.pull).toEqual({ created: [], updated: [], conflicts: [], warnings: [] });
      expect(round.plan).toEqual({ push: [], pull: [], conflicts: [], ack: [], overwritten: [], warnings: expect.any(Array) });
      expect(round.confirm).toBeNull();
    }
    expect([github.calls.length, gitlab.calls.length]).toEqual(calls);
    expect(await board.json(['list', '--all'])).toEqual(items);
    expect(await board.outbox()).toEqual([]);
  });
});

// BUG-0018: gitlab-mcp list_work_items has no descriptions, so GitLab descriptions never reached the board and a local
// description push replaced a GitLab edit unseen. The skill now lists GitLab issues with list_issues (REST, with
// descriptions), and a snapshot written from a list_work_items listing gets its body from the first listing that has one.
describe('sync end to end: GitLab descriptions (BUG-0018)', () => {
  it('brings the descriptions of a list_issues listing to the board on sync start and pull, edits included (AC1, AC2)', async () => {
    const board = new Board();
    const gitlab = new FakeRepository('gitlab', 'acme/app');
    gitlab.open({ title: 'Retry uploads', body: 'Three times.' });
    await board.connect('gitlab', 'acme/app');
    expect(await board.json(['sync', 'start', '1', '-'], JSON.stringify(gitlab.listing()))).toMatchObject({ from: 'repository', created: 1, queued: 0 });
    expect(await board.item('TASK-0001')).toMatchObject({ description: 'Three times.' });

    gitlab.open({ title: 'Upload size limit', body: 'At most 2 GB.' });
    gitlab.edit(1, { body: 'Three times, with backoff.' });
    const round = await board.sync(1, gitlab);
    expect(round.pull).toMatchObject({
      created: [{ item_id: 'TASK-0002', external_ref: 'acme/app#2' }],
      updated: [{ item_id: 'TASK-0001', external_ref: 'acme/app#1', fields: ['body'] }],
      conflicts: [],
    });
    expect([(await board.item('TASK-0001')).description, (await board.item('TASK-0002')).description]).toEqual(['Three times, with backoff.', 'At most 2 GB.']);
    expect([round.plan.push, gitlab.calls]).toEqual([[], []]);
    await board.expectSettled(1, gitlab);
  });

  it('lets GitLab win a description changed on both sides when it is the source of truth, recorded as overwritten (AC2)', async () => {
    const board = new Board();
    const gitlab = new FakeRepository('gitlab', 'acme/app');
    await board.connect('gitlab', 'acme/app');
    await board.json(['sync', 'start', '1', '-'], JSON.stringify(gitlab.listing()));
    expect(await board.json(['sync', 'source-of-truth'])).toMatchObject({ source_of_truth: 1 });
    await board.json(['add', 'task', '--title', 'Rename settings', '--description', 'Old text.']);
    await board.sync(1, gitlab);

    await board.json(['update', 'TASK-0001', '--description', 'Board text.']);
    gitlab.edit(1, { body: 'GitLab text.' });
    const plan = await board.plan(1, gitlab.listing());
    expect([plan.conflicts, plan.push, plan.ack.length]).toEqual([[], [], 1]);
    expect(plan.overwritten).toEqual([
      { item_id: 'TASK-0001', external_ref: 'acme/app#1', field: 'body', winner: 'remote', value: 'GitLab text.', overwritten: 'Board text.' },
    ]);
    expect(plan.pull).toEqual([expect.objectContaining({ op: 'update', item_id: 'TASK-0001', fields: ['body'], overwritten: { body: 'Board text.' } })]);

    await board.sync(1, gitlab);
    expect([(await board.item('TASK-0001')).description, gitlab.issue(1).body]).toEqual(['GitLab text.', 'GitLab text.']);
    expect((await board.history('TASK-0001')).at(-1)).toEqual({ via: 'sync:gitlab', action: 'overwrite', field: 'body', old_value: 'Board text.', new_value: 'GitLab text.' });
    expect(await board.overwritten(1)).toEqual([
      { step: 'pull', item_id: 'TASK-0001', external_ref: 'acme/app#1', field: 'body', winner: 'remote', value: 'GitLab text.', overwritten: 'Board text.' },
    ]);
    await board.expectSettled(1, gitlab);
  });

  it('pushes the board description over a GitLab edit when another connection is the source of truth, recorded as overwritten (AC2)', async () => {
    const repos = await twoRepositories();
    const { board, github, gitlab } = repos;
    await board.json(['add', 'task', '--title', 'Retry uploads', '--description', 'Old text.']);
    await syncBoth(repos);

    await board.json(['update', 'TASK-0001', '--description', 'Board text.']);
    gitlab.edit(1, { body: 'GitLab text.' });
    await board.sync(1, github);
    const plan = await board.plan(2, gitlab.listing());
    expect([plan.conflicts, plan.pull]).toEqual([[], []]);
    expect(plan.overwritten).toEqual([
      { item_id: 'TASK-0001', external_ref: 'acme/app#1', field: 'body', winner: 'local', value: 'Board text.', overwritten: 'GitLab text.' },
    ]);
    expect(plan.push).toEqual([expect.objectContaining({ op: 'update', fields: ['body'], overwritten: { body: 'GitLab text.' } })]);

    await board.sync(2, gitlab);
    expect([(await board.item('TASK-0001')).description, github.issue(1).body, gitlab.issue(1).body]).toEqual(['Board text.', 'Board text.', 'Board text.']);
    expect((await board.history('TASK-0001')).at(-1)).toEqual({ via: 'sync:gitlab', action: 'overwrite', field: 'body', old_value: 'GitLab text.', new_value: 'Board text.' });
    expect(await board.overwritten(2)).toEqual([
      { step: 'confirm', item_id: 'TASK-0001', external_ref: 'acme/app#1', field: 'body', winner: 'local', value: 'Board text.', overwritten: 'GitLab text.' },
    ]);
    await board.expectSettled(1, github);
    await board.expectSettled(2, gitlab);
  });

  it('after list_work_items syncs, the first list_issues sync pulls the missing descriptions and pushes nothing; later edits on both sides are conflicts (AC1-AC3)', async () => {
    const board = new Board();
    const gitlab = new FakeRepository('gitlab', 'acme/app');
    gitlab.gitlabListing = 'list_work_items';
    gitlab.open({ title: 'Retry uploads', body: 'Three times.' });
    gitlab.open({ title: 'Upload size limit' });
    await board.connect('gitlab', 'acme/app');
    expect(await board.json(['sync', 'start', '1', '-'], JSON.stringify(gitlab.listing()))).toMatchObject({ from: 'repository', created: 2, queued: 0 });
    await board.json(['add', 'task', '--title', 'Resume uploads', '--description', 'From the last byte.']);
    await board.sync(1, gitlab);
    await board.expectSettled(1, gitlab);
    // list_work_items has no descriptions: the pulled items have none.
    const descriptions = async () => Promise.all(['TASK-0001', 'TASK-0002', 'TASK-0003'].map(async (id) => (await board.item(id)).description));
    expect(await descriptions()).toEqual(['', '', 'From the last byte.']);
    const calls = gitlab.calls.length;

    gitlab.gitlabListing = 'list_issues';
    const plan = await board.plan(1, gitlab.listing());
    expect([plan.push, plan.ack, plan.conflicts, plan.overwritten]).toEqual([[], [], [], []]);
    expect(plan.pull).toEqual([expect.objectContaining({ op: 'update', item_id: 'TASK-0001', fields: ['body'], issue: expect.objectContaining({ body: 'Three times.' }) })]);
    const round = await board.sync(1, gitlab);
    expect(round.pull.updated).toEqual([{ item_id: 'TASK-0001', external_ref: 'acme/app#1', fields: ['body'] }]);
    expect(await descriptions()).toEqual(['Three times.', '', 'From the last byte.']);
    expect(gitlab.calls.length).toBe(calls);
    await board.expectSettled(1, gitlab);

    // TASK-0002's snapshot took the listed body as its base: a description changed on both sides is a conflict.
    await board.json(['update', 'TASK-0002', '--description', 'Board text.']);
    gitlab.edit(2, { body: 'GitLab text.' });
    const conflict = await board.plan(1, gitlab.listing());
    expect([conflict.conflicts, conflict.push]).toEqual([[], []]);
    expect(conflict.overwritten).toEqual([
      { item_id: 'TASK-0002', external_ref: 'acme/app#2', field: 'body', winner: 'remote', value: 'GitLab text.', overwritten: 'Board text.' },
    ]);
    await board.sync(1, gitlab);
    expect(await descriptions()).toEqual(['Three times.', 'GitLab text.', 'From the last byte.']);
    await board.expectSettled(1, gitlab);

    // A list_work_items listing is still accepted, and its missing bodies change nothing.
    gitlab.gitlabListing = 'list_work_items';
    await board.expectSettled(1, gitlab);
  });
});

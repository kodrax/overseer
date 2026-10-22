import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { isOverseerError } from '../src/core/errors.js';
import type { OverseerService } from '../src/core/service.js';
import { confirmSync } from '../src/core/sync-confirm.js';
import { planSync } from '../src/core/sync-plan.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { ctx, openService } from './helpers/service.js';
import { tempRepo, tempUserConfig } from './helpers/tmp.js';

const MAPPING = { kind: { task: 'Task' }, status: { done: 'closed' }, priority: { should: 'P2' } };

const refsOf = (service: OverseerService, itemId: string) =>
  (
    service.db
      .prepare('SELECT connection_id, external_ref, url, state, synced_fields FROM item_remote_refs WHERE item_id = ? ORDER BY connection_id')
      .all(itemId) as { connection_id: number; external_ref: string; url: string; state: string; synced_fields: string }[]
  ).map((row) => ({ ...row, synced_fields: JSON.parse(row.synced_fields) }));

function failure(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (isOverseerError(error)) return { code: error.code, message: error.message };
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

/** A GitHub and a GitLab connection with the same mapping, and one new task queued for both. */
async function twoConnections(root = tempRepo()) {
  const service = openService(root);
  const github = service.connections.add({ host: 'github', repository: 'acme/demo' });
  const gitlab = service.connections.add({ host: 'gitlab', repository: 'acme/app' });
  service.mappings.replace(github.id, MAPPING);
  service.mappings.replace(gitlab.id, MAPPING);
  await service.createItem({ kind: 'task', title: 'Ship the export', description: 'CSV and JSON.', priority: 'should', tags: ['export'] }, ctx);
  return { service, github, gitlab, root };
}

describe('sync confirm', () => {
  it('links the item to the created issue, snapshots the pushed values and acknowledges the seq (AC1)', async () => {
    const { service, github } = await twoConnections();
    const plan = planSync(service, github.id, []);
    expect(plan.push).toEqual([expect.objectContaining({ op: 'create', item_id: 'TASK-0001' })]);
    const [op] = plan.push;
    const result = confirmSync(service, github.id, [
      { seqs: [op!.seq], item_id: 'TASK-0001', external_id: 'acme/demo#7', url: 'https://github.com/acme/demo/issues/7', state: 'OPEN' },
    ]);
    expect(result).toEqual({
      connection_id: github.id,
      confirmed: [
        { item_id: 'TASK-0001', external_id: 'acme/demo#7', url: 'https://github.com/acme/demo/issues/7', state: 'open', fields: ['title', 'body', 'labels', 'state', 'assignee', 'milestone'] },
      ],
      acked: [op!.seq],
    });
    expect(refsOf(service, 'TASK-0001')).toEqual([
      { connection_id: github.id, external_ref: 'acme/demo#7', url: 'https://github.com/acme/demo/issues/7', state: 'open', synced_fields: op!.issue },
    ]);
    expect(service.outbox.list(github.id)).toEqual([]);
    expect(service.getItem('TASK-0001').item).toMatchObject({ external_ref: 'github:acme/demo#7', external_url: 'https://github.com/acme/demo/issues/7' });

    // The issue as pushed: nothing left to push or pull.
    const listed = { number: 7, title: 'Ship the export', body: 'CSV and JSON.', state: 'OPEN', labels: ['P2', 'Task', 'export'], assignees: [], milestone: null, html_url: 'https://github.com/acme/demo/issues/7' };
    expect(planSync(service, github.id, [listed])).toMatchObject({ push: [], pull: [], conflicts: [], ack: [] });

    // An update snapshots only the fields it pushed and keeps the rest.
    await service.updateItem({ id: 'TASK-0001', title: 'Ship the CSV export' }, ctx);
    const [update] = planSync(service, github.id, [listed]).push;
    expect(update).toMatchObject({ op: 'update', fields: ['title'] });
    confirmSync(service, github.id, [{ seqs: [update!.seq], item_id: 'TASK-0001', external_id: 'acme/demo#7', url: 'https://github.com/acme/demo/issues/7', state: 'open', fields: update!.fields }]);
    expect(refsOf(service, 'TASK-0001')[0]!.synced_fields).toEqual({ ...op!.issue, title: 'Ship the CSV export' });
    service.close();
  });

  it('gives INVALID_INPUT and writes nothing for an unknown seq or item', async () => {
    const { service, github } = await twoConnections();
    const [entry] = service.outbox.list(github.id);
    const valid = { seqs: [entry!.seq], item_id: 'TASK-0001', external_id: 'acme/demo#7', url: 'https://github.com/acme/demo/issues/7', state: 'open' };
    const cases = [
      [valid, { ...valid, seqs: [999], item_id: 'TASK-0001' }],
      [valid, { ...valid, seqs: [], item_id: 'TASK-0009' }],
      [{ ...valid, item_id: 'TASK-0009' }],
      [{ ...valid, external_id: 'other/repo#7' }],
      [{ ...valid, state: 'merged' }],
      [],
    ];
    for (const input of cases) expect(failure(() => confirmSync(service, github.id, input)).code).toBe('INVALID_INPUT');
    expect(failure(() => confirmSync(service, github.id, [valid, { ...valid, seqs: [999] }])).message).toBe(
      'result 2 (TASK-0001): no pending outbox entry with seq 999 on connection 1; nothing was written.',
    );
    expect(failure(() => confirmSync(service, github.id, [{ ...valid, item_id: 'TASK-0009' }])).message).toBe(
      `result 1 (TASK-0009): seq ${entry!.seq} belongs to TASK-0001; result 1 (TASK-0009): unknown item TASK-0009; nothing was written.`,
    );
    expect(refsOf(service, 'TASK-0001')).toEqual([]);
    expect(service.outbox.list(github.id)).toHaveLength(1);
    expect(service.getItem('TASK-0001').item.external_ref).toBeNull();
    expect(failure(() => confirmSync(service, 9, [valid]))).toEqual({ code: 'NOT_FOUND', message: 'No connection with id 9.' });
    service.close();
  });

  it('acknowledges the close of a deleted item without a remote ref', async () => {
    const { service, github } = await twoConnections();
    const [created] = planSync(service, github.id, []).push;
    confirmSync(service, github.id, [{ seqs: [created!.seq], item_id: 'TASK-0001', external_id: 'acme/demo#7', url: 'https://github.com/acme/demo/issues/7', state: 'open' }]);
    service.deleteItem('TASK-0001', ctx);
    const [close] = planSync(service, github.id, []).push;
    expect(close).toMatchObject({ op: 'close', item_id: 'TASK-0001' });
    expect(confirmSync(service, github.id, [{ seqs: [close!.seq], item_id: 'TASK-0001', external_id: 'acme/demo#7', url: 'https://github.com/acme/demo/issues/7', state: 'closed' }])).toMatchObject({
      confirmed: [{ item_id: 'TASK-0001', fields: [] }],
      acked: [close!.seq],
    });
    expect(service.outbox.list(github.id)).toEqual([]);
    service.close();
  });

  it('keeps both references of an item pushed to a GitHub and a GitLab connection (AC4, REQ-0247)', async () => {
    const { service, github, gitlab, root } = await twoConnections();
    const [toGithub] = planSync(service, github.id, []).push;
    const [toGitlab] = planSync(service, gitlab.id, []).push;
    expect([toGithub!.op, toGitlab!.op]).toEqual(['create', 'create']);
    service.close();

    const pushed = (seq: number, external_id: string, url: string) => JSON.stringify([{ seqs: [seq], item_id: 'TASK-0001', external_id, url, state: 'open' }]);
    const first = await cli(root, ['sync', 'confirm', '1', '-', '--json'], pushed(toGithub!.seq, 'acme/demo#7', 'https://github.com/acme/demo/issues/7'));
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out)).toMatchObject({ acked: [toGithub!.seq] });
    const second = await cli(root, ['sync', 'confirm', '2', '-'], pushed(toGitlab!.seq, 'acme/app#3', 'https://gitlab.com/acme/app/-/issues/3'));
    expect(second.code).toBe(0);
    expect(second.out).toBe(`TASK-0001: acme/app#3 (open) https://gitlab.com/acme/app/-/issues/3\nConfirmed 1 push on connection 2; acknowledged outbox ${toGitlab!.seq}.\n`);

    expect((await cli(root, ['sync', 'outbox', '--json'])).out.trim()).toBe('[]');
    for (const reference of ['acme/demo#7', 'github:acme/demo#7', 'acme/app#3', 'gitlab:acme/app#3', 'https://gitlab.com/acme/app/-/issues/3']) {
      const shown = await cli(root, ['show', reference, '--json']);
      expect(JSON.parse(shown.out).item.id).toBe('TASK-0001');
    }
    const reopened = openService(root);
    expect(refsOf(reopened, 'TASK-0001').map((ref) => [ref.connection_id, ref.external_ref])).toEqual([
      [github.id, 'acme/demo#7'],
      [gitlab.id, 'acme/app#3'],
    ]);
    reopened.close();
  });

  it('gives INVALID_INPUT for invalid JSON and NOT_FOUND for an unknown connection', async () => {
    const { service, root } = await twoConnections();
    service.close();
    const bad = await cli(root, ['sync', 'confirm', '1', '-'], '{not json');
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/^error: INVALID_INPUT: Results input is not valid JSON/);
    const unknown = await cli(root, ['sync', 'confirm', '9', 'missing.json', '--json']);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.out).error).toEqual({ code: 'NOT_FOUND', message: 'No connection with id 9.' });
  });
});

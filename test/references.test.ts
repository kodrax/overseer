import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { isOverseerError } from '../src/core/errors.js';
import { parseIssueReference } from '../src/core/references.js';
import type { OverseerService } from '../src/core/service.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { ctx, openService } from './helpers/service.js';
import { tempDir, tempUserConfig } from './helpers/tmp.js';

async function cli(cwd: string, args: string[]) {
  let out = '';
  let err = '';
  const io = {
    stdout: { write: (chunk: string) => (out += chunk) },
    stderr: { write: (chunk: string) => (err += chunk) },
    stdin: Readable.from([]),
  };
  const code = await runCli(args, io, { embedder: new HashEmbedder(), env: { OVERSEER_CONFIG_DIR: tempUserConfig() }, cwd });
  return { code, out, err, json: <T,>(): T => JSON.parse(out) };
}

function failure(run: () => unknown): { code: string; message: string; details: unknown } {
  try {
    run();
  } catch (error) {
    if (isOverseerError(error)) return { code: error.code, message: error.message, details: error.details };
    throw error;
  }
  throw new Error('expected an OverseerError');
}

const issue = (external_id: string, url: string, title: string) => ({ external_id, url, title, state: 'open' });

/**
 * A board with an imported GitHub issue (acme/demo#7 → TASK), an imported GitLab work item (group/sub/project#3 → TASK)
 * and an item synced through a connection's remote ref (tools/cli#12 on GitHub).
 */
async function board(root?: string) {
  const service = openService(root);
  const github = await service.importItems(
    { source: 'github', repo: 'acme/demo', items: [{ ...issue('acme/demo#7', 'https://github.com/acme/demo/issues/7', 'Login fails on Safari'), type_hint: 'task' }] },
    ctx,
  );
  const gitlab = await service.importItems(
    {
      source: 'gitlab',
      repo: 'group/sub/project',
      items: [{ ...issue('group/sub/project#3', 'https://gitlab.com/group/sub/project/-/work_items/3', 'Export the invoices'), type_hint: 'task' }],
    },
    ctx,
  );
  const synced = await service.createItem({ kind: 'bug', title: 'Crash on save' }, ctx);
  const syncedId = synced.created ? synced.item.id : '';
  const connection = service.connections.add({ host: 'github', repository: 'tools/cli' });
  service.db
    .prepare("INSERT INTO item_remote_refs(item_id, connection_id, external_ref, url) VALUES (?, ?, 'tools/cli#12', 'https://github.com/tools/cli/issues/12')")
    .run(syncedId, connection.id);
  return { service, github: github.created[0]!, gitlab: gitlab.created[0]!, synced: syncedId };
}

const idOf = (service: OverseerService, reference: string) => service.getItem(reference).item.id;

describe('parseIssueReference', () => {
  it.each([
    ['#7', { hosts: [], repository: null, number: 7, url: null }],
    [' acme/demo#7 ', { text: 'acme/demo#7', hosts: ['github', 'gitlab'], repository: 'acme/demo', number: 7, url: null }],
    ['github:acme/demo#7', { hosts: ['github'], repository: 'acme/demo', number: 7, url: null }],
    ['GitLab:group/sub/project#3', { hosts: ['gitlab'], repository: 'group/sub/project', number: 3, url: null }],
    ['group/sub/project#3', { hosts: ['gitlab'], repository: 'group/sub/project', number: 3, url: null }],
    [
      'https://github.com/acme/demo/issues/7#issuecomment-1',
      { hosts: ['github'], repository: 'acme/demo', number: 7, url: 'https://github.com/acme/demo/issues/7' },
    ],
    [
      'https://gitlab.com/group/sub/project/-/issues/3?tab=notes',
      { hosts: ['gitlab'], repository: 'group/sub/project', number: 3, url: 'https://gitlab.com/group/sub/project/-/issues/3' },
    ],
    [
      'https://git.example.com/group/project/-/work_items/3/',
      { hosts: ['gitlab'], repository: 'group/project', number: 3, url: 'https://git.example.com/group/project/-/work_items/3' },
    ],
  ])('%s', (text, expected) => {
    expect(parseIssueReference(text)).toMatchObject(expected);
  });

  it.each(['TASK-0012', 'task-12', 'demo#7', 'acme/demo', 'acme/demo#0', 'https://github.com/acme/demo/pull/7', 'https://example.com/acme/demo/issues/7', ''])(
    'ignores %j (not a reference)',
    (text) => {
      expect(parseIssueReference(text)).toBeUndefined();
    },
  );

  it('rejects a GitHub reference with a GitLab-shaped path', () => {
    expect(failure(() => parseIssueReference('github:acme/demo/extra#7')).code).toBe('INVALID_INPUT');
  });
});

describe('get_item by issue reference', () => {
  it('returns the imported or synced item for every reference form, in getItem and getItems', async () => {
    const { service, github, gitlab, synced } = await board();
    for (const reference of ['acme/demo#7', 'github:acme/demo#7', 'https://github.com/acme/demo/issues/7', 'ACME/Demo#7']) {
      expect([reference, idOf(service, reference)]).toEqual([reference, github]);
    }
    for (const reference of [
      'group/sub/project#3',
      'gitlab:group/sub/project#3',
      'https://gitlab.com/group/sub/project/-/issues/3',
      'https://gitlab.com/group/sub/project/-/work_items/3',
    ]) {
      expect([reference, idOf(service, reference)]).toEqual([reference, gitlab]);
    }
    for (const reference of ['tools/cli#12', 'github:tools/cli#12', 'https://github.com/tools/cli/issues/12']) {
      expect([reference, idOf(service, reference)]).toEqual([reference, synced]);
    }
    const many = service.getItems(['acme/demo#7', github.toLowerCase(), 'gitlab:group/sub/project#3', 'tools/cli#12'], { context: true });
    expect(many.items.map((detail) => detail.item.id)).toEqual([github, github, gitlab, synced]);
    // IDs keep their path: an unknown one still names the ID.
    expect(failure(() => service.getItems([github, 'TASK-0099']))).toMatchObject({ code: 'NOT_FOUND', message: 'No item with id TASK-0099.' });
  });

  it('resolves #N in the only connected repository, and asks for owner/repo#N otherwise', async () => {
    const { service, synced } = await board();
    expect(idOf(service, '#12')).toBe(synced);
    expect(service.getItems(['#12']).items[0]!.item.id).toBe(synced);

    service.connections.add({ host: 'gitlab', repository: 'group/sub/project' });
    expect(failure(() => service.getItem('#12'))).toEqual({
      code: 'INVALID_INPUT',
      message: '#12 is ambiguous: 2 repositories are connected (github tools/cli, gitlab group/sub/project). Write owner/repo#12 (group/project#12 on GitLab) or the issue URL.',
      details: undefined,
    });

    const empty = openService();
    expect(failure(() => empty.getItems(['#12']))).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/^#12 is ambiguous: no repository is connected\. /) });
  });

  it('answers NOT_FOUND with what to import for a connected repository', async () => {
    const { service } = await board();
    const expected = (url: string) => ({
      code: 'NOT_FOUND',
      message: `No item for ${url === 'https://github.com/tools/cli/issues/99' ? 'tools/cli#99' : url}: issue tools/cli#99 of the connected GitHub repository is not on the board. Import it (source github, repo tools/cli, external_id tools/cli#99, url ${url}) and retry.`,
      details: { source: 'github', repo: 'tools/cli', external_id: 'tools/cli#99', url },
    });
    expect(failure(() => service.getItem('tools/cli#99'))).toEqual(expected('https://github.com/tools/cli/issues/99'));
    expect(failure(() => service.getItems(['TASK-0001', 'https://github.com/Tools/CLI/issues/99']))).toMatchObject({
      details: { source: 'github', repo: 'tools/cli', external_id: 'tools/cli#99', url: 'https://github.com/Tools/CLI/issues/99' },
    });
    expect(failure(() => service.getItem('#99')).details).toEqual(expected('https://github.com/tools/cli/issues/99').details);

    service.connections.add({ host: 'gitlab', repository: 'group/sub/project' });
    expect(failure(() => service.getItem('group/sub/project#4')).details).toEqual({
      source: 'gitlab',
      repo: 'group/sub/project',
      external_id: 'group/sub/project#4',
      url: 'https://gitlab.com/group/sub/project/-/issues/4',
    });
  });

  it('answers a plain NOT_FOUND naming the reference for an unconnected repository', async () => {
    const { service } = await board();
    // acme/demo is imported but not connected.
    expect(failure(() => service.getItem('acme/demo#8'))).toEqual({ code: 'NOT_FOUND', message: 'No item for acme/demo#8.', details: undefined });
    expect(failure(() => service.getItem('gitlab:tools/cli#99'))).toEqual({ code: 'NOT_FOUND', message: 'No item for gitlab:tools/cli#99.', details: undefined });
  });
});

describe('overseer show by issue reference', () => {
  it('shows the item and prints NOT_FOUND details in the JSON error', async () => {
    const root = tempDir();
    const { service, github, synced } = await board(root);
    service.close();

    const one = await cli(root, ['show', 'https://github.com/acme/demo/issues/7', '--json']);
    expect(one.code).toBe(0);
    expect(one.json<{ item: { id: string } }>().item.id).toBe(github);
    const many = await cli(root, ['show', '#12', 'acme/demo#7', '--json']);
    expect(many.json<{ items: { item: { id: string } }[] }>().items.map((detail) => detail.item.id)).toEqual([synced, github]);
    expect((await cli(root, ['show', 'acme/demo#7'])).out).toContain(`${github}`);

    const missing = await cli(root, ['show', 'tools/cli#99', '--json']);
    expect(missing.code).toBe(1);
    expect(missing.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: expect.stringMatching(/^No item for tools\/cli#99: /),
        details: { source: 'github', repo: 'tools/cli', external_id: 'tools/cli#99', url: 'https://github.com/tools/cli/issues/99' },
      },
    });
    const plain = await cli(root, ['show', 'acme/demo#8', '--json']);
    expect(plain.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'No item for acme/demo#8.' } });
    const text = await cli(root, ['show', 'acme/demo#8']);
    expect(text.err).toBe('error: NOT_FOUND: No item for acme/demo#8.\n');
  });
});

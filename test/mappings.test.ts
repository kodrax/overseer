import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import type { ConnectionMapping, MappingChange } from '../src/core/mappings.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { ctx, openService } from './helpers/service.js';
import { tempDir, tempUserConfig } from './helpers/tmp.js';

async function cli(cwd: string, args: string[], stdin = '') {
  let out = '';
  let err = '';
  const io = {
    stdout: { write: (chunk: string) => (out += chunk) },
    stderr: { write: (chunk: string) => (err += chunk) },
    stdin: Readable.from(stdin === '' ? [] : [stdin]),
  };
  const code = await runCli(args, io, { embedder: new HashEmbedder(), env: { OVERSEER_CONFIG_DIR: tempUserConfig() }, cwd });
  return { code, out, err, json: <T,>(): T => JSON.parse(out) };
}

const errorOf = (run: { json: <T>() => T }) => run.json<{ error: { code: string; message: string } }>().error;

const UNMAPPED = {
  kind: { requirement: null, epic: null, story: null, task: null, bug: null },
  status: {
    proposed: null,
    approved: null,
    implemented: null,
    verified: null,
    deferred: null,
    rejected: null,
    obsolete: null,
    open: null,
    in_progress: null,
    done: null,
    cancelled: null,
    backlog: null,
    ready: null,
    review: null,
  },
  priority: { must: null, should: null, could: null, wont: null },
};

/** A project with a GitHub connection 1 and a GitLab connection 2. */
async function connectedProject(): Promise<string> {
  const root = tempDir();
  await cli(root, ['sync', 'connection', 'add', '--host', 'github', '--repo', 'acme/demo']);
  await cli(root, ['sync', 'connection', 'add', '--host', 'gitlab', '--repo', 'group/project']);
  return root;
}

const mappingOf = async (root: string, connection: string) => (await cli(root, ['sync', 'mapping', connection, '--json'])).json<ConnectionMapping>();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sync mapping set', () => {
  it('stores one remote value per connection, dimension and local value, replacing an earlier one', async () => {
    const root = await connectedProject();
    const set = await cli(root, ['sync', 'mapping', 'set', '1', '--dimension', 'kind', '--local', 'task', '--remote', 'Issue', '--json']);
    expect(set.code).toBe(0);
    expect(set.json<MappingChange>()).toEqual({ connection_id: 1, dimension: 'kind', local_value: 'task', remote_value: 'Issue', previous_value: null });

    const again = await cli(root, ['sync', 'mapping', 'set', '1', '--json', '--dimension', 'kind', '--local', 'task', '--remote', ' Task ']);
    expect(again.json<MappingChange>()).toMatchObject({ remote_value: 'Task', previous_value: 'Issue' });
    const text = await cli(root, ['sync', 'mapping', 'set', '1', '--dimension', 'priority', '--local', 'must', '--remote', 'P1']);
    expect(text.out).toBe('Mapped priority must to "P1" on connection 1.\n');
    const replaced = await cli(root, ['sync', 'mapping', 'set', '1', '--dimension', 'priority', '--local', 'must', '--remote', 'priority: high']);
    expect(replaced.out).toBe('Mapped priority must to "priority: high" on connection 1 (was "P1").\n');
    // Statuses of every kind are local values; two local values may share a remote value.
    for (const status of ['proposed', 'open', 'review', 'done', 'cancelled']) {
      expect((await cli(root, ['sync', 'mapping', 'set', '2', '--dimension', 'status', '--local', status, '--remote', 'closed', '--json'])).code).toBe(0);
    }

    const service = openService(root);
    const rows = service.db.prepare('SELECT connection_id, dimension, local_value, remote_value FROM connection_mappings ORDER BY connection_id, dimension, local_value').all();
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { connection_id: 1, dimension: 'kind', local_value: 'task', remote_value: 'Task' },
      { connection_id: 1, dimension: 'priority', local_value: 'must', remote_value: 'priority: high' },
      ...['cancelled', 'done', 'open', 'proposed', 'review'].map((status) => ({ connection_id: 2, dimension: 'status', local_value: status, remote_value: 'closed' })),
    ]);
    service.close();
  });

  it('answers INVALID_INPUT for a local value the dimension lacks, another dimension or a blank remote value', async () => {
    const root = await connectedProject();
    const cases: [string, string, string, string][] = [
      ['kind', 'feature', 'Feature', 'Invalid kind value "feature"; valid: requirement, epic, story, task, bug.'],
      ['kind', 'Task', 'Task', 'Invalid kind value "Task"; valid: requirement, epic, story, task, bug.'],
      ['priority', 'high', 'P1', 'Invalid priority value "high"; valid: must, should, could, wont.'],
      ['priority', 'task', 'P1', 'Invalid priority value "task"; valid: must, should, could, wont.'],
      [
        'status',
        'closed',
        'closed',
        'Invalid status value "closed"; valid: proposed, approved, implemented, verified, deferred, rejected, obsolete, open, in_progress, done, cancelled, backlog, ready, review.',
      ],
      ['severity', 'major', 'S1', 'Invalid dimension "severity"; valid: kind, status, priority.'],
      ['kind', 'task', '  ', 'Remote value must hold 1 to 255 characters.'],
      ['kind', 'task', 'x'.repeat(256), 'Remote value must hold 1 to 255 characters.'],
    ];
    for (const [dimension, local, remote, message] of cases) {
      const run = await cli(root, ['sync', 'mapping', 'set', '1', '--dimension', dimension, '--local', local, '--remote', remote, '--json']);
      expect([run.code, errorOf(run)], `${dimension} ${local}`).toEqual([1, { code: 'INVALID_INPUT', message }]);
    }
    expect((await mappingOf(root, '1')).mapping).toEqual(UNMAPPED);
  });
});

describe('sync mapping', () => {
  it('lists every local value grouped by dimension, unmapped ones as null in JSON and (unmapped) in text', async () => {
    const root = await connectedProject();
    expect(await mappingOf(root, '1')).toEqual({ connection_id: 1, mapping: UNMAPPED });
    await cli(root, ['sync', 'mapping', 'set', '1', '--dimension', 'kind', '--local', 'bug', '--remote', 'Bug']);
    await cli(root, ['sync', 'mapping', 'set', '1', '--dimension', 'status', '--local', 'in_progress', '--remote', 'status: doing']);
    await cli(root, ['sync', 'mapping', 'set', '1', '--dimension', 'priority', '--local', 'wont', '--remote', 'wontfix']);
    await cli(root, ['sync', 'mapping', 'set', '2', '--dimension', 'kind', '--local', 'task', '--remote', 'Task']);

    const listed = await mappingOf(root, '1');
    expect(listed).toEqual({
      connection_id: 1,
      mapping: {
        kind: { ...UNMAPPED.kind, bug: 'Bug' },
        status: { ...UNMAPPED.status, in_progress: 'status: doing' },
        priority: { ...UNMAPPED.priority, wont: 'wontfix' },
      },
    });
    expect(Object.keys(listed.mapping)).toEqual(['kind', 'status', 'priority']);
    expect(Object.keys(listed.mapping.kind)).toEqual(['requirement', 'epic', 'story', 'task', 'bug']);

    const lines = (await cli(root, ['sync', 'mapping', '1'])).out.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^Dimension +Local +Remote$/);
    expect(lines.slice(2)).toHaveLength(5 + 14 + 4);
    expect(lines[2]).toMatch(/^kind +requirement +\(unmapped\)$/);
    expect(lines[6]).toMatch(/^kind +bug +Bug$/);
    expect(lines.find((line) => line.includes('in_progress'))).toMatch(/^status +in_progress +status: doing$/);
    expect(lines.find((line) => line.includes('backlog'))).toMatch(/^status +backlog +\(unmapped\)$/);
    expect(lines.at(-1)).toMatch(/^priority +wont +wontfix$/);
  });
});

describe('sync mapping import', () => {
  const mapping = {
    kind: { requirement: 'requirement', epic: 'epic', story: 'Feature', task: 'Task', bug: 'Bug' },
    status: { done: 'closed', cancelled: 'closed', in_progress: null },
    priority: { must: 'P1', should: 'P2' },
  };

  it('replaces the whole mapping from a file or stdin, leaving other connections alone', async () => {
    const root = await connectedProject();
    await cli(root, ['sync', 'mapping', 'set', '1', '--dimension', 'status', '--local', 'review', '--remote', 'needs review']);
    await cli(root, ['sync', 'mapping', 'set', '1', '--dimension', 'priority', '--local', 'must', '--remote', 'urgent']);
    await cli(root, ['sync', 'mapping', 'set', '2', '--dimension', 'kind', '--local', 'task', '--remote', 'Task']);
    const file = join(tempDir(), 'mapping.json');
    writeFileSync(file, JSON.stringify(mapping));

    const imported = await cli(root, ['sync', 'mapping', 'import', '1', file, '--json']);
    expect(imported.code).toBe(0);
    const expected = {
      connection_id: 1,
      mapping: {
        kind: mapping.kind,
        status: { ...UNMAPPED.status, done: 'closed', cancelled: 'closed' },
        priority: { ...UNMAPPED.priority, must: 'P1', should: 'P2' },
      },
    };
    expect(imported.json<ConnectionMapping>()).toEqual(expected);
    expect(await mappingOf(root, '1')).toEqual(expected);
    expect((await mappingOf(root, '2')).mapping.kind.task).toBe('Task');

    // stdin, with the listing's own "mapping" object: connection 2 gets connection 1's mapping.
    const piped = await cli(root, ['sync', 'mapping', 'import', '2', '-'], JSON.stringify(expected.mapping));
    expect(piped.code).toBe(0);
    expect(piped.out).toMatch(/^Replaced the mapping of connection 2\.\nDimension +Local +Remote\n/);
    expect(piped.out).toMatch(/^kind +story +Feature$/m);
    expect((await mappingOf(root, '2')).mapping).toEqual(expected.mapping);

    // Only one dimension: the others become unmapped.
    const kindOnly = await cli(root, ['sync', 'mapping', 'import', '1', '-', '--json'], '{"kind": {"bug": "defect"}}');
    expect(kindOnly.json<ConnectionMapping>().mapping).toEqual({ ...UNMAPPED, kind: { ...UNMAPPED.kind, bug: 'defect' } });
    expect((await cli(root, ['sync', 'mapping', 'import', '1', '-', '--json'], '{}')).json<ConnectionMapping>().mapping).toEqual(UNMAPPED);
  });

  it('rejects an invalid mapping with INVALID_INPUT listing every problem and leaves the old mapping untouched', async () => {
    const root = await connectedProject();
    const file = join(tempDir(), 'mapping.json');
    writeFileSync(file, JSON.stringify(mapping));
    await cli(root, ['sync', 'mapping', 'import', '1', file]);
    const before = await mappingOf(root, '1');

    const invalid = {
      kind: { task: 'Task', feature: 'Feature' },
      status: { done: '' },
      priority: { must: 1 },
      severity: { major: 'S1' },
    };
    const run = await cli(root, ['sync', 'mapping', 'import', '1', '-', '--json'], JSON.stringify(invalid));
    expect(run.code).toBe(1);
    const error = errorOf(run);
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('input: unknown dimension "severity"; valid: kind, status, priority');
    expect(error.message).toContain('kind: unknown kind value "feature"; valid: requirement, epic, story, task, bug');
    expect(error.message).toContain('status.done: ');
    expect(error.message).toContain('priority.must: ');

    const inputs: [string, RegExp][] = [
      ['[]', /^input: expected an object keyed by dimension \(kind, status, priority\)$/],
      ['{"kind": ["task"]}', /^kind: expected an object keyed by kind value \(requirement, epic, story, task, bug\)$/],
      ['{"kind": {"task": "Task"}, "status": {"closed": "closed"}}', /^status: unknown status value "closed"; valid: proposed, /],
      ['not json', /^Mapping input is not valid JSON: /],
      ['', /^Mapping input is not valid JSON: /],
    ];
    for (const [stdin, message] of inputs) {
      const failed = await cli(root, ['sync', 'mapping', 'import', '1', '-', '--json'], stdin);
      expect([failed.code, errorOf(failed).code], stdin).toEqual([1, 'INVALID_INPUT']);
      expect(errorOf(failed).message, stdin).toMatch(message);
    }
    const missing = await cli(root, ['sync', 'mapping', 'import', '1', join(root, 'missing.json'), '--json']);
    expect(errorOf(missing)).toEqual({ code: 'INVALID_INPUT', message: `Mapping file not found: ${join(root, 'missing.json')}` });
    expect(await mappingOf(root, '1')).toEqual(before);
  });
});

describe('unknown connections', () => {
  it('every mapping command answers NOT_FOUND, before validating the rest of the input', async () => {
    const root = await connectedProject();
    const commands: [string[], string][] = [
      [['sync', 'mapping', '3'], ''],
      [['sync', 'mapping', 'set', '3', '--dimension', 'kind', '--local', 'task', '--remote', 'Task'], ''],
      [['sync', 'mapping', 'set', '3', '--dimension', 'severity', '--local', 'major', '--remote', 'S1'], ''],
      [['sync', 'mapping', 'import', '3', '-'], '{"kind": {"task": "Task"}}'],
      [['sync', 'mapping', 'import', '3', '-'], 'not json'],
      [['sync', 'mapping', 'import', '3', join(root, 'missing.json')], ''],
    ];
    for (const [args, stdin] of commands) {
      const run = await cli(root, [...args, '--json'], stdin);
      expect([run.code, errorOf(run)], args.join(' ')).toEqual([1, { code: 'NOT_FOUND', message: 'No connection with id 3.' }]);
    }
    const service = openService(root);
    expect(Number(service.db.prepare('SELECT count(*) AS n FROM connection_mappings').get()!.n)).toBe(0);
    service.close();
  });
});

describe('mapping service', () => {
  it('records nothing in item history and makes no GitHub or GitLab call', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const root = await connectedProject();
    const service = openService(root);
    const created = await service.createItem({ kind: 'task', title: 'Send the reset email' }, ctx);
    const itemId = created.created ? created.item.id : '';
    const events = service.history(itemId).length;
    service.mappings.set(1, { dimension: 'kind', local_value: 'task', remote_value: 'Task' });
    service.mappings.replace('1', { status: { done: 'closed' } });
    expect(service.mappings.get(1).mapping.status.done).toBe('closed');
    expect(service.mappings.get(1).mapping.kind.task).toBeNull();
    expect(service.history(itemId)).toHaveLength(events);
    service.close();
    expect(fetch).not.toHaveBeenCalled();
  });
});

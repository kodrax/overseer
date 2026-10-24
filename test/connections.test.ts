import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import type { Connection, ConnectionRemoval, SourceOfTruth } from '../src/core/connections.js';
import { isOverseerError } from '../src/core/errors.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { ctx, openService } from './helpers/service.js';
import { tempDir, tempUserConfig } from './helpers/tmp.js';

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

const errorCode = (run: { json: <T>() => T }) => run.json<{ error: { code: string; message: string } }>().error;

function failure(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (isOverseerError(error)) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected an OverseerError');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sync connection add', () => {
  it('stores a connection with auto-sync on and shows id, host, repository, MCP server and auto_sync', async () => {
    const root = tempDir();
    const json = await cli(root, ['sync', 'connection', 'add', '--host', 'github', '--repo', 'acme/demo', '--mcp-server', 'github', '--json']);
    expect(json.code).toBe(0);
    const added = json.json<Connection>();
    expect(added).toEqual({
      id: 1,
      host: 'github',
      repository: 'acme/demo',
      mcp_server: 'github',
      auto_sync: true,
      last_sync_cursor: null,
      sync_started_at: null,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });

    const text = await cli(root, ['sync', 'connection', 'add', '--host', 'gitlab', '--repo', '/group/sub/project.git/']);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/^id: +2$/m);
    expect(text.out).toMatch(/^host: +gitlab$/m);
    expect(text.out).toMatch(/^repository: +group\/sub\/project$/m);
    expect(text.out).toMatch(/^mcp_server: +-$/m);
    expect(text.out).toMatch(/^sync_started_at: +-$/m);
    expect(text.out).toMatch(/^auto_sync: +on$/m);

    const service = openService(root);
    expect(service.connections.require(1)).toEqual(added);
    expect(service.connections.get('2')?.mcp_server).toBeNull();
    service.close();
  });

  it('answers CONFLICT naming the existing connection for the same host and repository', async () => {
    const root = tempDir();
    await cli(root, ['sync', 'connection', 'add', '--host', 'github', '--repo', 'acme/demo', '--json']);
    for (const repo of ['acme/demo', 'Acme/Demo.git']) {
      const again = await cli(root, ['sync', 'connection', 'add', '--host', 'github', '--repo', repo, '--json']);
      expect(again.code).toBe(1);
      expect(errorCode(again)).toEqual({ code: 'CONFLICT', message: 'github acme/demo is already connection 1.', details: { id: 1 } });
    }
    // The same path on the other host is another repository.
    expect((await cli(root, ['sync', 'connection', 'add', '--host', 'gitlab', '--repo', 'acme/demo', '--json'])).json<Connection>().id).toBe(2);
    expect((await cli(root, ['sync', 'connections', '--json'])).json<Connection[]>()).toHaveLength(2);
  });

  it('answers INVALID_INPUT for other hosts and repositories that are not owner/repo or group/…/project', async () => {
    const root = tempDir();
    const cases: [string, string, RegExp][] = [
      ['bitbucket', 'acme/demo', /^Invalid host "bitbucket"; valid: github, gitlab\.$/],
      ['github', 'acme', /^Invalid GitHub repository "acme"; expected owner\/repo/],
      ['github', 'acme/demo/extra', /^Invalid GitHub repository/],
      ['github', 'https://github.com/acme/demo', /^Invalid GitHub repository/],
      ['github', 'acme//demo', /^Invalid GitHub repository/],
      ['github', 'acme/..', /^Invalid GitHub repository/],
      ['github', 'acme/de mo', /^Invalid GitHub repository/],
      ['gitlab', 'group', /^Invalid GitLab repository "group"; expected group\/project or group\/subgroup\/…\/project\.$/],
      ['gitlab', '', /^Invalid GitLab repository/],
    ];
    for (const [host, repo, message] of cases) {
      const run = await cli(root, ['sync', 'connection', 'add', '--host', host, '--repo', repo, '--json']);
      expect(run.code, `${host} ${repo}`).toBe(1);
      expect(errorCode(run).code).toBe('INVALID_INPUT');
      expect(errorCode(run).message).toMatch(message);
    }
    const blankServer = await cli(root, ['sync', 'connection', 'add', '--host', 'github', '--repo', 'acme/demo', '--mcp-server', ' ', '--json']);
    expect(errorCode(blankServer).code).toBe('INVALID_INPUT');
    expect((await cli(root, ['sync', 'connections', '--json'])).json()).toEqual([]);
  });
});

describe('sync connections, connection set and connection remove', () => {
  it('lists every connection, in JSON and as a table', async () => {
    const root = tempDir();
    expect((await cli(root, ['sync', 'connections', '--json'])).json()).toEqual({ initialized: false, root });
    await cli(root, ['init']);
    expect((await cli(root, ['sync', 'connections', '--json'])).json()).toEqual([]);
    expect((await cli(root, ['sync', 'connections'])).out).toBe('No connections.\n');
    await cli(root, ['sync', 'connection', 'add', '--host', 'github', '--repo', 'acme/demo', '--mcp-server', 'github']);
    await cli(root, ['sync', 'connection', 'add', '--host', 'gitlab', '--repo', 'group/sub/project']);

    const json = await cli(root, ['sync', 'connections', '--json']);
    expect(json.json<Connection[]>().map(({ id, host, repository, mcp_server, auto_sync }) => ({ id, host, repository, mcp_server, auto_sync }))).toEqual([
      { id: 1, host: 'github', repository: 'acme/demo', mcp_server: 'github', auto_sync: true },
      { id: 2, host: 'gitlab', repository: 'group/sub/project', mcp_server: null, auto_sync: true },
    ]);

    const lines = (await cli(root, ['sync', 'connections'])).out.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^Id +Host +Repository +MCP server +Auto-sync +Last sync +Sync started$/);
    expect(lines[2]).toMatch(/^1 +github +acme\/demo +github +on +- +-$/);
    expect(lines[3]).toMatch(/^2 +gitlab +group\/sub\/project +- +on +- +-$/);
  });

  it('set changes auto-sync and the MCP server; unknown ids, bad states and empty changes fail', async () => {
    const root = tempDir();
    await cli(root, ['sync', 'connection', 'add', '--host', 'gitlab', '--repo', 'group/project']);

    const off = await cli(root, ['sync', 'connection', 'set', '1', '--auto-sync', 'off', '--mcp-server', 'gitlab-work', '--json']);
    expect(off.code).toBe(0);
    expect(off.json<Connection>()).toMatchObject({ id: 1, auto_sync: false, mcp_server: 'gitlab-work' });
    const on = await cli(root, ['sync', 'connection', 'set', '1', '--auto-sync', 'on']);
    expect(on.out).toMatch(/^auto_sync: +on$/m);
    expect(on.out).toMatch(/^mcp_server: +gitlab-work$/m);
    const server = await cli(root, ['sync', 'connection', 'set', '1', '--mcp-server', 'gitlab', '--json']);
    expect(server.json<Connection>()).toMatchObject({ auto_sync: true, mcp_server: 'gitlab' });

    const failures: [string[], string][] = [
      [['2', '--auto-sync', 'off'], 'NOT_FOUND'],
      [['abc', '--auto-sync', 'off'], 'INVALID_INPUT'],
      [['1', '--auto-sync', 'maybe'], 'INVALID_INPUT'],
      [['1'], 'INVALID_INPUT'],
    ];
    for (const [args, code] of failures) {
      const run = await cli(root, ['sync', 'connection', 'set', ...args, '--json']);
      expect([run.code, errorCode(run).code], args.join(' ')).toEqual([1, code]);
    }
  });

  it('remove deletes the connection with its remote refs, mappings and pending outbox rows and reports them', async () => {
    const root = tempDir();
    await cli(root, ['sync', 'connection', 'add', '--host', 'github', '--repo', 'acme/demo']);
    await cli(root, ['sync', 'connection', 'add', '--host', 'gitlab', '--repo', 'group/project']);
    const service = openService(root);
    const created = await service.createItem({ kind: 'task', title: 'Send the reset email' }, ctx);
    const itemId = created.created ? created.item.id : '';
    const insertRef = service.db.prepare('INSERT INTO item_remote_refs(item_id, connection_id, external_ref) VALUES (?, ?, ?)');
    const insertMapping = service.db.prepare('INSERT INTO connection_mappings(connection_id, dimension, local_value, remote_value) VALUES (?, ?, ?, ?)');
    const insertOutbox = service.db.prepare("INSERT INTO sync_outbox(connection_id, item_id, operation, created_at) VALUES (?, ?, 'update', '2026-10-20T00:00:00Z')");
    for (const connection of [1, 2]) {
      insertRef.run(itemId, connection, `ref-${connection}`);
      insertMapping.run(connection, 'kind', 'bug', 'bug');
      insertMapping.run(connection, 'priority', 'must', 'P1');
      // The create already queued one outbox row per connection; two more make three.
      insertOutbox.run(connection, itemId);
      insertOutbox.run(connection, itemId);
    }
    const events = service.history(itemId).length;

    const removed = await cli(root, ['sync', 'connection', 'remove', '1', '--json']);
    expect(removed.code).toBe(0);
    expect(removed.json<ConnectionRemoval>()).toMatchObject({ removed: { id: 1, host: 'github', repository: 'acme/demo' }, remote_refs: 1, mappings: 2, outbox: 3 });
    const count = (table: string, connection: number) =>
      Number(service.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE connection_id = ?`).get(connection)!.n);
    for (const table of ['item_remote_refs', 'connection_mappings', 'sync_outbox']) {
      expect([count(table, 1), table]).toEqual([0, table]);
      expect(count(table, 2)).toBeGreaterThan(0);
    }
    expect(service.connections.list().map((connection) => connection.id)).toEqual([2]);
    expect(service.history(itemId)).toHaveLength(events);

    const text = await cli(root, ['sync', 'connection', 'remove', '2']);
    expect(text.out).toBe('Removed connection 2 (gitlab group/project) with 1 remote refs, 2 mappings and 3 outbox rows.\n');
    const again = await cli(root, ['sync', 'connection', 'remove', '2', '--json']);
    expect([again.code, errorCode(again)]).toEqual([1, { code: 'NOT_FOUND', message: 'No connection with id 2.' }]);
    service.close();
  });
});

describe('sync source-of-truth', () => {
  const board: SourceOfTruth = {
    source_of_truth: 'board',
    host: null,
    repository: null,
    reason: 'No connection started sync while the board was the source of truth; the first one that does becomes the source of truth.',
  };
  /** `sync start <id>` on an empty repository. */
  const start = (root: string, id: number) => cli(root, ['sync', 'start', String(id), '-', '--json'], '[]');
  const sourceOfTruth = async (root: string) => (await cli(root, ['sync', 'source-of-truth', '--json'])).json<SourceOfTruth>();
  const startedAt = (root: string, id: number) => {
    const service = openService(root);
    const at = service.connections.require(id).sync_started_at;
    service.close();
    return at;
  };

  it('is the board, with why, with no connection or no started sync (TASK-0066 AC1)', async () => {
    const root = tempDir();
    await cli(root, ['init']);
    const json = await cli(root, ['sync', 'source-of-truth', '--json']);
    expect([json.code, json.json<SourceOfTruth>()]).toEqual([0, board]);
    expect((await cli(root, ['sync', 'source-of-truth'])).out).toBe(`source_of_truth:  board\nreason:           ${board.reason}\n`);

    await cli(root, ['sync', 'connection', 'add', '--host', 'github', '--repo', 'acme/demo']);
    await cli(root, ['sync', 'connection', 'add', '--host', 'gitlab', '--repo', 'group/project']);
    expect(await sourceOfTruth(root)).toEqual(board);
    expect((await cli(root, ['sync', 'status', '--json'])).json()).toMatchObject({ source_of_truth: 'board' });
    expect((await cli(root, ['sync', 'status'])).out).toMatch(/\nSource of truth: board\n$/);

    // A start that fails (a GitLab listing for a GitHub connection) changes nothing.
    expect((await cli(root, ['sync', 'start', '1', '-', '--json'], '{"items": [], "pageInfo": {}}')).code).toBe(1);
    expect(await sourceOfTruth(root)).toEqual(board);
  });

  it('becomes the first connection whose sync starts, and later starts leave it (TASK-0066 AC2, AC3)', async () => {
    const root = tempDir();
    await cli(root, ['sync', 'connection', 'add', '--host', 'github', '--repo', 'acme/demo']);
    await cli(root, ['sync', 'connection', 'add', '--host', 'gitlab', '--repo', 'group/sub/project']);

    expect((await start(root, 1)).code).toBe(0);
    const github: SourceOfTruth = {
      source_of_truth: 1,
      host: 'github',
      repository: 'acme/demo',
      reason: `Sync of connection 1 (github acme/demo) started at ${startedAt(root, 1)} while the board was the source of truth.`,
    };
    expect(await sourceOfTruth(root)).toEqual(github);
    expect((await cli(root, ['sync', 'source-of-truth'])).out).toBe(
      `source_of_truth:  1\nhost:             github\nrepository:       acme/demo\nreason:           ${github.reason}\n`,
    );

    expect((await start(root, 2)).code).toBe(0);
    expect(startedAt(root, 2)).not.toBeNull();
    expect(await sourceOfTruth(root)).toEqual(github);
    expect((await cli(root, ['sync', 'status', '--json'])).json()).toMatchObject({ source_of_truth: { id: 1, host: 'github', repository: 'acme/demo' } });
    expect((await cli(root, ['sync', 'status'])).out).toMatch(/\nSource of truth: connection 1 \(github acme\/demo\)\n$/);
  });

  it('goes back to the board when its connection is removed, even with another started one; removing another keeps it (TASK-0066 AC4)', async () => {
    const root = tempDir();
    for (const repo of ['acme/demo', 'acme/other', 'acme/third']) await cli(root, ['sync', 'connection', 'add', '--host', 'github', '--repo', repo]);
    await start(root, 1);
    await start(root, 2);

    const other = await cli(root, ['sync', 'connection', 'remove', '3', '--json']);
    expect(other.json<ConnectionRemoval>().source_of_truth_reset).toBe(false);
    expect(await sourceOfTruth(root)).toMatchObject({ source_of_truth: 1 });

    const text = await cli(root, ['sync', 'connection', 'remove', '1']);
    expect(text.out).toMatch(/^Removed connection 1 \(github acme\/demo\) with .*\nSource of truth reset to board\.\n$/);
    expect(await sourceOfTruth(root)).toEqual(board);
    expect((await cli(root, ['sync', 'status', '--json'])).json()).toMatchObject({ source_of_truth: 'board', connections: [{ id: 2, sync_started_at: expect.any(String) }] });

    // The board is the source of truth again: the next connection whose sync starts takes it.
    const added = (await cli(root, ['sync', 'connection', 'add', '--host', 'gitlab', '--repo', 'group/project', '--json'])).json<Connection>();
    await start(root, added.id);
    expect(await sourceOfTruth(root)).toMatchObject({ source_of_truth: added.id, host: 'gitlab', repository: 'group/project' });
    const json = await cli(root, ['sync', 'connection', 'remove', String(added.id), '--json']);
    expect(json.json<ConnectionRemoval>()).toMatchObject({ removed: { id: added.id }, source_of_truth_reset: true });
    expect(await sourceOfTruth(root)).toEqual(board);
  });

  it('has no set command: it only shows the derived value (TASK-0066 AC5)', async () => {
    const root = tempDir();
    await cli(root, ['sync', 'connection', 'add', '--host', 'github', '--repo', 'acme/demo']);
    for (const target of ['1', 'board']) {
      const set = await cli(root, ['sync', 'source-of-truth', 'set', target, '--json']);
      expect([set.code, errorCode(set).code], target).toEqual([1, 'INVALID_INPUT']);
      expect(errorCode(set).message).toMatch(/^too many arguments for 'source-of-truth'/);
    }
    expect(await sourceOfTruth(root)).toEqual(board);
    const help = await cli(root, ['sync', 'source-of-truth', '--help']);
    expect(help.out).not.toMatch(/\bset\b/);
  });
});

describe('connections service', () => {
  it('looks connections up by id and validates ids', () => {
    const service = openService(tempDir());
    const added = service.connections.add({ host: 'GitHub', repository: ' acme/demo ', mcp_server: ' github ' });
    expect(added).toMatchObject({ id: 1, host: 'github', repository: 'acme/demo', mcp_server: 'github', auto_sync: true });
    expect(service.connections.get(1)).toEqual(added);
    expect(service.connections.get(99)).toBeUndefined();
    expect(failure(() => service.connections.require(99))).toEqual({ code: 'NOT_FOUND', message: 'No connection with id 99.' });
    for (const id of ['0', '-1', '1.5', 'x']) expect(failure(() => service.connections.get(id)).code).toBe('INVALID_INPUT');
    service.close();
  });
});

describe('sync status', () => {
  it('with no connection says so and names the board as source of truth', async () => {
    const root = tempDir();
    await cli(root, ['init']);
    const json = await cli(root, ['sync', 'status', '--json']);
    expect([json.code, json.json()]).toEqual([0, { connections: [], source_of_truth: 'board' }]);
    expect((await cli(root, ['sync', 'status'])).out).toBe('No connections.\nSource of truth: board\n');
  });

  it('shows each connection with its pending outbox count and the source of truth with host and repository', async () => {
    const root = tempDir();
    await cli(root, ['sync', 'connection', 'add', '--host', 'github', '--repo', 'acme/demo', '--mcp-server', 'github']);
    await cli(root, ['sync', 'connection', 'add', '--host', 'gitlab', '--repo', 'group/sub/project']);
    await cli(root, ['sync', 'connection', 'set', '2', '--auto-sync', 'off']);
    const service = openService(root);
    const insertOutbox = service.db.prepare("INSERT INTO sync_outbox(connection_id, item_id, operation, created_at) VALUES (?, 'TASK-0001', 'update', '2026-10-20T00:00:00Z')");
    for (const connection of [1, 1, 2]) insertOutbox.run(connection);
    service.db.prepare("UPDATE connections SET last_sync_cursor = '2026-10-20T12:00:00Z' WHERE id = 2").run();
    service.db.prepare("UPDATE connections SET sync_started_at = '2026-10-19T09:00:00Z' WHERE id = 1").run();
    service.close();

    const json = await cli(root, ['sync', 'status', '--json']);
    const state = (id: number, rest: Partial<Connection>, pending: number) => expect.objectContaining({ id, ...rest, pending_outbox: pending });
    expect(json.json()).toEqual({
      connections: [
        state(1, { host: 'github', repository: 'acme/demo', mcp_server: 'github', auto_sync: true, last_sync_cursor: null, sync_started_at: '2026-10-19T09:00:00Z' }, 2),
        state(2, { host: 'gitlab', repository: 'group/sub/project', mcp_server: null, auto_sync: false, last_sync_cursor: '2026-10-20T12:00:00Z', sync_started_at: null }, 1),
      ],
      source_of_truth: 'board',
    });

    await cli(root, ['sync', 'start', '2', '-'], '[]');
    expect((await cli(root, ['sync', 'status', '--json'])).json()).toMatchObject({
      source_of_truth: { id: 2, host: 'gitlab', repository: 'group/sub/project' },
    });
    const text = (await cli(root, ['sync', 'status'])).out;
    expect(text).toMatch(/Pending outbox/);
    expect(text).toMatch(/1 +github +acme\/demo +github +on +never +2026-10-19T09:00:00Z +2/);
    expect(text).toMatch(/2 +gitlab +group\/sub\/project +- +off +2026-10-20T12:00:00Z +\d{4}-\d{2}-\d{2}T\S+ +1/);
    expect(text).toMatch(/\nSource of truth: connection 2 \(gitlab group\/sub\/project\)\n$/);
  });
});

describe('no GitHub or GitLab calls', () => {
  it('connection commands and item changes without a connection only touch the local database', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const root = tempDir();
    expect((await cli(root, ['add', 'task', '--title', 'Send the reset email', '--json'])).code).toBe(0);
    expect((await cli(root, ['update', 'TASK-0001', '--status', 'in_progress', '--json'])).code).toBe(0);
    expect((await cli(root, ['sync', 'connections', '--json'])).json()).toEqual([]);
    await cli(root, ['sync', 'connection', 'add', '--host', 'github', '--repo', 'acme/demo', '--mcp-server', 'github']);
    await cli(root, ['sync', 'connection', 'set', '1', '--auto-sync', 'off']);
    expect((await cli(root, ['sync', 'source-of-truth', '--json'])).code).toBe(0);
    expect((await cli(root, ['sync', 'status', '--json'])).code).toBe(0);
    expect((await cli(root, ['sync', 'status'])).code).toBe(0);
    await cli(root, ['sync', 'connection', 'remove', '1']);
    expect((await cli(root, ['sync', 'status', '--json'])).code).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

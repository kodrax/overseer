import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { databaseFile, loadVec, openDatabase } from '../src/core/db.js';
import { createVecTableSql, EMBED_DIMS, MIGRATIONS, SCHEMA_VERSION, VEC_TABLES } from '../src/core/migrations.js';
import { ensureDataDir } from '../src/core/project.js';
import { ctx, openService } from './helpers/service.js';
import { tempRepo } from './helpers/tmp.js';

const V1_TABLES = ['meta', 'counters', 'items', 'links', 'events', 'items_fts', 'item_embeddings', 'sqlite_sequence'];
const SYNC_TABLES = ['connections', 'item_remote_refs', 'connection_mappings', 'sync_outbox', 'tombstones', 'sync_source_of_truth'];
const T = '2026-10-01T10:00:00-03:00';

/** A schema_version 1 database as the previous release created it, filled with items, links, events and an external_ref. */
function createV1Database(root: string): void {
  ensureDataDir(root);
  const db = new DatabaseSync(databaseFile(root), { allowExtension: true });
  const vec = loadVec(db);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  MIGRATIONS[0]!(db, { root, now: T });
  db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '1')");
  if (vec) for (const table of VEC_TABLES) db.exec(createVecTableSql(table, EMBED_DIMS));
  const item = db.prepare(
    `INSERT INTO items(id, kind, title, description, status, req_type, recorded_via, in_backlog, parent_id, tags,
       external_ref, external_url, external_state, external_synced_at, created_at, updated_at, status_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'cli', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  item.run('REQ-0001', 'requirement', 'Sign in', 'Users sign in', 'approved', 'functional', 1, null, '["auth"]',
    null, null, null, null, T, T, T);
  item.run('US-0001', 'story', 'Sign in form', '', 'backlog', null, 0, null, '[]', null, null, null, null, T, T, T);
  item.run('TASK-0001', 'task', 'Build the form', 'Form fields', 'in_progress', null, 0, 'US-0001', '[]',
    'acme/app#42', 'https://github.com/acme/app/issues/42', 'open', T, T, T, T);
  db.exec(`INSERT INTO counters(kind, next_seq) VALUES ('requirement', 2), ('story', 2), ('task', 2);
    INSERT INTO links(src, rel, dst, created_at) VALUES ('US-0001', 'implements', 'REQ-0001', '${T}'),
      ('TASK-0001', 'depends_on', 'US-0001', '${T}');
    INSERT INTO items_fts(rowid, title, body) SELECT rid, title, description FROM items;
    INSERT INTO item_embeddings(rid, content_hash, model) SELECT rid, 'hash-' || id, 'hash' FROM items;`);
  const event = db.prepare(
    `INSERT INTO events(item_id, at, actor, via, action, field, old_value, new_value) VALUES (?, '${T}', 'tester', 'cli', ?, ?, ?, ?)`,
  );
  event.run('REQ-0001', 'create', null, null, null);
  event.run('US-0001', 'create', null, null, null);
  event.run('US-0001', 'link', 'implements', null, 'REQ-0001');
  event.run('TASK-0001', 'import', null, null, 'acme/app#42');
  event.run('TASK-0001', 'status', 'status', '"backlog"', '"in_progress"');
  event.run('TASK-0001', 'comment', null, null, 'Started');
  // A gap in seq and a counter above the last row, as left by a rolled-back insert.
  db.exec("DELETE FROM events WHERE seq = 2; UPDATE sqlite_sequence SET seq = 9 WHERE name = 'events'; COMMIT");
  db.close();
}

/** Every row of `tables`; meta without schema_version, the one row a migration is meant to change. */
function snapshot(db: DatabaseSync, tables: string[]): Record<string, unknown[]> {
  return Object.fromEntries(
    tables.map((table) => {
      const columns = table === 'items_fts' ? 'rowid, *' : '*';
      const where = table === 'meta' ? " WHERE key <> 'schema_version'" : '';
      return [table, db.prepare(`SELECT ${columns} FROM ${table}${where} ORDER BY 1, 2`).all()];
    }),
  );
}

const SCHEMA_VERSION_SQL = "SELECT value FROM meta WHERE key = 'schema_version'";

describe('migrations', () => {
  it('migrates a version-1 database to the current version keeping every row and adding empty sync tables', () => {
    const root = tempRepo();
    createV1Database(root);
    const v1 = new DatabaseSync(databaseFile(root));
    const before = snapshot(v1, V1_TABLES);
    expect(() =>
      v1.exec(`INSERT INTO events(item_id, at, actor, via, action) VALUES ('TASK-0001', '${T}', 'tester', 'cli', 'delete')`),
    ).toThrow(/CHECK constraint failed/);
    v1.close();

    const { db } = openDatabase(root, { create: false })!;
    expect(SCHEMA_VERSION).toBe(5);
    expect(db.prepare(SCHEMA_VERSION_SQL).get()).toEqual({ value: '5' });
    const after = snapshot(db, V1_TABLES);
    expect(after).toEqual(before);
    expect(before.events).toHaveLength(5);
    expect(after.sqlite_sequence).toContainEqual({ name: 'events', seq: 9 });
    expect(db.prepare("SELECT external_ref FROM items WHERE id = 'TASK-0001'").get()).toEqual({ external_ref: 'acme/app#42' });
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'events_item'").get()).toEqual({
      sql: 'CREATE INDEX events_item ON events(item_id, seq)',
    });
    for (const table of SYNC_TABLES) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'events_new'").get()).toBeUndefined();

    db.prepare(
      `INSERT INTO events(item_id, at, actor, via, action) VALUES ('TASK-0001', '${T}', 'tester', 'cli', 'delete')`,
    ).run();
    expect(db.prepare("SELECT seq, action FROM events WHERE action = 'delete'").get()).toEqual({ seq: 10, action: 'delete' });
    db.close();
  });

  it('migrates a version-2 database to the current version, adding sync_started_at and sync_start_baseline null to existing connections', () => {
    const root = tempRepo();
    createV1Database(root);
    const v2 = new DatabaseSync(databaseFile(root));
    v2.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    MIGRATIONS[1]!(v2, { root, now: T });
    v2.exec(`UPDATE meta SET value = '2' WHERE key = 'schema_version';
      INSERT INTO connections(host, repository, mcp_server, created_at) VALUES ('github', 'acme/app', 'github', '${T}');
      COMMIT`);
    v2.close();

    const { db } = openDatabase(root, { create: false })!;
    expect(db.prepare(SCHEMA_VERSION_SQL).get()).toEqual({ value: '5' });
    expect(db.prepare('SELECT id, repository, sync_started_at, sync_start_baseline FROM connections').all()).toEqual([
      { id: 1, repository: 'acme/app', sync_started_at: null, sync_start_baseline: null },
    ]);
    db.close();
  });

  /** A schema_version 3 or 4 database with two connections and a manual source-of-truth choice of connection 2. */
  function createOldDatabase(root: string, version: 3 | 4, startedAt: [string | null, string | null]): void {
    createV1Database(root);
    const old = new DatabaseSync(databaseFile(root));
    old.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    for (let migration = 1; migration < version; migration += 1) MIGRATIONS[migration]!(old, { root, now: T });
    const insert = old.prepare("INSERT INTO connections(host, repository, sync_started_at, created_at) VALUES ('github', ?, ?, ?)");
    insert.run('acme/app', startedAt[0], T);
    insert.run('acme/other', startedAt[1], T);
    old.exec(`UPDATE meta SET value = '${version}' WHERE key = 'schema_version';
      INSERT INTO sync_settings(id, source_of_truth) VALUES (1, '2');
      COMMIT`);
    old.close();
  }

  it.each([3, 4] as const)('ignores a stored manual source-of-truth choice on upgrade from version %i: the board without a started sync (TASK-0066 AC6)', (version) => {
    const root = tempRepo();
    createOldDatabase(root, version, [null, null]);
    const service = openService(root);
    expect(service.info().schema_version).toBe(5);
    expect(service.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sync_settings'").get()).toBeUndefined();
    expect(service.connections.sourceOfTruth()).toMatchObject({ source_of_truth: 'board', host: null, repository: null });
    expect(service.connections.status().source_of_truth).toBe('board');
    service.close();
  });

  it.each([3, 4] as const)('ignores a stored manual source-of-truth choice on upgrade from version %i: the connection whose sync started first (TASK-0066 AC6)', (version) => {
    const root = tempRepo();
    // Connection 1 started at 13:00Z, after connection 2 (12:30Z); compared as instants, not as text.
    createOldDatabase(root, version, ['2026-10-20T10:00:00-03:00', '2026-10-20T12:30:00Z']);
    const service = openService(root);
    expect(service.connections.sourceOfTruth()).toMatchObject({ source_of_truth: 2, host: 'github', repository: 'acme/other' });
    service.close();

    const other = tempRepo();
    createOldDatabase(other, version, ['2026-10-20T12:00:00Z', '2026-10-20T12:30:00Z']);
    const reopened = openService(other);
    expect(reopened.connections.sourceOfTruth()).toMatchObject({ source_of_truth: 1, host: 'github', repository: 'acme/app' });
    reopened.close();
  });

  it('runs every migration for a new project', () => {
    const service = openService();
    expect(service.info().schema_version).toBe(5);
    const { db } = openDatabase(service.root, { create: false })!;
    expect(db.prepare(SCHEMA_VERSION_SQL).get()).toEqual({ value: '5' });
    for (const table of SYNC_TABLES) {
      expect(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(table), table).toBeDefined();
    }
    db.close();
  });

  it('creates the sync tables with their constraints', async () => {
    const service = openService();
    await service.createItem({ kind: 'task', title: 'Synced task', allow_duplicate: true }, ctx);
    const { db } = openDatabase(service.root, { create: false })!;
    const run = (sql: string) => db.prepare(sql).run();

    run(`INSERT INTO connections(host, repository, mcp_server, created_at) VALUES ('github', 'acme/app', 'github', '${T}')`);
    expect(db.prepare('SELECT id, auto_sync, last_sync_cursor, sync_started_at FROM connections').get()).toEqual({
      id: 1,
      auto_sync: 1,
      last_sync_cursor: null,
      sync_started_at: null,
    });
    expect(() => run(`INSERT INTO connections(host, repository, created_at) VALUES ('github', 'acme/app', '${T}')`)).toThrow(
      /UNIQUE/,
    );
    expect(() => run(`INSERT INTO connections(host, repository, created_at) VALUES ('bitbucket', 'x/y', '${T}')`)).toThrow(
      /CHECK/,
    );

    run(`INSERT INTO item_remote_refs(item_id, connection_id, external_ref, url, state, synced_at, synced_fields)
         VALUES ('TASK-0001', 1, 'acme/app#1', 'https://github.com/acme/app/issues/1', 'open', '${T}', '{"title":"Synced task"}')`);
    expect(() =>
      run("INSERT INTO item_remote_refs(item_id, connection_id, external_ref) VALUES ('TASK-0001', 1, 'acme/app#2')"),
    ).toThrow(/UNIQUE/);
    expect(() =>
      run("INSERT INTO item_remote_refs(item_id, connection_id, external_ref) VALUES ('TASK-0099', 1, 'acme/app#3')"),
    ).toThrow(/FOREIGN KEY/);

    run("INSERT INTO connection_mappings(connection_id, dimension, local_value, remote_value) VALUES (1, 'kind', 'bug', 'bug')");
    expect(() =>
      run("INSERT INTO connection_mappings(connection_id, dimension, local_value, remote_value) VALUES (1, 'size', 'l', 'L')"),
    ).toThrow(/CHECK/);

    run(`INSERT INTO sync_outbox(connection_id, item_id, operation, changed_fields, created_at)
         VALUES (1, 'TASK-0001', 'update', '["title"]', '${T}')`);
    expect(() =>
      run(`INSERT INTO sync_outbox(connection_id, item_id, operation, created_at) VALUES (1, 'TASK-0001', 'link', '${T}')`),
    ).toThrow(/CHECK/);

    run(`INSERT INTO tombstones(item_id, kind, title, external_refs, deleted_at, actor)
         VALUES ('TASK-0007', 'task', 'Gone', '[]', '${T}', 'tester')`);

    run('INSERT INTO sync_source_of_truth(id, connection_id) VALUES (1, 1)');
    expect(() => run('INSERT INTO sync_source_of_truth(id, connection_id) VALUES (2, 1)')).toThrow(/CHECK/);
    expect(() => run('UPDATE sync_source_of_truth SET connection_id = 9')).toThrow(/FOREIGN KEY/);

    run('DELETE FROM connections WHERE id = 1');
    for (const table of ['item_remote_refs', 'connection_mappings', 'sync_outbox', 'sync_source_of_truth']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
    db.close();
  });
});

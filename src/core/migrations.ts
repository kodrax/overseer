import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { defaultAskedBy } from './project.js';

export const EMBED_DIMS = 384;

const MIGRATION_1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE counters (kind TEXT PRIMARY KEY, next_seq INTEGER NOT NULL);
CREATE TABLE items (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('requirement','epic','story','task','bug')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'should' CHECK (priority IN ('must','should','could','wont')),
  req_type TEXT CHECK (req_type IN ('functional','non_functional')),
  nfr_category TEXT,
  rationale TEXT,
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  fit_criterion TEXT,
  verification_method TEXT CHECK (verification_method IN ('test','inspection','analysis','demonstration')),
  asked_by TEXT,
  source TEXT,
  recorded_via TEXT NOT NULL,
  in_backlog INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT REFERENCES items(id),
  assignee TEXT, estimate REAL, milestone TEXT,
  severity TEXT CHECK (severity IN ('critical','major','minor','trivial')),
  bug_details TEXT,
  component TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  code_refs TEXT NOT NULL DEFAULT '[]',
  external_ref TEXT UNIQUE, external_url TEXT, external_state TEXT, external_synced_at TEXT,
  delivered_at TEXT, delivered_in TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status_changed_at TEXT NOT NULL
);
CREATE INDEX items_kind_status ON items(kind, status);
CREATE TABLE links (src TEXT NOT NULL REFERENCES items(id), rel TEXT NOT NULL, dst TEXT NOT NULL REFERENCES items(id),
  created_at TEXT NOT NULL, PRIMARY KEY (src, rel, dst));
CREATE INDEX links_dst ON links(dst, rel);
CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL,
  via TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('create','update','status','link','unlink','comment','import')),
  field TEXT, old_value TEXT, new_value TEXT);
CREATE INDEX events_item ON events(item_id, seq);
CREATE VIRTUAL TABLE items_fts USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE item_embeddings (rid INTEGER PRIMARY KEY REFERENCES items(rid), content_hash TEXT NOT NULL, model TEXT NOT NULL);
`;

/**
 * Repository sync. A connection is one GitHub/GitLab repository; an item has one remote ref per connection (the legacy
 * `items.external_ref` stays as it is). Outbox and tombstone rows keep plain item IDs without a foreign key: they
 * outlive deleted items. `events` is rebuilt so its action CHECK accepts 'delete'; rows, seq values and the
 * AUTOINCREMENT counter are kept.
 */
const MIGRATION_2 = `
-- host + repository identify the remote; mcp_server is the harness MCP server used to reach it;
-- last_sync_cursor is the host's position (e.g. an updated-since timestamp) reached by the last pull.
CREATE TABLE connections (
  id INTEGER PRIMARY KEY,
  host TEXT NOT NULL CHECK (host IN ('github','gitlab')),
  repository TEXT NOT NULL,
  mcp_server TEXT,
  auto_sync INTEGER NOT NULL DEFAULT 1 CHECK (auto_sync IN (0,1)),
  last_sync_cursor TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (host, repository)
);
-- The issue linked to an item in one connection; synced_fields is a JSON object with the item fields as of synced_at
-- (the common base when local and remote both changed).
CREATE TABLE item_remote_refs (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  external_ref TEXT NOT NULL,
  url TEXT, state TEXT, synced_at TEXT,
  synced_fields TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (item_id, connection_id),
  UNIQUE (connection_id, external_ref)
);
-- Local kind/status/priority value ↔ remote label, issue type or state, per connection.
CREATE TABLE connection_mappings (
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL CHECK (dimension IN ('kind','status','priority')),
  local_value TEXT NOT NULL,
  remote_value TEXT NOT NULL,
  PRIMARY KEY (connection_id, dimension, local_value)
);
-- Local changes waiting to be pushed, in seq order; changed_fields is a JSON array of field names.
CREATE TABLE sync_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create','update','status','delete')),
  changed_fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX sync_outbox_connection ON sync_outbox(connection_id, seq);
-- Deleted items; external_refs is a JSON array of the item's remote refs at deletion.
CREATE TABLE tombstones (
  item_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('requirement','epic','story','task','bug')),
  title TEXT NOT NULL,
  external_refs TEXT NOT NULL DEFAULT '[]',
  deleted_at TEXT NOT NULL,
  actor TEXT NOT NULL
);
-- At most one row; no row means the board is the source of truth. source_of_truth is 'board' or a connection id.
CREATE TABLE sync_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_of_truth TEXT NOT NULL DEFAULT 'board'
    CHECK (source_of_truth = 'board' OR (source_of_truth GLOB '[1-9]*' AND source_of_truth NOT GLOB '*[^0-9]*'))
);
CREATE TABLE events_new (seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL,
  via TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('create','update','status','link','unlink','comment','import','delete')),
  field TEXT, old_value TEXT, new_value TEXT);
INSERT INTO events_new(seq, item_id, at, actor, via, action, field, old_value, new_value)
  SELECT seq, item_id, at, actor, via, action, field, old_value, new_value FROM events ORDER BY seq;
CREATE TEMP TABLE events_counter AS SELECT seq FROM sqlite_sequence WHERE name = 'events';
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
DELETE FROM sqlite_sequence WHERE name = 'events';
INSERT INTO sqlite_sequence(name, seq) SELECT 'events', seq FROM temp.events_counter;
DROP TABLE temp.events_counter;
CREATE INDEX events_item ON events(item_id, seq);
`;

/** When `sync start` seeded a connection's repository from the board; null until then. Set once. */
const MIGRATION_3 = `
ALTER TABLE connections ADD COLUMN sync_started_at TEXT;
`;

/**
 * The source of truth is derived, no longer chosen: the board until sync starts on a connection while the board is the
 * source of truth, then that connection (its row goes with it). The manual choice of `sync_settings` is dropped
 * unread; a connection whose sync already started becomes the source of truth, the earliest start first.
 */
const MIGRATION_4 = `
DROP TABLE sync_settings;
-- At most one row; no row means the board is the source of truth.
CREATE TABLE sync_source_of_truth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE
);
INSERT INTO sync_source_of_truth(id, connection_id)
  SELECT 1, id FROM connections WHERE sync_started_at IS NOT NULL ORDER BY julianday(sync_started_at), id LIMIT 1;
`;

/**
 * Vectors per item: full text (`items_vec`), title only (`items_title_vec`) so short queries match titles, and title +
 * description (`items_statement_vec`), the shape of a duplicate-guard query, so a reworded item matches regardless of
 * its acceptance criteria.
 */
export const VEC_TABLES = ['items_vec', 'items_title_vec', 'items_statement_vec'] as const;

export type VecTable = (typeof VEC_TABLES)[number];

export const createVecTableSql = (table: VecTable, dims: number) =>
  `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(rid INTEGER PRIMARY KEY, kind TEXT, embedding FLOAT[${dims}] distance_metric=cosine)`;

export interface MigrationContext {
  root: string;
  now: string;
}

/** Numbered migrations: entry N - 1 takes a database from schema_version N - 1 to N. */
export const MIGRATIONS: ReadonlyArray<(db: DatabaseSync, context: MigrationContext) => void> = [
  (db, { root, now }) => {
    db.exec(MIGRATION_1);
    const insert = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
    insert.run('project_name', basename(root));
    insert.run('created_at', now);
    insert.run('default_asked_by', defaultAskedBy(root));
    insert.run('export_dir', 'docs/overseer');
    insert.run('board_port', '4477');
  },
  (db) => db.exec(MIGRATION_2),
  (db) => db.exec(MIGRATION_3),
  (db) => db.exec(MIGRATION_4),
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) !== undefined;
}

function schemaVersion(db: DatabaseSync): number {
  if (!tableExists(db, 'meta')) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return row ? Number(row.value) : 0;
}

/** Applies pending migrations (each in its own IMMEDIATE transaction) and creates `items_vec` when sqlite-vec is loaded. */
export function migrate(db: DatabaseSync, context: MigrationContext & { vecAvailable: boolean }): void {
  while (schemaVersion(db) < MIGRATIONS.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read under the write lock: another process may have migrated meanwhile.
      const version = schemaVersion(db);
      if (version < MIGRATIONS.length) {
        MIGRATIONS[version]!(db, context);
        db.prepare(
          "INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(String(version + 1));
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  if (context.vecAvailable) for (const table of VEC_TABLES) db.exec(createVecTableSql(table, EMBED_DIMS));
}

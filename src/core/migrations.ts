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

const MIGRATIONS: ReadonlyArray<(db: DatabaseSync, context: MigrationContext) => void> = [
  (db, { root, now }) => {
    db.exec(MIGRATION_1);
    const insert = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
    insert.run('project_name', basename(root));
    insert.run('created_at', now);
    insert.run('default_asked_by', defaultAskedBy(root));
    insert.run('export_dir', 'docs/overseer');
    insert.run('board_port', '4477');
  },
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

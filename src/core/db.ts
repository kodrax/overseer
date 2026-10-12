import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as sqlite from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { errorMessage } from './errors.js';
import { migrate } from './migrations.js';
import { DB_FILE, dataDir, ensureDataDir } from './project.js';

export type Database = sqlite.DatabaseSync;

// Node may expose the synchronous class as `Database` in future releases.
const sqliteModule: Record<string, unknown> = sqlite;
const DatabaseCtor = (sqliteModule.DatabaseSync ?? sqliteModule.Database) as typeof sqlite.DatabaseSync;

const warned = new Set<string>();

/** Logs a degradation warning to stderr once per process (stdout stays clean for MCP). */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(`overseer: ${message}\n`);
}

export interface OpenedDatabase {
  db: Database;
  file: string;
  vecAvailable: boolean;
}

export function databaseFile(root: string): string {
  return join(dataDir(root), DB_FILE);
}

/** Loads sqlite-vec into `db`; false (with a one-time stderr warning) when the native extension is unavailable. */
export function loadVec(db: Database): boolean {
  try {
    db.loadExtension(sqliteVec.getLoadablePath());
    return true;
  } catch (error) {
    warnOnce('sqlite-vec', `sqlite-vec unavailable, semantic search disabled (${errorMessage(error)})`);
    return false;
  }
}

/**
 * Opens `<root>/.overseer/overseer.db`, applying pragmas and migrations.
 * Returns undefined when the database does not exist and `create` is false (reads never create it).
 */
export function openDatabase(root: string, options: { create: boolean }): OpenedDatabase | undefined {
  const file = databaseFile(root);
  if (!existsSync(file)) {
    if (!options.create) return undefined;
    ensureDataDir(root);
  }
  const db = new DatabaseCtor(file, { allowExtension: true });
  try {
    const vecAvailable = loadVec(db);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    migrate(db, { root, now: nowIso(), vecAvailable });
    return { db, file, vecAvailable };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Extra read-only connection on the project database (e.g. to watch `PRAGMA data_version`). */
export function openReadConnection(root: string): Database {
  const db = new DatabaseCtor(databaseFile(root), { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000;');
  return db;
}

const txDepth = new WeakMap<Database, number>();

/** Runs `fn` inside `BEGIN IMMEDIATE … COMMIT`, rolling back on throw. Nested calls join the outer transaction. */
export function tx<T>(db: Database, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    txDepth.delete(db);
  }
}

/** ISO-8601 local time with offset, second precision: `2026-10-10T21:04:11-03:00`. */
export function nowIso(date: Date = new Date()): string {
  const pad = (value: number) => String(Math.abs(value)).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

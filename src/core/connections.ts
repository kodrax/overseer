import { type Database, nowIso, tx } from './db.js';
import { OverseerError } from './errors.js';
import { compareIds } from './ids.js';
import { SYNCED_FIELDS, type SyncedField } from './import.js';
import { normalizeRepositoryPath, type RemoteHost } from './remotes.js';
import type { SyncOverwrite } from './sync-plan.js';

/** Hosting services a connection can point to. */
export const CONNECTION_HOSTS = ['github', 'gitlab'] as const satisfies readonly RemoteHost[];
export type ConnectionHost = (typeof CONNECTION_HOSTS)[number];

/** One GitHub or GitLab repository connected to the project (a `connections` row). */
export interface Connection {
  id: number;
  host: ConnectionHost;
  /** `owner/repo` on GitHub, `group/…/project` on GitLab. */
  repository: string;
  /** Harness MCP server that reaches the repository; null until named. */
  mcp_server: string | null;
  auto_sync: boolean;
  /** The host's position reached by the last pull; null before the first one. */
  last_sync_cursor: string | null;
  /** When `sync start` started the connection's sync (seeding its repository, or bringing its issues to the board); null until then. */
  sync_started_at: string | null;
  created_at: string;
}

export interface ConnectionInput {
  host: string;
  repository: string;
  mcp_server?: string;
}

export interface ConnectionChanges {
  auto_sync?: boolean;
  mcp_server?: string;
}

/** A removed connection, how many of its rows went with it and whether the source of truth went back to the board. */
export interface ConnectionRemoval {
  removed: Connection;
  remote_refs: number;
  mappings: number;
  outbox: number;
  /** True when the removed connection was the source of truth, which is now the board. */
  source_of_truth_reset: boolean;
}

/**
 * Where synced item fields win a conflict: the board, or one connection (with its host and repository). It is derived,
 * never chosen: the board until sync starts on a connection while the board is the source of truth, then that
 * connection until it is removed.
 */
export interface SourceOfTruth {
  source_of_truth: 'board' | number;
  host: ConnectionHost | null;
  repository: string | null;
  /** Why it is the source of truth. */
  reason: string;
}

const BOARD_SOURCE: SourceOfTruth = {
  source_of_truth: 'board',
  host: null,
  repository: null,
  reason: 'No connection started sync while the board was the source of truth; the first one that does becomes the source of truth.',
};

/** Which sync step overwrote a field: a pull (the issue's value won) or a confirm (the pushed item's value won). */
export type OverwriteStep = 'pull' | 'confirm';

/** A field the connection's latest pull or confirm overwrote, as `sync status` lists it. */
export interface ConnectionOverwrite extends SyncOverwrite {
  step: OverwriteStep;
  /** When that pull or confirm ran. */
  at: string;
}

/**
 * A connection in `sync status`, with how many sync_outbox rows wait to be pushed to it and the fields its latest pull
 * and latest confirm overwrote (pull first, then by item ID and synced field order; empty when none).
 */
export interface ConnectionState extends Connection {
  pending_outbox: number;
  overwritten: ConnectionOverwrite[];
}

/** `sync status`: every connection, and `board` or the source-of-truth connection with its host and repository. */
export interface SyncStatus {
  connections: ConnectionState[];
  source_of_truth: 'board' | { id: number; host: ConnectionHost; repository: string };
}

interface ConnectionRow {
  id: number;
  host: ConnectionHost;
  repository: string;
  mcp_server: string | null;
  auto_sync: number;
  last_sync_cursor: string | null;
  sync_started_at: string | null;
  created_at: string;
}

// GitHub and GitLab names: letters, digits, `.`, `_` and `-`; `.` and `..` alone are path tricks, not names.
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const MAX_MCP_SERVER = 200;

function toConnection(row: ConnectionRow): Connection {
  return {
    id: Number(row.id),
    host: row.host,
    repository: row.repository,
    mcp_server: row.mcp_server,
    auto_sync: row.auto_sync === 1,
    last_sync_cursor: row.last_sync_cursor,
    sync_started_at: row.sync_started_at,
    created_at: row.created_at,
  };
}

function parseHost(host: string): ConnectionHost {
  const found = CONNECTION_HOSTS.find((candidate) => candidate === host.trim().toLowerCase());
  if (found === undefined) throw new OverseerError('INVALID_INPUT', `Invalid host "${host}"; valid: ${CONNECTION_HOSTS.join(', ')}.`);
  return found;
}

/**
 * The repository path without `.git` or slashes around it (the `sync remotes` rules). GitHub takes exactly `owner/repo`;
 * GitLab takes `group/project` with any number of subgroups between them.
 */
export function parseRepository(host: ConnectionHost, repository: string): string {
  const path = normalizeRepositoryPath(repository.trim());
  const segments = path.split('/');
  const named = segments.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..');
  if (host === 'github' && (segments.length !== 2 || !named)) {
    throw new OverseerError('INVALID_INPUT', `Invalid GitHub repository "${repository}"; expected owner/repo, e.g. acme/demo.`);
  }
  if (host === 'gitlab' && (segments.length < 2 || !named)) {
    throw new OverseerError('INVALID_INPUT', `Invalid GitLab repository "${repository}"; expected group/project or group/subgroup/…/project.`);
  }
  return path;
}

function parseMcpServer(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > MAX_MCP_SERVER) {
    throw new OverseerError('INVALID_INPUT', `MCP server name must hold 1 to ${MAX_MCP_SERVER} characters.`);
  }
  return trimmed;
}

/** A connection id: a positive integer, as a number or its decimal text. */
export function parseConnectionId(id: number | string): number {
  const text = String(id).trim();
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new OverseerError('INVALID_INPUT', `Invalid connection id "${id}"; expected a positive integer.`);
  }
  return Number(text);
}

/**
 * The project's repository connections. Only the local database is read and written: no GitHub or GitLab call is
 * made here. Changes are settings, not item changes, so nothing goes into the item history.
 */
export class Connections {
  readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Every connection, by id. */
  list(): Connection[] {
    return (this.db.prepare('SELECT * FROM connections ORDER BY id').all() as unknown as ConnectionRow[]).map(toConnection);
  }

  get(id: number | string): Connection | undefined {
    const row = this.db.prepare('SELECT * FROM connections WHERE id = ?').get(parseConnectionId(id)) as ConnectionRow | undefined;
    return row ? toConnection(row) : undefined;
  }

  /** The connection with this id; NOT_FOUND otherwise. */
  require(id: number | string): Connection {
    const connection = this.get(id);
    if (!connection) throw new OverseerError('NOT_FOUND', `No connection with id ${parseConnectionId(id)}.`);
    return connection;
  }

  /**
   * Stores a connection with auto-sync on. The same host and repository (case-insensitive, as both hosts treat
   * paths) gives CONFLICT naming the existing connection.
   */
  add(input: ConnectionInput): Connection {
    const host = parseHost(input.host);
    const repository = parseRepository(host, input.repository);
    const mcpServer = input.mcp_server === undefined ? null : parseMcpServer(input.mcp_server);
    return tx(this.db, () => {
      const existing = this.db
        .prepare('SELECT * FROM connections WHERE host = ? AND lower(repository) = lower(?)')
        .get(host, repository) as ConnectionRow | undefined;
      if (existing) {
        throw new OverseerError('CONFLICT', `${host} ${existing.repository} is already connection ${existing.id}.`, { id: Number(existing.id) });
      }
      const inserted = this.db
        .prepare('INSERT INTO connections(host, repository, mcp_server, auto_sync, created_at) VALUES (?, ?, ?, 1, ?)')
        .run(host, repository, mcpServer, nowIso());
      return this.require(Number(inserted.lastInsertRowid));
    });
  }

  /** Changes auto-sync and/or the MCP server; INVALID_INPUT when neither is given. */
  set(id: number | string, changes: ConnectionChanges): Connection {
    const mcpServer = changes.mcp_server === undefined ? undefined : parseMcpServer(changes.mcp_server);
    if (changes.auto_sync === undefined && mcpServer === undefined) {
      throw new OverseerError('INVALID_INPUT', 'Nothing to change: pass --auto-sync on|off or --mcp-server <name>.');
    }
    return tx(this.db, () => {
      const connection = this.require(id);
      this.db
        .prepare('UPDATE connections SET auto_sync = ?, mcp_server = ? WHERE id = ?')
        .run((changes.auto_sync ?? connection.auto_sync) ? 1 : 0, mcpServer ?? connection.mcp_server, connection.id);
      return this.require(connection.id);
    });
  }

  /**
   * Deletes the connection with its remote refs, mappings, pending outbox rows and recorded overwrites, and counts the
   * first three. When it was the source of truth, the board becomes the source of truth in the same transaction, even
   * if another connection started sync.
   */
  remove(id: number | string): ConnectionRemoval {
    return tx(this.db, () => {
      const removed = this.require(id);
      const remove = (table: string) => Number(this.db.prepare(`DELETE FROM ${table} WHERE connection_id = ?`).run(removed.id).changes);
      const counts = { remote_refs: remove('item_remote_refs'), mappings: remove('connection_mappings'), outbox: remove('sync_outbox') };
      const reset = remove('sync_source_of_truth') > 0;
      remove('sync_overwrites');
      this.db.prepare('DELETE FROM connections WHERE id = ?').run(removed.id);
      return { removed, ...counts, source_of_truth_reset: reset };
    });
  }

  /** The derived source of truth (see `SourceOfTruth`) and why; the board when no connection holds it. */
  sourceOfTruth(): SourceOfTruth {
    const row = this.db.prepare('SELECT connection_id FROM sync_source_of_truth WHERE id = 1').get() as { connection_id: number } | undefined;
    if (!row) return BOARD_SOURCE;
    const connection = this.require(Number(row.connection_id));
    return {
      source_of_truth: connection.id,
      host: connection.host,
      repository: connection.repository,
      reason: `Sync of connection ${connection.id} (${connection.host} ${connection.repository}) started at ${connection.sync_started_at} while the board was the source of truth.`,
    };
  }

  /**
   * For `sync start`, once the connection's sync started (in its transaction): the connection becomes the source of
   * truth when the board is; otherwise the source of truth stays. True when it changed.
   */
  claimSourceOfTruth(id: number): boolean {
    return Number(this.db.prepare('INSERT INTO sync_source_of_truth(id, connection_id) VALUES (1, ?) ON CONFLICT(id) DO NOTHING').run(id).changes) > 0;
  }

  /**
   * Replaces the overwritten fields recorded for the connection's latest `step` with `entries` (none clears them), in
   * the caller's transaction.
   */
  recordOverwrites(id: number, step: OverwriteStep, at: string, entries: readonly SyncOverwrite[]): void {
    this.db.prepare('DELETE FROM sync_overwrites WHERE connection_id = ? AND step = ?').run(id, step);
    const insert = this.db.prepare(
      'INSERT INTO sync_overwrites(connection_id, step, at, item_id, external_ref, field, value, overwritten) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const entry of entries) {
      insert.run(id, step, at, entry.item_id, entry.external_ref, entry.field, JSON.stringify(entry.value ?? null), JSON.stringify(entry.overwritten ?? null));
    }
  }

  /** Every connection with its pending outbox count and latest overwrites, and the source of truth; reads only the local database. */
  status(): SyncStatus {
    const pending = new Map(
      (this.db.prepare('SELECT connection_id, count(*) AS n FROM sync_outbox GROUP BY connection_id').all() as { connection_id: number; n: number }[]).map(
        (row) => [Number(row.connection_id), Number(row.n)],
      ),
    );
    const overwritten = new Map<number, ConnectionOverwrite[]>();
    const rows = this.db.prepare('SELECT * FROM sync_overwrites').all() as unknown as OverwriteRow[];
    for (const row of rows) {
      const step = row.step;
      const entries = overwritten.get(Number(row.connection_id)) ?? [];
      entries.push({
        step,
        item_id: row.item_id,
        external_ref: row.external_ref,
        field: row.field,
        winner: step === 'pull' ? 'remote' : 'local',
        value: JSON.parse(row.value) as SyncOverwrite['value'],
        overwritten: JSON.parse(row.overwritten) as SyncOverwrite['overwritten'],
        at: row.at,
      });
      overwritten.set(Number(row.connection_id), entries);
    }
    const steps: OverwriteStep[] = ['pull', 'confirm'];
    for (const entries of overwritten.values()) {
      entries.sort(
        (a, b) =>
          steps.indexOf(a.step) - steps.indexOf(b.step) || compareIds(a.item_id, b.item_id) || SYNCED_FIELDS.indexOf(a.field) - SYNCED_FIELDS.indexOf(b.field),
      );
    }
    const source = this.sourceOfTruth();
    return {
      connections: this.list().map((connection) => ({ ...connection, pending_outbox: pending.get(connection.id) ?? 0, overwritten: overwritten.get(connection.id) ?? [] })),
      source_of_truth:
        source.source_of_truth === 'board' ? 'board' : { id: source.source_of_truth, host: source.host!, repository: source.repository! },
    };
  }
}

interface OverwriteRow {
  connection_id: number;
  step: OverwriteStep;
  at: string;
  item_id: string;
  external_ref: string;
  field: SyncedField;
  value: string;
  overwritten: string;
}

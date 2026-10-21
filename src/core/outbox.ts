import type { Connections } from './connections.js';
import { type Database, nowIso, tx } from './db.js';
import { OverseerError } from './errors.js';
import type { EventAction } from './schema.js';

/** What a pending outbox entry asks the next push to do with the item on one connection. */
export const OUTBOX_OPERATIONS = ['create', 'update', 'status', 'delete'] as const;
export type OutboxOperation = (typeof OUTBOX_OPERATIONS)[number];

/** One pending local change of an item for one connection (a `sync_outbox` row). */
export interface OutboxEntry {
  seq: number;
  connection_id: number;
  item_id: string;
  operation: OutboxOperation;
  /** Fields changed since the last confirmed push; `links` for link/unlink. Empty for create and delete (the whole item). */
  changed_fields: string[];
  /** When the entry last changed. */
  created_at: string;
}

export interface OutboxAck {
  acked: number[];
}

interface OutboxRow {
  seq: number;
  connection_id: number;
  item_id: string;
  operation: OutboxOperation;
  changed_fields: string;
  created_at: string;
}

function toEntry(row: OutboxRow): OutboxEntry {
  return {
    seq: Number(row.seq),
    connection_id: Number(row.connection_id),
    item_id: row.item_id,
    operation: row.operation,
    changed_fields: JSON.parse(row.changed_fields) as string[],
    created_at: row.created_at,
  };
}

/** The change one history event makes, as the outbox records it; null for events that change no item field (comments). */
function changeOf(action: EventAction, field: string | null): { operation: OutboxOperation; field?: string } | null {
  switch (action) {
    case 'create':
    case 'import':
      return { operation: 'create' };
    case 'delete':
      return { operation: 'delete' };
    case 'status':
      return { operation: 'status', field: 'status' };
    case 'link':
    case 'unlink':
      return { operation: 'update', field: 'links' };
    case 'update':
      return field === null ? null : { operation: 'update', field };
    case 'comment':
      return null;
  }
}

/**
 * Pending local item changes per connection with auto-sync on (the `sync_outbox` rows), cleared by `ack` once a push
 * is confirmed. One entry per connection and item at most:
 * - a create stays a create, whatever changes follow (the push sends the whole item); a create then a delete before
 *   any push leaves no entry;
 * - a delete replaces any earlier entry;
 * - otherwise the changed fields are merged: the operation is `status` when only the status changed, else `update`.
 * A merged entry gets a new `seq`, so acking the seq listed before the latest change gives NOT_FOUND and the change
 * stays pending.
 */
export class SyncOutbox {
  readonly db: Database;
  readonly connections: Connections;

  constructor(db: Database, connections: Connections) {
    this.db = db;
    this.connections = connections;
  }

  /**
   * Records one history event of `itemId` for every connection with auto-sync on except `origin` (the connection
   * whose remote changes the write applies). A delete from `origin` drops its pending entry for the item: the issue is
   * already gone there. Runs in the caller's transaction.
   */
  record(itemId: string, action: EventAction, field: string | null, origin?: number): void {
    const change = changeOf(action, field);
    if (!change) return;
    const targets = this.db.prepare('SELECT id FROM connections WHERE auto_sync = 1 ORDER BY id').all() as { id: number }[];
    for (const { id } of targets) {
      const connectionId = Number(id);
      if (connectionId === origin) {
        if (change.operation === 'delete') this.db.prepare('DELETE FROM sync_outbox WHERE connection_id = ? AND item_id = ?').run(connectionId, itemId);
        continue;
      }
      const pending = this.db
        .prepare('SELECT * FROM sync_outbox WHERE connection_id = ? AND item_id = ?')
        .get(connectionId, itemId) as OutboxRow | undefined;
      const merged = this.merge(pending ? toEntry(pending) : undefined, change);
      if (pending) this.db.prepare('DELETE FROM sync_outbox WHERE seq = ?').run(pending.seq);
      if (!merged) continue;
      this.db
        .prepare('INSERT INTO sync_outbox(connection_id, item_id, operation, changed_fields, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(connectionId, itemId, merged.operation, JSON.stringify(merged.changed_fields), nowIso());
    }
  }

  private merge(
    pending: OutboxEntry | undefined,
    change: { operation: OutboxOperation; field?: string },
  ): Pick<OutboxEntry, 'operation' | 'changed_fields'> | null {
    if (change.operation === 'delete') return pending?.operation === 'create' ? null : { operation: 'delete', changed_fields: [] };
    if (change.operation === 'create' || pending?.operation === 'create') return { operation: 'create', changed_fields: [] };
    const fields = [...new Set([...(pending?.changed_fields ?? []), change.field!])];
    return { operation: fields.length === 1 && fields[0] === 'status' ? 'status' : 'update', changed_fields: fields };
  }

  /** Pending entries by seq, of one connection (NOT_FOUND when unknown) or of all. */
  list(connectionId?: number | string): OutboxEntry[] {
    if (connectionId === undefined) {
      return (this.db.prepare('SELECT * FROM sync_outbox ORDER BY seq').all() as unknown as OutboxRow[]).map(toEntry);
    }
    const connection = this.connections.require(connectionId);
    return (this.db.prepare('SELECT * FROM sync_outbox WHERE connection_id = ? ORDER BY seq').all(connection.id) as unknown as OutboxRow[]).map(
      toEntry,
    );
  }

  /** Removes the entries with these seqs after a confirmed push; any unknown seq gives NOT_FOUND and removes nothing. */
  ack(seqs: readonly (number | string)[]): OutboxAck {
    if (seqs.length === 0) throw new OverseerError('INVALID_INPUT', 'Pass at least one outbox seq.');
    const parsed = [...new Set(seqs.map(parseSeq))].sort((a, b) => a - b);
    return tx(this.db, () => {
      const exists = this.db.prepare('SELECT 1 FROM sync_outbox WHERE seq = ?');
      const unknown = parsed.filter((seq) => exists.get(seq) === undefined);
      if (unknown.length > 0) {
        throw new OverseerError(
          'NOT_FOUND',
          `${unknown.length === 1 ? 'No pending outbox entry with seq' : 'No pending outbox entries with seqs'} ${unknown.join(', ')}; nothing was removed.`,
        );
      }
      const remove = this.db.prepare('DELETE FROM sync_outbox WHERE seq = ?');
      for (const seq of parsed) remove.run(seq);
      return { acked: parsed };
    });
  }
}

function parseSeq(seq: number | string): number {
  const text = String(seq).trim();
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new OverseerError('INVALID_INPUT', `Invalid outbox seq "${seq}"; expected a positive integer.`);
  }
  return Number(text);
}

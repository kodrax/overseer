import { z } from 'zod';
import type { Connection } from './connections.js';
import { nowIso, tx } from './db.js';
import { OverseerError } from './errors.js';
import { compareIds } from './ids.js';
import { importItemSchema, type IssueUpsert, mapImportPayload, RAW_PAYLOAD_FORMATS, upsertIssues } from './import.js';
import { type Ctx, KINDS, type Kind, parseInput } from './schema.js';
import type { OverseerService } from './service.js';
import type { SyncStartBaseline } from './sync-plan.js';

export interface SyncStart {
  /** The connection, with its `sync_started_at` now set. */
  connection: Connection;
  started_at: string;
  /** board: the board seeded an empty repository; repository: the repository's issues came to the board. */
  from: 'board' | 'repository';
  /** Items with a pending create on the connection after the start (none when the repository had issues). */
  queued: number;
  by_kind: Record<Kind, number>;
  /** Items created for issues no item had. */
  created: number;
  /** Existing items linked to their issue (an item imported from it earlier). */
  linked: number;
  warnings: string[];
  /** What to run next. */
  next: string;
}

/**
 * Starts the sync of one connection (NOT_FOUND when unknown) given `payload`, a raw GitHub/GitLab MCP listing of its
 * issues (as for `sync plan`). Reads the project database and the listing only: no network. Sync already started on
 * the connection → CONFLICT, nothing written. Otherwise, in one transaction, then `sync_started_at` is set:
 * - The listing has no issues (the board seeds the repository): every item of every kind and status without a remote
 *   ref on the connection gets one pending `create` outbox entry there (whatever the auto-sync flag; an earlier pending
 *   update or status entry of such an item becomes the create, since the push sends the whole item).
 * - The listing has issues (the repository comes to the board): its issues are upserted as `import` does (an issue no
 *   item has creates one, an item imported from it is updated and linked), each with its remote ref on the connection;
 *   nothing is queued for any connection (those items stay in this repository: see neverCreatedOn), and pending
 *   create, update and status entries of items without an issue here are dropped. The highest item ID per kind is
 *   recorded as `sync_start_baseline`: `sync plan` never pushes a create for those items (see existedBeforeSyncStart).
 * Once started (either way), the connection becomes the source of truth when the board is; otherwise it stays as it is.
 */
export function startSync(service: OverseerService, connectionId: number | string, payload: unknown, ctx: Ctx): SyncStart {
  const db = service.db;
  return tx(db, () => {
    const connection = service.connections.require(connectionId);
    if (connection.sync_started_at !== null) {
      throw new OverseerError('CONFLICT', `Sync of connection ${connection.id} (${connection.host} ${connection.repository}) already started at ${connection.sync_started_at}; nothing was queued.`, {
        connection_id: connection.id,
        sync_started_at: connection.sync_started_at,
      });
    }
    const mapped = mapImportPayload(payload, connection.host, connection.repository, RAW_PAYLOAD_FORMATS);
    const issues = parseInput(z.array(importItemSchema), mapped.items);
    const now = nowIso();
    const byKind = Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<Kind, number>;
    const server = connection.mcp_server ?? "the connection's MCP server";
    const upsert: IssueUpsert = { created: [], updated: [], unchanged: [], warnings: [...mapped.warnings] };
    let queued = 0;
    let next: string;
    // The one branch point for repositories that already have issues.
    if (issues.length > 0) {
      // The repository already holds these issues and keeps them: the outbox queues nothing, for no connection.
      upsertIssues(service, connection.host, issues, connection.id, { ...ctx, via: `sync:${connection.host}`, origin_connection: connection.id, keep_in_origin: true }, now, upsert);
      db.prepare(
        "DELETE FROM sync_outbox WHERE connection_id = ? AND operation <> 'delete' AND item_id NOT IN (SELECT item_id FROM item_remote_refs WHERE connection_id = ?)",
      ).run(connection.id, connection.id);
      const baseline: SyncStartBaseline = Object.fromEntries(
        (db.prepare('SELECT kind, next_seq - 1 AS last FROM counters ORDER BY kind').all() as { kind: Kind; last: number }[]).map((row) => [row.kind, Number(row.last)]),
      );
      db.prepare('UPDATE connections SET sync_start_baseline = ? WHERE id = ?').run(JSON.stringify(baseline), connection.id);
      next = `Items created from now on get a create push; items that existed before the start and have no issue on the connection are never pushed (sync plan lists their entries under ack), and the repository's issues are never created on the other connections. Run sync plan ${connection.id} <listing>, run its ops through ${server}, then record the results with sync confirm ${connection.id} <results>.`;
    } else {
      const items = (
        db
          .prepare('SELECT id, kind FROM items WHERE id NOT IN (SELECT item_id FROM item_remote_refs WHERE connection_id = ?)')
          .all(connection.id) as { id: string; kind: Kind }[]
      ).sort((a, b) => compareIds(a.id, b.id));
      const pending = db.prepare('SELECT operation FROM sync_outbox WHERE connection_id = ? AND item_id = ?');
      const drop = db.prepare('DELETE FROM sync_outbox WHERE connection_id = ? AND item_id = ?');
      const insert = db.prepare("INSERT INTO sync_outbox(connection_id, item_id, operation, changed_fields, created_at) VALUES (?, ?, 'create', '[]', ?)");
      for (const item of items) {
        const entry = pending.get(connection.id, item.id) as { operation: string } | undefined;
        if (entry?.operation !== 'create') {
          drop.run(connection.id, item.id);
          insert.run(connection.id, item.id, now);
        }
        byKind[item.kind] += 1;
      }
      queued = items.length;
      next = `Run sync plan ${connection.id} <listing>, run each create op through ${server} (a create whose issue.state is closed is closed after it is created), then record the results with sync confirm ${connection.id} <results>.`;
    }
    db.prepare('UPDATE connections SET sync_started_at = ? WHERE id = ?').run(now, connection.id);
    service.connections.claimSourceOfTruth(connection.id);
    return {
      connection: service.connections.require(connection.id),
      started_at: now,
      from: issues.length > 0 ? 'repository' : 'board',
      queued,
      by_kind: byKind,
      created: upsert.created.length,
      linked: upsert.updated.length + upsert.unchanged.length,
      warnings: upsert.warnings,
      next,
    };
  });
}

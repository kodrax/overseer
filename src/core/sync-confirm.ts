import { z } from 'zod';
import { nowIso, tx } from './db.js';
import { OverseerError } from './errors.js';
import { SYNCED_FIELDS, type SyncedField, type SyncedFields } from './import.js';
import { getRow, toItem } from './items.js';
import type { OutboxEntry } from './outbox.js';
import { type Ctx, parseInput } from './schema.js';
import type { OverseerService } from './service.js';
import { REMOTE_FIELDS, type SyncOverwrite, targetIssue } from './sync-plan.js';

const STATES: Record<string, 'open' | 'closed'> = { open: 'open', opened: 'open', closed: 'closed' };

/** One push the agent ran through the connection's MCP server, as `sync confirm` takes it. */
const pushResultSchema = z
  .object({
    seqs: z.array(z.number().int().positive()).min(1),
    item_id: z.string().trim().min(1),
    external_id: z.string().trim().min(1).max(500),
    url: z.string().trim().url().max(2000),
    state: z
      .string()
      .transform((state) => STATES[state.toLowerCase()])
      .pipe(z.enum(['open', 'closed'], { message: 'state must be open or closed' })),
    fields: z.array(z.enum(SYNCED_FIELDS)).optional(),
    /** The plan op's `overwritten`: the issue's values the push replaced, by field. */
    overwritten: z.partialRecord(z.enum(SYNCED_FIELDS), z.union([z.string(), z.array(z.string()), z.null()])).optional(),
  })
  .strict();

export type PushResult = z.input<typeof pushResultSchema>;

export interface ConfirmedPush {
  item_id: string;
  external_id: string;
  url: string;
  state: 'open' | 'closed';
  /** Snapshot fields set to the pushed values; empty for the close of a deleted item (its remote ref is gone). */
  fields: SyncedField[];
}

export interface SyncConfirmation {
  connection_id: number;
  confirmed: ConfirmedPush[];
  /** Outbox seqs acknowledged, ascending. */
  acked: number[];
}

/**
 * Records the pushes the agent ran for one connection's sync plan (NOT_FOUND for an unknown connection). Every result
 * is checked first; any unknown or repeated seq, a seq of another item or connection, an unknown item, an issue of
 * another repository or item, or an `overwritten` field the push did not set gives INVALID_INPUT and nothing is
 * written. Then, in one transaction, per result:
 * - the item's remote ref on the connection is created or updated (issue ID, URL, state, sync time), and the item's
 *   `external_ref`/`external_url` are set to it when the item has none, so references resolve as for an import;
 * - the snapshot gets the pushed values of `fields` (the plan op's `fields`; when omitted, every synced field for an
 *   item not linked yet or a pending create, else the fields the entries' changes touch), recomputed from the item and
 *   the mapping: a pending seq means the item has not changed since the plan, so the values are the plan's `issue`;
 * - each field of `overwritten` (the plan op's: the issue's values the push replaced) gets an `overwrite` event via
 *   `sync:<host>` with the issue's value and the pushed one;
 * - its outbox seqs are acknowledged.
 * The close of a deleted item only acknowledges its seqs. The overwritten fields replace the connection's latest
 * confirm overwrites (`sync status`).
 */
export function confirmSync(service: OverseerService, connectionId: number | string, input: unknown, ctx: Ctx): SyncConfirmation {
  const connection = service.connections.require(connectionId);
  const results = parseInput(z.array(pushResultSchema).min(1, 'Pass at least one push result.'), input);
  const db = service.db;
  const entries = new Map(service.outbox.list(connection.id).map((entry) => [entry.seq, entry]));
  const mapping = service.mappings.get(connection.id).mapping;
  const issuePattern = /^(.+)#([1-9]\d*)$/;
  const holder = db.prepare('SELECT item_id FROM item_remote_refs WHERE connection_id = ? AND lower(external_ref) = lower(?)');
  const linked = db.prepare('SELECT synced_fields FROM item_remote_refs WHERE item_id = ? AND connection_id = ?');
  const errors: string[] = [];
  const seen = new Set<number>();
  const planned: { result: z.infer<typeof pushResultSchema>; entries: OutboxEntry[]; fields: SyncedField[] }[] = [];

  results.forEach((result, index) => {
    const at = `result ${index + 1} (${result.item_id})`;
    const own: OutboxEntry[] = [];
    for (const seq of result.seqs) {
      const entry = entries.get(seq);
      if (seen.has(seq)) errors.push(`${at}: seq ${seq} is listed twice`);
      else if (!entry) errors.push(`${at}: no pending outbox entry with seq ${seq} on connection ${connection.id}`);
      else if (entry.item_id !== result.item_id) errors.push(`${at}: seq ${seq} belongs to ${entry.item_id}`);
      else own.push(entry);
      seen.add(seq);
    }
    const exists = getRow(db, result.item_id) !== undefined;
    // A deleted item is known only through its pending delete entries (the close of its issue).
    if (!exists && (own.length === 0 || own.some((entry) => entry.operation !== 'delete'))) errors.push(`${at}: unknown item ${result.item_id}`);
    const issue = issuePattern.exec(result.external_id);
    if (!issue || issue[1]!.toLowerCase() !== connection.repository.toLowerCase()) {
      errors.push(`${at}: external_id "${result.external_id}" is not an issue of ${connection.repository} (expected ${connection.repository}#<number>)`);
    } else {
      const other = holder.get(connection.id, result.external_id) as { item_id: string } | undefined;
      if (other && other.item_id !== result.item_id) errors.push(`${at}: ${result.external_id} is already linked to ${other.item_id} in connection ${connection.id}`);
    }
    const earlier = exists && linked.get(result.item_id, connection.id) !== undefined;
    const fields = !exists
      ? []
      : (result.fields ??
        SYNCED_FIELDS.filter(
          (field) =>
            !earlier ||
            own.some((entry) => entry.operation === 'create' || entry.changed_fields.some((changed) => REMOTE_FIELDS[changed]?.includes(field))),
        ));
    for (const field of SYNCED_FIELDS) {
      if (result.overwritten && field in result.overwritten && !fields.includes(field)) errors.push(`${at}: overwritten names ${field}, which the push did not set`);
    }
    planned.push({ result, entries: own, fields });
  });
  if (errors.length > 0) throw new OverseerError('INVALID_INPUT', `${errors.join('; ')}; nothing was written.`);

  return tx(db, () => {
    const now = nowIso();
    const confirmCtx: Ctx = { ...ctx, via: `sync:${connection.host}`, origin_connection: connection.id };
    const overwrites: SyncOverwrite[] = [];
    const upsert = db.prepare(
      `INSERT INTO item_remote_refs(item_id, connection_id, external_ref, url, state, synced_at, synced_fields) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id, connection_id) DO UPDATE SET
         external_ref = excluded.external_ref, url = excluded.url, state = excluded.state, synced_at = excluded.synced_at,
         synced_fields = excluded.synced_fields`,
    );
    const legacyHolder = db.prepare('SELECT 1 FROM items WHERE lower(external_ref) = lower(?)');
    const setLegacy = db.prepare(
      'UPDATE items SET external_ref = ?, external_url = ?, external_state = ?, external_synced_at = ? WHERE id = ? AND external_ref IS NULL',
    );
    const confirmed: ConfirmedPush[] = [];
    for (const { result, fields } of planned) {
      const row = getRow(db, result.item_id);
      if (!row) {
        confirmed.push({ item_id: result.item_id, external_id: result.external_id, url: result.url, state: result.state, fields: [] });
        continue;
      }
      const earlier = linked.get(result.item_id, connection.id) as { synced_fields: string } | undefined;
      const pushed = { ...targetIssue(toItem(row), mapping).issue, state: result.state };
      const merged: SyncedFields = { ...(earlier ? (JSON.parse(earlier.synced_fields) as SyncedFields) : {}) };
      for (const field of fields) Object.assign(merged, { [field]: pushed[field] });
      const snapshot = Object.fromEntries(SYNCED_FIELDS.filter((field) => field in merged).map((field) => [field, merged[field]]));
      upsert.run(result.item_id, connection.id, result.external_id, result.url, result.state, now, JSON.stringify(snapshot));
      const legacy = `${connection.host}:${result.external_id}`;
      if (row.external_ref === null && !legacyHolder.get(legacy)) setLegacy.run(legacy, result.url, result.state, now, result.item_id);
      for (const field of SYNCED_FIELDS) {
        if (!result.overwritten || !(field in result.overwritten)) continue;
        const entry: SyncOverwrite = {
          item_id: result.item_id,
          external_ref: result.external_id,
          field,
          winner: 'local',
          value: pushed[field] ?? null,
          overwritten: result.overwritten[field] ?? null,
        };
        service.addEvent(result.item_id, confirmCtx, now, 'overwrite', field, entry.overwritten, entry.value);
        overwrites.push(entry);
      }
      confirmed.push({ item_id: result.item_id, external_id: result.external_id, url: result.url, state: result.state, fields: SYNCED_FIELDS.filter((field) => fields.includes(field)) });
    }
    service.connections.recordOverwrites(connection.id, 'confirm', now, overwrites);
    const acked = service.outbox.ack([...seen]).acked;
    return { connection_id: connection.id, confirmed, acked };
  });
}

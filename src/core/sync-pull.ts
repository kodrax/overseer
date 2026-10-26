import { nowIso, tx } from './db.js';
import {
  closedStatus,
  DESCRIPTION_MAX,
  descriptionCutWarning,
  type ImportItem,
  insertImportedItem,
  kindLabelWarning,
  type LabelMapping,
  labelStatus,
  linkImportedParent,
  openStatus,
  type SyncedField,
  type SyncedFields,
  translateLabels,
  writeRemoteRefs,
} from './import.js';
import { columnValue, getRow, toItem, writeFts } from './items.js';
import { CLOSED_STATUSES, type Ctx, DELIVERED_STATUSES, type ImportSource, type Item } from './schema.js';
import type { OverseerService } from './service.js';
import { computeSyncPlan, loadSyncPlanInput, type PullOp, type SyncConflict, uniqueIssues } from './sync-plan.js';

export interface SyncPullResult {
  /** Items created for issues no item had. */
  created: { item_id: string; external_ref: string }[];
  /** Items whose planned issue fields were applied, with those fields (their snapshot is refreshed). */
  updated: { item_id: string; external_ref: string; fields: SyncedField[] }[];
  /** Fields changed on both sides, left untouched (as `sync plan` lists them). */
  conflicts: SyncConflict[];
  warnings: string[];
}

/** Item fields an issue field fills; `labels` also sets the priority and status, `state` the status. */
const ITEM_FIELDS: Record<Exclude<SyncedField, 'state'>, keyof Item> = {
  title: 'title',
  body: 'description',
  labels: 'tags',
  assignee: 'assignee',
  milestone: 'milestone',
};

/**
 * Applies one pull update: the planned issue fields to the item (title, body as description, labels through the
 * connection's mapping as tags and priority, assignee, milestone), with an event per changed field, then the remote
 * ref's snapshot of those fields. When `state` or `labels` is pulled, a mapped status label that agrees with the
 * issue's state sets the status ({@link labelStatus}; a pull of labels alone only when the item's status is already on
 * the issue's side). Otherwise the state closes or reopens the status only when the item's status is on the other side.
 */
function applyUpdate(
  service: OverseerService,
  connectionId: number,
  host: ImportSource,
  mapping: LabelMapping,
  op: PullOp,
  remote: ImportItem,
  ctx: Ctx,
  now: string,
  warnings: string[],
): void {
  const db = service.db;
  const row = getRow(db, op.item_id!)!;
  const current = toItem(row);
  // Labels keep the listing's order, as import stores them.
  const mapped = translateLabels(remote.labels ?? [], mapping);
  const incoming: Partial<Record<keyof Item, unknown>> = {};
  for (const field of op.fields) {
    if (field === 'state') continue;
    if (field === 'body') {
      incoming.description = (op.issue.body ?? '').slice(0, DESCRIPTION_MAX);
      const warning = descriptionCutWarning(row.id, { body: op.issue.body, url: op.url });
      if (warning) warnings.push(warning);
    } else if (field === 'labels') {
      incoming.tags = mapped.tags;
      if (mapped.priority) incoming.priority = mapped.priority;
      const warning = kindLabelWarning(row.id, current.kind, mapped);
      if (warning) warnings.push(warning);
    } else {
      incoming[ITEM_FIELDS[field]] = op.issue[field];
    }
  }
  const changes = (Object.keys(incoming) as (keyof Item)[]).filter((field) => JSON.stringify(current[field] ?? null) !== JSON.stringify(incoming[field] ?? null));
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const field of changes) {
    sets.push(`${field} = ?`);
    params.push(columnValue(incoming[field]));
    service.addEvent(row.id, ctx, now, 'update', field, current[field], incoming[field]);
  }
  const closed = DELIVERED_STATUSES[current.kind].includes(current.status) || CLOSED_STATUSES[current.kind].includes(current.status);
  const statePulled = op.fields.includes('state');
  const labelsPulled = op.fields.includes('labels') && closed === (op.issue.state === 'closed');
  const fromLabels = statePulled || labelsPulled ? labelStatus(current.kind, op.issue.state, mapped.statuses) : undefined;
  const status =
    fromLabels ??
    (statePulled && op.issue.state === 'closed' && !closed
      ? closedStatus(current.kind, host, remote.state_reason)
      : statePulled && op.issue.state === 'open' && closed
        ? openStatus(current.kind, remote.labels ?? [])
        : current.status);
  const statusChanged = status !== current.status;
  if (statusChanged) {
    sets.push('status = ?', 'status_changed_at = ?');
    params.push(status, now);
    const delivered = DELIVERED_STATUSES[current.kind].includes(status);
    if (delivered && !current.delivered_at) {
      sets.push('delivered_at = ?');
      params.push(now);
    } else if (!delivered && current.delivered_at) {
      sets.push('delivered_at = NULL');
    }
    service.addEvent(row.id, ctx, now, 'status', 'status', current.status, status);
  }
  if (current.external_ref === `${host}:${op.external_ref}`) {
    sets.push('external_url = ?', 'external_state = ?', 'external_synced_at = ?');
    params.push(op.url, op.issue.state, now);
  }
  if (changes.length > 0 || statusChanged) {
    sets.push('updated_at = ?');
    params.push(now);
  }
  if (sets.length > 0) db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE rid = ?`).run(...params, row.rid);
  if (changes.some((field) => field === 'title' || field === 'description' || field === 'tags')) writeFts(db, row.rid, toItem(getRow(db, row.id)!));
  const ref = db.prepare('SELECT synced_fields FROM item_remote_refs WHERE item_id = ? AND connection_id = ?').get(row.id, connectionId) as { synced_fields: string };
  const snapshot = JSON.parse(ref.synced_fields) as Record<string, unknown>;
  for (const field of op.fields) snapshot[field] = op.issue[field];
  db.prepare('UPDATE item_remote_refs SET url = ?, state = ?, synced_at = ?, synced_fields = ? WHERE item_id = ? AND connection_id = ?').run(
    op.url,
    (snapshot as SyncedFields).state ?? null,
    now,
    JSON.stringify(snapshot),
    row.id,
    connectionId,
  );
}

/**
 * Applies the pull operations of a connection's sync plan (the same computation as `sync plan`) in one transaction:
 * a pull create creates the item as import does, with its remote ref and snapshot; a pull update applies only its
 * planned fields (fields with a pending local change are not planned, unless this connection is the source of truth
 * and overwrites them) and refreshes their snapshot. Each overwritten local value gets an `overwrite` event (field,
 * the local value, the issue's) after the item's update events, and the plan's overwritten list replaces the
 * connection's latest pull overwrites (`sync status`). Conflicts are left
 * untouched and returned. Events are recorded via `sync:<host>`; the outbox skips this connection and queues the
 * others. Applying the same listing again changes nothing.
 */
export function pullSync(service: OverseerService, connectionId: number | string, payload: unknown, ctx: Ctx): SyncPullResult {
  const input = loadSyncPlanInput(service, connectionId, payload);
  const plan = computeSyncPlan(input);
  const connection = service.connections.require(input.connection_id);
  const issues = uniqueIssues(input.issues, []);
  const result: SyncPullResult = { created: [], updated: [], conflicts: plan.conflicts, warnings: [...plan.warnings] };
  if (plan.pull.length === 0) return result;
  const pullCtx: Ctx = { ...ctx, via: `sync:${connection.host}`, origin_connection: connection.id };
  const now = nowIso();
  // The planned connection is the source of truth: every resolved conflict is a local value the pull replaces.
  const overwrites = plan.overwritten.filter((entry) => entry.winner === 'remote');
  tx(service.db, () => {
    const created: { id: string; remote: ImportItem }[] = [];
    for (const op of plan.pull) {
      const remote = issues.get(op.external_ref)!;
      if (op.op === 'create') {
        const id = insertImportedItem(service, remote, connection.host, input.mapping, pullCtx, now, result.warnings);
        created.push({ id, remote });
        result.created.push({ item_id: id, external_ref: op.external_ref });
      } else {
        applyUpdate(service, connection.id, connection.host, input.mapping, op, remote, pullCtx, now, result.warnings);
        for (const entry of overwrites) {
          if (entry.item_id === op.item_id) service.addEvent(entry.item_id, pullCtx, now, 'overwrite', entry.field, entry.overwritten, entry.value);
        }
        result.updated.push({ item_id: op.item_id!, external_ref: op.external_ref, fields: op.fields });
      }
    }
    writeRemoteRefs(service.db, connection.id, created, now, result.warnings);
    service.connections.recordOverwrites(connection.id, 'pull', now, overwrites);
    // Parents after every create, so a parent issue may come anywhere in the listing.
    for (const { remote } of created) linkImportedParent(service, connection.host, remote, pullCtx, now, result.warnings);
  });
  return result;
}

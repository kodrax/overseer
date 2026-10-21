import { z } from 'zod';
import { compareIds } from './ids.js';
import {
  canonicalLabels,
  type ImportItem,
  type IssueFields,
  importItemSchema,
  issueFieldsOf,
  mapImportPayload,
  RAW_PAYLOAD_FORMATS,
  SYNCED_FIELDS,
  type SyncedField,
  type SyncedFields,
} from './import.js';
import { getRow, toItem } from './items.js';
import { type DimensionMapping, MAPPING_DIMENSIONS, MAPPING_LOCAL_VALUES, type MappingDimension } from './mappings.js';
import type { OutboxEntry } from './outbox.js';
import { CLOSED_STATUSES, DELIVERED_STATUSES, type Item, parseInput } from './schema.js';
import type { OverseerService, TombstoneRef } from './service.js';

/** What a push does with one issue: open a new one, change fields, or change fields and close or reopen it. */
export type PushOperation = 'create' | 'update' | 'close' | 'reopen';

type IssueState = IssueFields['state'];

/**
 * The whole issue as a push leaves it. `body` and `labels` are null only for the close of a deleted item whose issue
 * the listing lacks: that close sets the state alone.
 */
export interface TargetIssue extends Omit<IssueFields, 'body' | 'labels'> {
  body: string | null;
  labels: string[] | null;
}

/** One local change to send to the connection's repository. */
export interface PushOp {
  op: PushOperation;
  item_id: string;
  /** The outbox entry to acknowledge once the push is confirmed. */
  seq: number;
  /** The linked issue (`owner/repo#12`); null for create. */
  external_ref: string | null;
  url: string | null;
  /** Issue fields the push sets, in SYNCED_FIELDS order; every field for create. */
  fields: SyncedField[];
  issue: TargetIssue;
}

/** One remote change to apply to the board. */
export interface PullOp {
  /** create: no item has the issue; update: apply `fields` to the linked item. */
  op: 'create' | 'update';
  external_ref: string;
  url: string;
  item_id: string | null;
  /** Issue fields to apply, in SYNCED_FIELDS order; every field the listing has for create. */
  fields: SyncedField[];
  /** The issue as the listing has it; `body` is null when the listing has no bodies (GitLab list_work_items). */
  issue: Omit<IssueFields, 'body'> & { body: string | null };
}

type FieldValue = IssueFields[SyncedField] | null;

/** A field changed both locally (pending outbox entry) and remotely (against the snapshot), to different values. */
export interface SyncConflict {
  item_id: string;
  seq: number;
  external_ref: string;
  url: string | null;
  field: SyncedField;
  /** The value the push would send. */
  local: FieldValue;
  /** The value in the listing. */
  remote: FieldValue;
  /** The value as of the last sync. */
  snapshot: FieldValue;
}

export interface SyncPlan {
  push: PushOp[];
  pull: PullOp[];
  conflicts: SyncConflict[];
  warnings: string[];
}

/** An `item_remote_refs` row of the planned connection. */
export interface PlanRemoteRef {
  item_id: string;
  external_ref: string;
  url: string | null;
  state: string | null;
  synced_fields: SyncedFields;
}

/** A deleted item and the issue it was linked to in the planned connection, if any. */
export interface PlanTombstone {
  title: string;
  ref: { external_ref: string; url: string | null } | null;
}

/** Everything the planner reads; {@link planSync} loads it from the project database and the listing. */
export interface SyncPlanInput {
  connection_id: number;
  mapping: Record<MappingDimension, DimensionMapping>;
  outbox: readonly OutboxEntry[];
  /** The items of the outbox entries. */
  items: ReadonlyMap<string, Item>;
  refs: readonly PlanRemoteRef[];
  /** Deleted items by ID. */
  tombstones: ReadonlyMap<string, PlanTombstone>;
  /** External IDs of issues whose item was deleted locally (connection refs and imported refs). */
  deleted_issues: ReadonlySet<string>;
  /** Item ID by the external ID of its imported `external_ref` on the connection's host. */
  imported: ReadonlyMap<string, string>;
  issues: readonly ImportItem[];
  /** Warnings of the payload adapter (skipped pull requests). */
  warnings: readonly string[];
}

/** Issue fields each local item field shows up in; other item fields are not synced. */
const REMOTE_FIELDS: Record<string, readonly SyncedField[]> = {
  title: ['title'],
  description: ['body'],
  tags: ['labels'],
  kind: ['labels'],
  priority: ['labels'],
  status: ['state', 'labels'],
  assignee: ['assignee'],
  milestone: ['milestone'],
};

const STATE_NAMES: Record<string, IssueState> = { open: 'open', opened: 'open', closed: 'closed' };

/** The issue state a mapped status value names (`open`, `opened`, `closed`, any case); undefined for a label. */
function mappedState(remote: string): IssueState | undefined {
  const key = remote.toLowerCase();
  return Object.hasOwn(STATE_NAMES, key) ? STATE_NAMES[key] : undefined;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `owner/repo#N` by repository, then issue number. */
function compareExternalIds(a: string, b: string): number {
  const [ra, na] = [a.slice(0, a.lastIndexOf('#')), Number(a.slice(a.lastIndexOf('#') + 1))];
  const [rb, nb] = [b.slice(0, b.lastIndexOf('#')), Number(b.slice(b.lastIndexOf('#') + 1))];
  return ra === rb && Number.isFinite(na) && Number.isFinite(nb) && na !== nb ? na - nb : byCodeUnit(a, b);
}

/**
 * The issue an item should be, through the connection's mapping: the mapped kind and priority values are labels; the
 * mapped status value is the state when it is `open`, `opened` or `closed`, else a label. Tags holding another mapped
 * label (an earlier kind, priority or status) are dropped. Without a state in the mapping, delivered and closed
 * statuses close the issue. Returns the dimensions whose value is unmapped too.
 */
function targetIssue(item: Item, mapping: SyncPlanInput['mapping']): { issue: IssueFields; unmapped: MappingDimension[] } {
  const mappedLabels = new Set(
    MAPPING_DIMENSIONS.flatMap((dimension) =>
      Object.values(mapping[dimension]).filter((remote): remote is string => remote !== null && (dimension !== 'status' || mappedState(remote) === undefined)),
    ),
  );
  const labels = item.tags.filter((tag) => !mappedLabels.has(tag));
  let state: IssueState = DELIVERED_STATUSES[item.kind].includes(item.status) || CLOSED_STATUSES[item.kind].includes(item.status) ? 'closed' : 'open';
  const unmapped: MappingDimension[] = [];
  for (const dimension of MAPPING_DIMENSIONS) {
    const remote = mapping[dimension][item[dimension]] ?? null;
    if (remote === null) unmapped.push(dimension);
    else if (dimension === 'status' && mappedState(remote)) state = mappedState(remote)!;
    else labels.push(remote);
  }
  return {
    issue: { title: item.title, body: item.description, labels: canonicalLabels(labels), state, assignee: item.assignee, milestone: item.milestone },
    unmapped,
  };
}

/** The snapshot a remote ref compares against: its synced fields, with the ref's state when the snapshot lacks one. */
function baseOf(ref: PlanRemoteRef): SyncedFields {
  const state: SyncedFields = ref.state === 'open' || ref.state === 'closed' ? { state: ref.state } : {};
  const base: SyncedFields = { ...state, ...ref.synced_fields };
  if (base.labels) base.labels = canonicalLabels(base.labels);
  return base;
}

/** One entry per issue: the one updated last (then the larger JSON) when the listing repeats an issue, with a warning. */
export function uniqueIssues(issues: readonly ImportItem[], warnings: string[]): Map<string, ImportItem> {
  const groups = new Map<string, ImportItem[]>();
  for (const issue of issues) groups.set(issue.external_id, [...(groups.get(issue.external_id) ?? []), issue]);
  const unique = new Map<string, ImportItem>();
  for (const id of [...groups.keys()].sort(compareExternalIds)) {
    const group = groups.get(id)!;
    const time = (issue: ImportItem) => Date.parse(issue.updated_at ?? '') || 0;
    const [first] = [...group].sort((a, b) => time(b) - time(a) || byCodeUnit(JSON.stringify(b), JSON.stringify(a)));
    if (group.length > 1) warnings.push(`${id}: listed ${group.length} times; the entry updated last was used.`);
    unique.set(id, first!);
  }
  return unique;
}

/**
 * The push, pull and conflict operations that bring one connection's repository and the board together, from its
 * pending outbox entries, remote refs (with their last synced snapshot), mapping and a listing of its issues. Pure:
 * the same input always gives the same plan, in the same order (push and conflicts by item ID, pull by issue).
 *
 * - push: each outbox entry. No remote ref → create; else the issue fields its changed fields touch, minus those the
 *   issue already had at the last sync → update, or close/reopen when the state changes. A pending create with a
 *   remote ref updates every field. A delete closes the issue of the deleted item.
 * - pull: each linked issue's fields that differ from the snapshot and have no pending local change; each issue no
 *   item has → create.
 * - conflicts: a field with a pending local change whose remote value also differs from the snapshot, unless both
 *   sides hold the same value now. Neither push nor pull touches it.
 */
export function computeSyncPlan(input: SyncPlanInput): SyncPlan {
  const connection = input.connection_id;
  const warnings = [...input.warnings].sort(byCodeUnit);
  const issues = uniqueIssues(input.issues, warnings);
  const refByItem = new Map(input.refs.map((ref) => [ref.item_id, ref]));
  const refByIssue = new Map(input.refs.map((ref) => [ref.external_ref, ref]));
  const push: PushOp[] = [];
  const conflicts: SyncConflict[] = [];
  /** Issue fields each item changed locally since the last sync, skipped by pull. */
  const localChanges = new Map<string, Set<SyncedField>>();
  /** Items per unmapped dimension and local value. */
  const unmapped = new Map<string, string[]>();
  const nothingToPush = (entry: OutboxEntry, reason: string) =>
    warnings.push(`${entry.item_id}: nothing to push to connection ${connection} (${reason}); outbox seq ${entry.seq} can be acknowledged.`);

  for (const entry of [...input.outbox].sort((a, b) => compareIds(a.item_id, b.item_id))) {
    if (entry.operation === 'delete') {
      const ref = input.tombstones.get(entry.item_id)?.ref;
      if (!ref) {
        nothingToPush(entry, 'deleted locally, linked to no issue there');
        continue;
      }
      const remote = issues.get(ref.external_ref);
      const current = remote && issueFieldsOf(remote);
      if (current?.state === 'closed') {
        nothingToPush(entry, `deleted locally, ${ref.external_ref} is already closed`);
        continue;
      }
      push.push({
        op: 'close',
        item_id: entry.item_id,
        seq: entry.seq,
        external_ref: ref.external_ref,
        url: ref.url,
        fields: ['state'],
        issue: {
          title: current?.title ?? input.tombstones.get(entry.item_id)!.title,
          body: current?.body ?? null,
          labels: current?.labels ?? null,
          state: 'closed',
          assignee: current?.assignee ?? null,
          milestone: current?.milestone ?? null,
        },
      });
      continue;
    }
    const item = input.items.get(entry.item_id);
    if (!item) {
      nothingToPush(entry, 'the item no longer exists');
      continue;
    }
    const { issue: target, unmapped: missing } = targetIssue(item, input.mapping);
    const ref = refByItem.get(item.id);
    let op: PushOp | undefined;
    if (!ref) {
      op = { op: 'create', item_id: item.id, seq: entry.seq, external_ref: null, url: null, fields: [...SYNCED_FIELDS], issue: target };
    } else {
      // A pending create whose item already has an issue here (TASK-0018) sends the whole item as an update.
      const touched = SYNCED_FIELDS.filter(
        (field) => entry.operation === 'create' || entry.changed_fields.some((changed) => Object.hasOwn(REMOTE_FIELDS, changed) && REMOTE_FIELDS[changed]!.includes(field)),
      );
      const base = baseOf(ref);
      const remote = issues.get(ref.external_ref);
      const current = remote && issueFieldsOf(remote);
      const changes = new Set<SyncedField>();
      const fields: SyncedField[] = [];
      for (const field of touched) {
        // The issue held this value at the last sync: the local edits left the field as it was.
        if (field in base && same(target[field], base[field])) continue;
        changes.add(field);
        if (current && field in current && field in base && !same(current[field], base[field])) {
          if (!same(current[field], target[field])) {
            conflicts.push({
              item_id: item.id,
              seq: entry.seq,
              external_ref: ref.external_ref,
              url: ref.url,
              field,
              local: target[field],
              remote: current[field] ?? null,
              snapshot: base[field] ?? null,
            });
          }
          continue;
        }
        fields.push(field);
      }
      localChanges.set(item.id, changes);
      if (fields.length > 0) {
        const kind: PushOperation = fields.includes('state') ? (target.state === 'closed' ? 'close' : 'reopen') : 'update';
        op = { op: kind, item_id: item.id, seq: entry.seq, external_ref: ref.external_ref, url: ref.url, fields, issue: target };
      } else if (!conflicts.some((conflict) => conflict.seq === entry.seq)) {
        nothingToPush(entry, touched.length === 0 ? `${entry.changed_fields.join(', ')} not synced` : `${ref.external_ref} already matches`);
      }
    }
    if (!op) continue;
    push.push(op);
    for (const dimension of missing) {
      const key = `${dimension}\u0000${item[dimension]}`;
      unmapped.set(key, [...(unmapped.get(key) ?? []), item.id]);
    }
  }

  for (const dimension of MAPPING_DIMENSIONS) {
    for (const value of MAPPING_LOCAL_VALUES[dimension]) {
      const ids = unmapped.get(`${dimension}\u0000${value}`);
      if (!ids) continue;
      const effect = dimension === 'status' ? 'no label sent; the state follows the status' : 'no label sent';
      warnings.push(`${dimension} "${value}" is unmapped on connection ${connection} (${ids.join(', ')}): ${effect}.`);
    }
  }

  const pull: PullOp[] = [];
  for (const [externalId, remote] of issues) {
    const current = issueFieldsOf(remote);
    const issue = { title: current.title, body: current.body ?? null, labels: current.labels, state: current.state, assignee: current.assignee, milestone: current.milestone };
    const ref = refByIssue.get(externalId);
    if (!ref) {
      if (input.deleted_issues.has(externalId)) continue;
      const imported = input.imported.get(externalId);
      if (imported) {
        warnings.push(`${externalId}: imported as ${imported} but not linked to it in connection ${connection}; import the issue again to link it.`);
        continue;
      }
      pull.push({ op: 'create', external_ref: externalId, url: remote.url, item_id: null, fields: SYNCED_FIELDS.filter((field) => field in current), issue });
      continue;
    }
    const base = baseOf(ref);
    const skipped = localChanges.get(ref.item_id);
    const fields = SYNCED_FIELDS.filter((field) => field in current && field in base && !same(current[field], base[field]) && !skipped?.has(field));
    if (fields.length > 0) pull.push({ op: 'update', external_ref: externalId, url: remote.url, item_id: ref.item_id, fields, issue });
  }

  return { push, pull, conflicts, warnings };
}

interface RemoteRefRow {
  item_id: string;
  external_ref: string;
  url: string | null;
  state: string | null;
  synced_fields: string;
}

/**
 * The planner input of one connection (NOT_FOUND when unknown) against `payload`, a raw GitHub/GitLab MCP listing of
 * its issues (object or JSON text; a listing of the other host gives INVALID_INPUT). Reads the project database only.
 */
export function loadSyncPlanInput(service: OverseerService, connectionId: number | string, payload: unknown): SyncPlanInput {
  const connection = service.connections.require(connectionId);
  const mapped = mapImportPayload(payload, connection.host, connection.repository, RAW_PAYLOAD_FORMATS);
  const issues = parseInput(z.array(importItemSchema), mapped.items);
  const db = service.db;
  const outbox = service.outbox.list(connection.id);
  const items = new Map<string, Item>();
  for (const entry of outbox) {
    const row = getRow(db, entry.item_id);
    if (row) items.set(row.id, toItem(row));
  }
  const refs = (
    db.prepare('SELECT item_id, external_ref, url, state, synced_fields FROM item_remote_refs WHERE connection_id = ? ORDER BY item_id').all(connection.id) as unknown as RemoteRefRow[]
  ).map((row) => ({ ...row, synced_fields: JSON.parse(row.synced_fields) as SyncedFields }));
  const tombstones = new Map<string, PlanTombstone>();
  const deletedIssues = new Set<string>();
  const prefix = `${connection.host}:`;
  for (const row of db.prepare('SELECT item_id, title, external_refs FROM tombstones ORDER BY item_id').all() as { item_id: string; title: string; external_refs: string }[]) {
    const external = JSON.parse(row.external_refs) as TombstoneRef[];
    const ref = external.find((candidate) => candidate.connection_id === connection.id);
    tombstones.set(row.item_id, { title: row.title, ref: ref ? { external_ref: ref.external_ref, url: ref.url } : null });
    if (ref) deletedIssues.add(ref.external_ref);
    for (const legacy of external) {
      if (legacy.connection_id === null && legacy.external_ref.startsWith(prefix)) deletedIssues.add(legacy.external_ref.slice(prefix.length));
    }
  }
  const imported = new Map<string, string>();
  for (const row of db.prepare('SELECT id, external_ref FROM items WHERE substr(external_ref, 1, ?) = ?').all(prefix.length, prefix) as { id: string; external_ref: string }[]) {
    imported.set(row.external_ref.slice(prefix.length), row.id);
  }
  return {
    connection_id: connection.id,
    mapping: service.mappings.get(connection.id).mapping,
    outbox,
    items,
    refs,
    tombstones,
    deleted_issues: deletedIssues,
    imported,
    issues,
    warnings: mapped.warnings,
  };
}

/** The sync plan of one connection against a raw listing of its issues ({@link loadSyncPlanInput}); writes nothing. */
export function planSync(service: OverseerService, connectionId: number | string, payload: unknown): SyncPlan {
  return computeSyncPlan(loadSyncPlanInput(service, connectionId, payload));
}

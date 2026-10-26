import { z } from 'zod';
import type { Connection } from './connections.js';
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
import { type DimensionMapping, MAPPING_DIMENSIONS, MAPPING_LOCAL_VALUES, type MappingDimension, mappedLabels, mappedState } from './mappings.js';
import type { OutboxEntry } from './outbox.js';
import { CLOSED_STATUSES, DELIVERED_STATUSES, type Item, type Kind, parseInput } from './schema.js';
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
  /** The remote values these fields replace: fields in conflict won by the board or another connection as source of truth. */
  overwritten?: Partial<Record<SyncedField, FieldValue>>;
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
  /** The local values these fields replace: fields in conflict won by this connection as source of truth. */
  overwritten?: Partial<Record<SyncedField, FieldValue>>;
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

/** A conflict resolved by the source of truth: `winner` says which side's `value` the sync keeps. */
export interface SyncOverwrite {
  item_id: string;
  external_ref: string;
  field: SyncedField;
  /** local: the push sends the item's value (the board or another connection is the source of truth); remote: the pull applies the issue's. */
  winner: 'local' | 'remote';
  value: FieldValue;
  /** The losing value the sync replaces. */
  overwritten: FieldValue;
}

export interface SyncPlan {
  push: PushOp[];
  pull: PullOp[];
  conflicts: SyncConflict[];
  /** Seqs of outbox entries that need no remote call (nothing to send), to acknowledge as they are; ascending. */
  ack: number[];
  overwritten: SyncOverwrite[];
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
  /** The project's source of truth: the board or a connection id. Conflicts on the planned connection are resolved in its favour. */
  source_of_truth: 'board' | number;
  mapping: Record<MappingDimension, DimensionMapping>;
  outbox: readonly OutboxEntry[];
  /** The items of the outbox entries. */
  items: ReadonlyMap<string, Item>;
  refs: readonly PlanRemoteRef[];
  /**
   * The description of each item whose remote ref's snapshot has no body (synced from a listing without bodies, GitLab
   * `list_work_items`): the pull compares a listed body against it instead ({@link computeSyncPlan}).
   */
  descriptions: ReadonlyMap<string, string>;
  /** Deleted items by ID. */
  tombstones: ReadonlyMap<string, PlanTombstone>;
  /** External IDs of issues whose item was deleted locally (connection refs and imported refs). */
  deleted_issues: ReadonlySet<string>;
  /** Item ID by the external ID of its imported `external_ref` on the connection's host. */
  imported: ReadonlyMap<string, string>;
  /**
   * The highest item ID number per kind when the connection's sync started from a repository that already had issues;
   * null before the start and after a start that seeded an empty repository. See {@link existedBeforeSyncStart}.
   */
  start_baseline: SyncStartBaseline | null;
  /** Every connection's repository, to tell the items that came from another one ({@link neverCreatedOn}). */
  repositories: readonly ConnectedRepository[];
  issues: readonly ImportItem[];
  /** Warnings of the payload adapter (skipped pull requests). */
  warnings: readonly string[];
}

/** Issue fields each local item field shows up in; other item fields are not synced. */
export const REMOTE_FIELDS: Record<string, readonly SyncedField[]> = {
  title: ['title'],
  description: ['body'],
  tags: ['labels'],
  kind: ['labels'],
  priority: ['labels'],
  status: ['state', 'labels'],
  assignee: ['assignee'],
  milestone: ['milestone'],
};

/** The highest item ID number of each kind (`{"task": 12}`) as `sync start` recorded it; a missing kind had no item. */
export type SyncStartBaseline = Partial<Record<Kind, number>>;

/**
 * Whether an item existed before its connection's sync started from a repository that already had issues (`baseline`
 * non-null): its ID number is at most the highest of its kind then. IDs are never reused, so a later item is always
 * above it. Such an item without an issue on the connection is never pushed as a create: its outbox entries go to ack.
 * After a start that seeded an empty repository (`baseline` null) every item is pushed as usual.
 */
export function existedBeforeSyncStart(item: Pick<Item, 'id' | 'kind'>, baseline: SyncStartBaseline | null): boolean {
  if (baseline === null) return false;
  return Number(item.id.slice(item.id.lastIndexOf('-') + 1)) <= (baseline[item.kind] ?? 0);
}

/** A connection's host and repository, to tell which items came from it. */
export type ConnectedRepository = Pick<Connection, 'id' | 'host' | 'repository'>;

/**
 * The connection whose repository an item came from, or null. An item created from an issue (by `import`, `sync
 * start` or `sync pull`, so recorded via `import:<host>` or `sync:<host>`) keeps that issue as its `external_ref`,
 * `<host>:<repository>#<n>`; repositories compare case-insensitively. An item created on the board came from none,
 * even once a push gave it an `external_ref`; so does an issue of a repository no connection has.
 */
export function originConnection(item: Pick<Item, 'external_ref' | 'recorded_via'>, repositories: readonly ConnectedRepository[]): number | null {
  if (item.external_ref === null || !/^(import|sync):/.test(item.recorded_via)) return null;
  const match = /^(github|gitlab):(.+)#[1-9]\d*$/.exec(item.external_ref);
  if (!match) return null;
  const repository = match[2]!.toLowerCase();
  return repositories.find((candidate) => candidate.host === match[1] && candidate.repository.toLowerCase() === repository)?.id ?? null;
}

/**
 * Whether `sync plan` never pushes a create for an item without an issue on the planned connection; its outbox
 * entries go to ack instead. Each repository keeps its own issues, and only items created on the board reach every
 * connection:
 * - an item that existed before the connection's sync started from a repository with issues ({@link existedBeforeSyncStart});
 * - an item that came from another connection's repository ({@link originConnection}): brought in by its `sync start`
 *   or `sync pull`, or imported from it, whenever it changes later.
 */
export function neverCreatedOn(item: Pick<Item, 'id' | 'kind' | 'external_ref' | 'recorded_via'>, input: Pick<SyncPlanInput, 'connection_id' | 'start_baseline' | 'repositories'>): boolean {
  if (existedBeforeSyncStart(item, input.start_baseline)) return true;
  const origin = originConnection(item, input.repositories);
  return origin !== null && origin !== input.connection_id;
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
export function targetIssue(item: Item, mapping: SyncPlanInput['mapping']): { issue: IssueFields; unmapped: MappingDimension[] } {
  const mapped = mappedLabels(mapping);
  const labels = item.tags.filter((tag) => !mapped.has(tag));
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
 * the same input always gives the same plan, in the same order (push, conflicts and overwritten by item ID, pull by
 * issue).
 *
 * - push: each outbox entry. No remote ref → create, unless the item existed before a sync start that brought the
 *   repository's issues to the board or came from another connection's repository ({@link neverCreatedOn}) → ack;
 *   else the issue fields its changed fields touch, minus those the issue already had at the last sync → update, or
 *   close/reopen when the state changes. A pending create with a remote ref updates every field. A delete closes the
 *   issue of the deleted item.
 * - pull: each linked issue's fields that differ from the snapshot and have no pending local change; each issue no
 *   item has → create. A listed body whose snapshot has none (synced from a listing without bodies) is compared with
 *   the item's description instead, so a description edited in the repository reaches the board.
 * - a field with a pending local change whose remote value also differs from the snapshot, unless both sides hold the
 *   same value now, is a conflict the source of truth resolves: this connection → the remote value wins and the field
 *   is pulled; the board or another connection → the local value wins and the field is pushed. The op names the
 *   losing value in `overwritten`, and `overwritten` lists each resolution; `conflicts` keeps only unresolved ones.
 */
export function computeSyncPlan(input: SyncPlanInput): SyncPlan {
  const connection = input.connection_id;
  const warnings = [...input.warnings].sort(byCodeUnit);
  const issues = uniqueIssues(input.issues, warnings);
  const refByItem = new Map(input.refs.map((ref) => [ref.item_id, ref]));
  const refByIssue = new Map(input.refs.map((ref) => [ref.external_ref, ref]));
  const push: PushOp[] = [];
  const conflicts: SyncConflict[] = [];
  const overwritten: SyncOverwrite[] = [];
  const remoteWins = input.source_of_truth === connection;
  /** Local values the pull replaces, by item and field: conflicts this connection wins. */
  const pulledOver = new Map<string, Partial<Record<SyncedField, FieldValue>>>();
  /** Issue fields each item changed locally since the last sync, skipped by pull. */
  const localChanges = new Map<string, Set<SyncedField>>();
  /** Items per unmapped dimension and local value. */
  const unmapped = new Map<string, string[]>();
  /**
   * Outbox entries with nothing to send: deleted items without an open issue, gone items, items without an issue that
   * existed before the sync start or came from another connection's repository, issues that already match or won
   * every changed field.
   */
  const ack: number[] = [];

  for (const entry of [...input.outbox].sort((a, b) => compareIds(a.item_id, b.item_id))) {
    if (entry.operation === 'delete') {
      const ref = input.tombstones.get(entry.item_id)?.ref;
      if (!ref) {
        ack.push(entry.seq);
        continue;
      }
      const remote = issues.get(ref.external_ref);
      const current = remote && issueFieldsOf(remote);
      if (current?.state === 'closed') {
        ack.push(entry.seq);
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
      ack.push(entry.seq);
      continue;
    }
    const { issue: target, unmapped: missing } = targetIssue(item, input.mapping);
    const ref = refByItem.get(item.id);
    let op: PushOp | undefined;
    if (!ref) {
      if (neverCreatedOn(item, input)) {
        ack.push(entry.seq);
        continue;
      }
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
      const issue: TargetIssue = { ...target };
      const replaced: Partial<Record<SyncedField, FieldValue>> = {};
      const lost: SyncedField[] = [];
      for (const field of touched) {
        // The issue held this value at the last sync: the local edits left the field as it was.
        if (field in base && same(target[field], base[field])) continue;
        changes.add(field);
        if (current && field in current && field in base && !same(current[field], base[field])) {
          if (!same(current[field], target[field])) {
            const local = target[field];
            const theirs = current[field] ?? null;
            overwritten.push({
              item_id: item.id,
              external_ref: ref.external_ref,
              field,
              winner: remoteWins ? 'remote' : 'local',
              value: remoteWins ? theirs : local,
              overwritten: remoteWins ? local : theirs,
            });
            if (remoteWins) {
              // The pull applies the issue's value; a push of other fields leaves this one as the issue has it.
              pulledOver.set(item.id, { ...pulledOver.get(item.id), [field]: local });
              Object.assign(issue, { [field]: theirs });
              lost.push(field);
              continue;
            }
            replaced[field] = theirs;
            fields.push(field);
          }
          continue;
        }
        fields.push(field);
      }
      localChanges.set(item.id, changes);
      if (fields.length > 0) {
        const kind: PushOperation = fields.includes('state') ? (issue.state === 'closed' ? 'close' : 'reopen') : 'update';
        op = { op: kind, item_id: item.id, seq: entry.seq, external_ref: ref.external_ref, url: ref.url, fields, issue };
        if (Object.keys(replaced).length > 0) op.overwritten = replaced;
      } else {
        // Nothing left to send: the issue already matches, or it won every changed field as source of truth.
        ack.push(entry.seq);
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
    const description = input.descriptions.get(ref.item_id);
    if (!('body' in base) && description !== undefined) base.body = description;
    const skipped = localChanges.get(ref.item_id);
    const replaced = pulledOver.get(ref.item_id);
    const fields = SYNCED_FIELDS.filter(
      (field) => field in current && field in base && !same(current[field], base[field]) && (!skipped?.has(field) || (replaced !== undefined && field in replaced)),
    );
    if (fields.length === 0) continue;
    const op: PullOp = { op: 'update', external_ref: externalId, url: remote.url, item_id: ref.item_id, fields, issue };
    if (replaced) op.overwritten = replaced;
    pull.push(op);
  }

  return { push, pull, conflicts, ack: ack.sort((a, b) => a - b), overwritten, warnings };
}

/** The connection's {@link SyncStartBaseline}, or null (not started, or started by seeding an empty repository). */
export function syncStartBaseline(service: OverseerService, connectionId: number): SyncStartBaseline | null {
  const row = service.db.prepare('SELECT sync_start_baseline FROM connections WHERE id = ?').get(connectionId) as { sync_start_baseline: string | null } | undefined;
  return row?.sync_start_baseline ? (JSON.parse(row.sync_start_baseline) as SyncStartBaseline) : null;
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
  const descriptions = new Map<string, string>();
  const description = db.prepare('SELECT description FROM items WHERE id = ?');
  for (const ref of refs) {
    if ('body' in ref.synced_fields) continue;
    const row = description.get(ref.item_id) as { description: string } | undefined;
    if (row) descriptions.set(ref.item_id, row.description);
  }
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
    source_of_truth: service.connections.sourceOfTruth().source_of_truth,
    mapping: service.mappings.get(connection.id).mapping,
    outbox,
    items,
    refs,
    descriptions,
    tombstones,
    deleted_issues: deletedIssues,
    imported,
    start_baseline: syncStartBaseline(service, connection.id),
    repositories: service.connections.list().map(({ id, host, repository }) => ({ id, host, repository })),
    issues,
    warnings: mapped.warnings,
  };
}

/** The sync plan of one connection against a raw listing of its issues ({@link loadSyncPlanInput}); writes nothing. */
export function planSync(service: OverseerService, connectionId: number | string, payload: unknown): SyncPlan {
  return computeSyncPlan(loadSyncPlanInput(service, connectionId, payload));
}

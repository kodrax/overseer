import { z } from 'zod';
import { type Database, nowIso, tx } from './db.js';
import { OverseerError } from './errors.js';
import { columnValue, getRow, toItem, writeFts } from './items.js';
import { type ConnectionMapping, isMappedLabel, MAPPING_LOCAL_VALUES, type MappingDimension } from './mappings.js';
import { normalizeRepositoryPath } from './remotes.js';
import {
  CLOSED_STATUSES,
  type Ctx,
  DELIVERED_STATUSES,
  IMPORT_SOURCES,
  type ImportSource,
  type Item,
  KINDS,
  type Kind,
  PARENT_KINDS,
  type Priority,
  parseInput,
  STATUSES,
} from './schema.js';
import type { OverseerService } from './service.js';

/** Longest item description an issue body fills; a longer body is cut with a warning. */
export const DESCRIPTION_MAX = 20000;

export const importItemSchema = z.object({
  external_id: z.string().trim().min(1).max(500),
  url: z.string().max(2000),
  title: z.string().trim().min(1).max(500),
  body: z.string().nullish(),
  state: z.enum(['open', 'closed']),
  /** Why a GitHub issue was closed (completed, not_planned, duplicate); not_planned and duplicate cancel the item. */
  state_reason: z.string().max(100).nullish(),
  labels: z.array(z.string().max(200)).max(100).optional(),
  type_hint: z.enum(KINDS).optional(),
  assignees: z.array(z.string().max(200)).max(50).optional(),
  milestone: z.string().max(500).nullish(),
  created_at: z.string().max(100).nullish(),
  updated_at: z.string().max(100).nullish(),
  parent_external_id: z.string().max(500).nullish(),
});

/** One to 100 ImportItems; parseImportRequest accepts an empty list only next to `deleted`. */
const importItemsSchema = z.array(importItemSchema).max(100);

const importInputSchema = z.object({
  source: z.enum(IMPORT_SOURCES),
  repo: z.string().trim().min(1).max(500),
  items: importItemsSchema,
  deleted: z
    .array(z.string().trim().min(1).max(500))
    .max(100)
    .optional()
    .describe('external_id of each issue deleted in the repository; its item is deleted (tombstone kept). Optional.'),
});

/** `import_items` arguments: exactly one of `items` or `payload` (a raw GitHub/GitLab MCP response). */
export const importRequestSchema = importInputSchema.extend({
  items: importItemsSchema.optional().describe('ImportItems (1 to 100, or none when deleted is given); pass this or payload.'),
  payload: z
    .unknown()
    .optional()
    .describe(
      'Raw response of the GitHub MCP list_issues tool ({"issues": [...]}) or of the GitLab MCP list_issues ([...] REST issues, with descriptions), list_work_items ({"items": [...]}) or get_work_item tool, as returned (object or JSON text); pass this or items.',
    ),
});

export type ImportItem = z.infer<typeof importItemSchema>;
export type ImportInput = z.infer<typeof importInputSchema>;

export interface ImportResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  /** Items deleted because their issue is in `deleted`. */
  deleted: string[];
  warnings: string[];
  possible_duplicates: { id: string; similar_to: { id: string; similarity: number }[] }[];
  last_import_at: string;
}

/** Kind from `type_hint`, else from labels (S10). */
export function importKind(item: Pick<ImportItem, 'type_hint' | 'labels'>): Kind {
  if (item.type_hint) return item.type_hint;
  const labels = (item.labels ?? []).map((label) => label.toLowerCase());
  const has = (pattern: RegExp) => labels.some((label) => pattern.test(label));
  if (has(/bug|defect|regression|incident/)) return 'bug';
  if (has(/epic/)) return 'epic';
  if (has(/requirement|^req$|nfr|non-functional/)) return 'requirement';
  if (has(/story|feature|enhancement/)) return 'story';
  return 'task';
}

/** Status of an item whose issue is open: approved requirements, open epics, else in_progress for an in-progress label or backlog. */
export function openStatus(kind: Kind, labels: readonly string[]): string {
  if (kind === 'requirement') return 'approved';
  if (kind === 'epic') return 'open';
  return labels.some((label) => /in progress|doing|wip/i.test(label)) ? 'in_progress' : 'backlog';
}

/** GitHub close reasons (REST state_reason, GraphQL stateReason, any case) that cancel an item instead of finishing it. */
const CANCELLING_REASONS = ['not_planned', 'duplicate'];

/** Requirements become implemented; other kinds done, or cancelled for a GitHub issue closed as not planned or duplicate. */
export function closedStatus(kind: Kind, source: ImportSource, reason: string | null | undefined): string {
  if (kind === 'requirement') return 'implemented';
  return source === 'github' && CANCELLING_REASONS.includes((reason ?? '').toLowerCase()) ? 'cancelled' : 'done';
}

/** A connection's mapping, as the labels of its issues are read through it. */
export type LabelMapping = ConnectionMapping['mapping'];

/** What an issue's labels say through its connection's mapping. */
export interface MappedIssueLabels {
  /** The kind a label maps to; the first in local-value order when labels map to several. */
  kind?: Kind;
  /** The priority a label maps to; the first in local-value order (must, should, could, wont) when labels map to several. */
  priority?: Priority;
  /** Every status a label maps to, in local-value order; {@link labelStatus} picks the one the item gets. */
  statuses: string[];
  /** The labels that are no mapped label of the connection, in the issue's order: the item's tags. */
  tags: string[];
}

/**
 * Reads an issue's labels through the mapping of the connection it comes from: a label that is a mapped kind, priority
 * or status label (not a status mapped to a state) names that local value and is not a tag; the other labels are the
 * tags. A remote value several local values share names the first of them in local-value order (the README's table).
 * Without a mapping (an import from a repository with no connection) every label is a tag.
 */
export function translateLabels(labels: readonly string[], mapping: LabelMapping | undefined): MappedIssueLabels {
  if (!mapping) return { statuses: [], tags: [...labels] };
  const present = new Set(labels);
  const mapped = new Set<string>();
  const named = (dimension: MappingDimension): string[] =>
    MAPPING_LOCAL_VALUES[dimension].filter((local) => {
      const remote = mapping[dimension][local] ?? null;
      if (remote === null || !isMappedLabel(dimension, remote) || !present.has(remote)) return false;
      mapped.add(remote);
      return true;
    });
  const [kind] = named('kind') as Kind[];
  const [priority] = named('priority') as Priority[];
  const statuses = named('status');
  return { ...(kind ? { kind } : {}), ...(priority ? { priority } : {}), statuses, tags: labels.filter((label) => !mapped.has(label)) };
}

/**
 * The status mapped labels give an item of `kind` whose issue is in `state`: the first of `statuses` (local-value order)
 * that `kind` has and that agrees with the state (a closed issue: delivered and closed statuses; an open issue: the
 * others). Undefined when none does: the state alone decides ({@link closedStatus}, {@link openStatus}).
 */
export function labelStatus(kind: Kind, state: 'open' | 'closed', statuses: readonly string[]): string | undefined {
  const closed = state === 'closed';
  return statuses.find(
    (status) => STATUSES[kind].includes(status) && (DELIVERED_STATUSES[kind].includes(status) || CLOSED_STATUSES[kind].includes(status)) === closed,
  );
}

/** The warning for mapped labels naming another kind than an existing item's, which never changes. */
export function kindLabelWarning(id: string, kind: Kind, labels: MappedIssueLabels): string | null {
  return labels.kind && labels.kind !== kind ? `${id}: its issue's labels map to kind ${labels.kind}; it stays a ${kind} (an item's kind never changes).` : null;
}

function remoteTime(value: string | null | undefined, fallback: string): string {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? fallback : nowIso(new Date(time));
}

/** The raw GitHub/GitLab MCP responses the payload adapters map. */
export const RAW_PAYLOAD_FORMATS =
  'a GitHub MCP list_issues response ({"issues": [...]}) or array of GitHub issues, or a GitLab MCP list_issues response (an array of REST issues), list_work_items response ({"items": [...], "pageInfo": {...}}), get_work_item response or array of work items';

const PAYLOAD_FORMATS = `ImportItems ([...] or {"items": [...]}), ${RAW_PAYLOAD_FORMATS}`;

/** A string, or the `key` string of an object (GitHub REST labels `{name}`, GitLab milestones `{title}`, …). */
const named = (key: string) => z.union([z.string(), z.object({ [key]: z.string() }).transform((value) => value[key]!)]);

/**
 * Issues of the GitHub MCP server (github/github-mcp-server): list_issues' MinimalIssue (pkg/github/minimal_types.go:
 * state OPEN/CLOSED, labels and assignees as strings) or REST issues as its older list_issues returned them
 * (labels `{name}`, assignees `{login}`, milestone `{title}`, type `{name}`, `pull_request` on pull requests).
 */
const githubIssueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullish(),
  state: z.string(),
  // MinimalIssue and REST issues spell it state_reason (not_planned), the GraphQL Issue stateReason (NOT_PLANNED).
  state_reason: z.string().nullish(),
  stateReason: z.string().nullish(),
  html_url: z.string().nullish(),
  pull_request: z.unknown().optional(),
  issue_type: z.string().nullish(),
  type: named('name').nullish(),
  labels: z.array(named('name')).nullish(),
  assignees: z.array(named('login')).nullish(),
  milestone: named('title').nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  parent: z.object({ number: z.number().int(), repository: z.string().nullish() }).nullish(),
});

/**
 * GitLab issues of zereight/gitlab-mcp: list_issues / get_issue return GitLab REST v4 issues (index.ts listIssues,
 * schemas.ts GitLabIssueSchema: `id`, `iid` and `project_id` as strings, `description` null when empty, `state`
 * opened/closed, `labels` as strings or `{name}`, `assignees` `{username}`, `milestone` `{title}`, `issue_type`,
 * `web_url`, `references.full`); list_work_items / get_work_item return work items (index.ts listWorkItems,
 * getWorkItem): widgets flattened to `type`, `labels` `{title}`, `assignees`, `milestone` and the hierarchy widget's
 * `parent {iid, project, webUrl}`; list_work_items has no `description` (nor `id`).
 */
const gitlabIssueSchema = z.object({
  iid: z.union([z.string(), z.number().int()]),
  id: z.union([z.string(), z.number()]).nullish(),
  title: z.string(),
  state: z.string(),
  description: z.string().nullish(),
  type: named('name').nullish(),
  issue_type: z.string().nullish(),
  webUrl: z.string().nullish(),
  web_url: z.string().nullish(),
  references: z.object({ full: z.string().nullish() }).nullish(),
  labels: z.array(z.union([named('title'), named('name')])).nullish(),
  // gitlab-mcp's GitLabUserSchema leaves username optional: a user without one is left out.
  assignees: z.array(z.union([z.string(), z.object({ username: z.string().nullish() }).transform((user) => user.username ?? null)])).nullish(),
  milestone: named('title').nullish(),
  createdAt: z.string().nullish(),
  created_at: z.string().nullish(),
  updatedAt: z.string().nullish(),
  updated_at: z.string().nullish(),
  parent: z.object({ iid: z.union([z.string(), z.number().int()]), project: z.string().nullish(), webUrl: z.string().nullish() }).nullish(),
});

const GITHUB_TYPES: Readonly<Record<string, Kind>> = { bug: 'bug', feature: 'story', task: 'task' };
const GITLAB_TYPES: Readonly<Record<string, Kind>> = { epic: 'epic', task: 'task', incident: 'bug', requirement: 'requirement' };

/** GitHub OPEN/open and GitLab opened/OPEN → open, CLOSED/closed → closed; other states fail ImportItem validation. */
function remoteState(state: string): string {
  const lower = state.toLowerCase();
  return lower === 'opened' ? 'open' : lower;
}

/** `group/project` of a GitLab URL (`…/group/project/-/work_items/7`, `…/groups/group/-/epics/2`), else `fallback`. */
function gitlabPath(url: string | null | undefined, fallback: string): string {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url ?? '').pathname);
  } catch {
    return fallback;
  }
  const end = path.indexOf('/-/');
  if (end <= 0) return fallback;
  const namespace = path.slice(1, end).replace(/^groups\//, '');
  // A GitLab served under a relative URL root (https://host/gitlab/group/project) still maps to the given path.
  return namespace.endsWith(`/${fallback}`) ? fallback : namespace;
}

export interface MappedPayload {
  /** ImportItem candidates; validated by importItems like `items`. */
  items: Record<string, unknown>[];
  /** One entry per skipped pull request. */
  warnings: string[];
}

function fromGithub(issues: readonly z.infer<typeof githubIssueSchema>[], repo: string): MappedPayload {
  const mapped: MappedPayload = { items: [], warnings: [] };
  for (const issue of issues) {
    const externalId = `${repo}#${issue.number}`;
    const url = issue.html_url ?? `https://github.com/${repo}/issues/${issue.number}`;
    if ((issue.pull_request !== undefined && issue.pull_request !== null) || /\/pull\/\d+$/.test(url)) {
      mapped.warnings.push(`${externalId}: pull request skipped.`);
      continue;
    }
    const typeHint = GITHUB_TYPES[(issue.issue_type ?? issue.type ?? '').toLowerCase()];
    const stateReason = issue.state_reason ?? issue.stateReason;
    mapped.items.push({
      external_id: externalId,
      url,
      title: issue.title,
      body: issue.body ?? null,
      state: remoteState(issue.state),
      ...(stateReason ? { state_reason: stateReason.toLowerCase() } : {}),
      labels: issue.labels ?? [],
      ...(typeHint ? { type_hint: typeHint } : {}),
      assignees: issue.assignees ?? [],
      milestone: issue.milestone ?? null,
      created_at: issue.created_at ?? null,
      updated_at: issue.updated_at ?? null,
      parent_external_id: issue.parent ? `${issue.parent.repository ?? repo}#${issue.parent.number}` : null,
    });
  }
  return mapped;
}

function fromGitlab(issues: readonly z.infer<typeof gitlabIssueSchema>[], repo: string): MappedPayload {
  const items = issues.map((issue) => {
    const url = issue.webUrl ?? issue.web_url ?? '';
    // REST issues name their project in references.full (`group/project#11`); work items only in their URL.
    const path = /^(.+)#\d+$/.exec(issue.references?.full ?? '')?.[1] ?? gitlabPath(url, repo);
    const typeHint = GITLAB_TYPES[(issue.type ?? issue.issue_type ?? '').toLowerCase()];
    const parent = issue.parent;
    return {
      external_id: `${path}#${issue.iid}`,
      url,
      title: issue.title,
      // list_work_items items have no description (nor id): omit body so a re-import keeps the stored one.
      // REST issues and get_work_item (with id) leave out or null an empty description.
      ...(issue.id === undefined || issue.id === null ? {} : { body: issue.description ?? '' }),
      state: remoteState(issue.state),
      labels: issue.labels ?? [],
      ...(typeHint ? { type_hint: typeHint } : {}),
      assignees: (issue.assignees ?? []).filter((username) => username !== null),
      milestone: issue.milestone ?? null,
      created_at: issue.createdAt ?? issue.created_at ?? null,
      updated_at: issue.updatedAt ?? issue.updated_at ?? null,
      parent_external_id: parent ? `${parent.project ?? gitlabPath(parent.webUrl, path)}#${parent.iid}` : null,
    };
  });
  return { items, warnings: [] };
}

/**
 * Maps a raw GitHub/GitLab MCP response (object or JSON text) to ImportItem candidates; INVALID_INPUT naming `formats`
 * (the accepted formats) otherwise, or naming both hosts when the response comes from the host other than `source`.
 */
export function mapImportPayload(payload: unknown, source: ImportSource, repo: string, formats = PAYLOAD_FORMATS): MappedPayload {
  let data = payload;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      throw new OverseerError('INVALID_INPUT', `payload is text but not JSON; accepted formats: ${formats}.`);
    }
  }
  let entries: unknown[] = [data];
  let container: ImportSource | undefined;
  if (Array.isArray(data)) entries = data;
  else if (typeof data === 'object' && data !== null && 'issues' in data && Array.isArray(data.issues)) [entries, container] = [data.issues, 'github'];
  else if (typeof data === 'object' && data !== null && 'items' in data && Array.isArray(data.items)) [entries, container] = [data.items, 'gitlab'];

  const github = container === 'gitlab' ? undefined : z.array(githubIssueSchema).safeParse(entries).data;
  const gitlab = github || container === 'github' ? undefined : z.array(gitlabIssueSchema).safeParse(entries).data;
  const format: ImportSource | undefined = entries.length === 0 ? (container ?? source) : github ? 'github' : gitlab ? 'gitlab' : undefined;
  if (format === undefined) throw new OverseerError('INVALID_INPUT', `Unrecognized import format; accepted formats: ${formats}.`);
  if (format !== source) {
    throw new OverseerError('INVALID_INPUT', `The payload is a ${format === 'github' ? 'GitHub' : 'GitLab'} response but source is ${source}.`);
  }
  return format === 'github' ? fromGithub(github ?? [], repo) : fromGitlab(gitlab ?? [], repo);
}

/**
 * `import_items` arguments for a parsed `overseer import` file: ImportItems (`[...]` or `{"items": [...]}`) go to
 * `items` exactly as before; anything else (a raw GitHub/GitLab MCP response) goes to `payload`. An unknown format
 * fails here, before the CLI opens (or creates) the project database.
 */
export function importRequestFor(data: unknown, source: string, repo: string): Record<string, unknown> {
  const object = typeof data === 'object' && data !== null && !Array.isArray(data) ? data : undefined;
  // Deleted issues sit next to the issues: {"items": [...], "deleted": [...]}, {"issues": [...], "deleted": [...]} or alone.
  const deleted = object && 'deleted' in object ? { deleted: object.deleted } : {};
  let items: unknown;
  if (Array.isArray(data)) items = data;
  // list_work_items answers {"items": [...], "pageInfo": {...}}: a raw payload, not wrapped ImportItems.
  else if (object && 'items' in object && !('pageInfo' in object)) items = object.items;
  else if (object && 'deleted' in object && !('issues' in object) && !('items' in object)) items = [];
  const raw =
    items === undefined ||
    (Array.isArray(items) && items.length > 0 && !items.some((entry) => typeof entry === 'object' && entry !== null && 'external_id' in entry));
  if (!raw) return { source, repo, items, ...deleted };
  const known = IMPORT_SOURCES.find((candidate) => candidate === source);
  if (known) mapImportPayload(data, known, repo);
  return { source, repo, payload: data, ...deleted };
}

/**
 * Validates `import_items` arguments, mapping `payload` to items; exactly one of `items` and `payload` is allowed.
 * `items` holds 1 to 100 entries, or none when `deleted` lists removed issues.
 */
function parseImportRequest(raw: unknown): { input: ImportInput; warnings: string[] } {
  const { source, repo, items, payload, deleted } = parseInput(importRequestSchema, raw);
  if ((items === undefined) === (payload === undefined)) {
    throw new OverseerError('INVALID_INPUT', 'Pass exactly one of items (ImportItems) or payload (a raw GitHub/GitLab MCP response).');
  }
  if (items !== undefined) {
    if (items.length === 0 && !deleted?.length) throw new OverseerError('INVALID_INPUT', 'items: pass 1 to 100 ImportItems, or none with deleted.');
    return { input: { source, repo, items, deleted }, warnings: [] };
  }
  const mapped = mapImportPayload(payload, source, repo);
  return { input: parseInput(importInputSchema, { source, repo, items: mapped.items, deleted }), warnings: mapped.warnings };
}

/** Issue fields a sync compares, in output order: the remote ref's last synced snapshot holds these. */
export const SYNCED_FIELDS = ['title', 'body', 'labels', 'state', 'assignee', 'milestone'] as const;
export type SyncedField = (typeof SYNCED_FIELDS)[number];

/** An issue's synced fields: labels sorted without repeats, `body` "" when the issue has none, the first assignee. */
export interface IssueFields {
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  assignee: string | null;
  milestone: string | null;
}

/** A remote ref's `synced_fields`: the issue's fields as of its last sync; a field missing here is unknown. */
export type SyncedFields = Partial<IssueFields>;

/** Labels as a sync compares them: sorted by code unit, without repeats. */
export function canonicalLabels(labels: readonly string[]): string[] {
  return [...new Set(labels)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The synced fields of an imported issue; `body` is left out when the listing has none (GitLab list_work_items). */
export function issueFieldsOf(remote: ImportItem): Omit<IssueFields, 'body'> & { body?: string } {
  return {
    title: remote.title,
    ...(remote.body === undefined ? {} : { body: remote.body ?? '' }),
    labels: canonicalLabels(remote.labels ?? []),
    state: remote.state,
    assignee: remote.assignees?.[0] ?? null,
    milestone: remote.milestone ?? null,
  };
}

/**
 * Gives each imported item its remote ref in the import's connection: the issue's external_id, URL, state, the import
 * time and the snapshot of its synced fields (a field the listing lacks keeps its earlier snapshot value). An issue
 * already linked to another item there keeps that link, with a warning.
 */
export function writeRemoteRefs(db: Database, connectionId: number, synced: readonly { id: string; remote: ImportItem }[], now: string, warnings: string[]): void {
  const holder = db.prepare('SELECT item_id FROM item_remote_refs WHERE connection_id = ? AND external_ref = ? AND item_id <> ?');
  const previous = db.prepare('SELECT synced_fields FROM item_remote_refs WHERE item_id = ? AND connection_id = ?');
  const upsert = db.prepare(
    `INSERT INTO item_remote_refs(item_id, connection_id, external_ref, url, state, synced_at, synced_fields) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id, connection_id) DO UPDATE SET
       external_ref = excluded.external_ref, url = excluded.url, state = excluded.state, synced_at = excluded.synced_at,
       synced_fields = excluded.synced_fields`,
  );
  for (const { id, remote } of synced) {
    const other = holder.get(connectionId, remote.external_id, id);
    if (other) {
      warnings.push(`${id}: ${remote.external_id} is already linked to ${String(other.item_id)} in connection ${connectionId}; remote ref not written.`);
      continue;
    }
    const earlier = previous.get(id, connectionId) as { synced_fields: string } | undefined;
    const merged: SyncedFields = { ...(earlier ? (JSON.parse(earlier.synced_fields) as SyncedFields) : {}), ...issueFieldsOf(remote) };
    const snapshot = Object.fromEntries(SYNCED_FIELDS.filter((field) => field in merged).map((field) => [field, merged[field]]));
    upsert.run(id, connectionId, remote.external_id, remote.url, remote.state, now, JSON.stringify(snapshot));
  }
}

/** The item of an issue and how it was found: through the remote ref of `connectionId`, else its external_ref. */
export interface IssueItemMatch {
  id: string;
  /** True when found through the connection's remote ref while the item's external_ref names another issue. */
  viaRemoteRef: boolean;
}

/**
 * Finds the item of an issue (import, sync start, deleted list): with `connectionId`, first the item whose remote ref
 * on that connection is the issue, then the item whose external_ref is `<source>:<external_id>`. An item pushed to
 * another repository first keeps that external_ref, so its issue here is known only through the remote ref.
 */
export function findIssueItem(db: Database, connectionId: number | undefined, externalRef: string, externalId: string): IssueItemMatch | undefined {
  if (connectionId !== undefined) {
    const ref = db
      .prepare('SELECT r.item_id, i.external_ref FROM item_remote_refs r JOIN items i ON i.id = r.item_id WHERE r.connection_id = ? AND r.external_ref = ?')
      .get(connectionId, externalId);
    if (ref) return { id: String(ref.item_id), viaRemoteRef: ref.external_ref !== externalRef };
  }
  const row = db.prepare('SELECT id FROM items WHERE external_ref = ?').get(externalRef);
  return row ? { id: String(row.id), viaRemoteRef: false } : undefined;
}

/**
 * Deletes the item of each issue in `deleted` (service.deleteItem: tombstone and delete event), children before their
 * parents so a deleted subtree goes at once. An item that still has children, an issue also in `items` and an issue
 * without an item are left alone with a warning.
 */
function deleteRemoved(
  service: OverseerService,
  deleted: readonly string[],
  upserted: ReadonlySet<string>,
  refOf: (externalId: string) => string,
  connectionId: number | undefined,
  ctx: Ctx,
  result: ImportResult,
): void {
  const db = service.db;
  let pending: { externalId: string; id: string }[] = [];
  for (const externalId of new Set(deleted)) {
    if (upserted.has(refOf(externalId))) {
      result.warnings.push(`${externalId}: listed in items and in deleted; not deleted.`);
      continue;
    }
    const row = findIssueItem(db, connectionId, refOf(externalId), externalId);
    if (!row) {
      result.warnings.push(`${externalId}: deleted remotely but no item has this issue; nothing deleted.`);
      continue;
    }
    pending.push({ externalId, id: String(row.id) });
  }
  const children = db.prepare('SELECT id FROM items WHERE parent_id = ? ORDER BY rid');
  for (let progress = true; progress && pending.length > 0; ) {
    progress = false;
    pending = pending.filter(({ id }) => {
      if (children.get(id)) return true;
      service.deleteItem(id, ctx);
      result.deleted.push(id);
      progress = true;
      return false;
    });
  }
  for (const { externalId, id } of pending) {
    const ids = children.all(id).map((child) => String(child.id));
    result.warnings.push(`${id}: ${externalId} was deleted remotely, but ${id} has children (${ids.join(', ')}); not deleted.`);
  }
}

/** The warning for an issue body longer than an item description holds, or null. */
export function descriptionCutWarning(id: string, remote: Pick<ImportItem, 'body' | 'url'>): string | null {
  const length = (remote.body ?? '').length;
  return length > DESCRIPTION_MAX ? `${id}: description cut to ${DESCRIPTION_MAX} of ${length} characters; full text at ${remote.url}` : null;
}

/**
 * Creates the item of an issue no item has (import, sync start and sync pull) with the issue's labels read through
 * `mapping`, the mapping of the connection it comes from ({@link translateLabels}): kind from a mapped kind label, else
 * the issue type, else the labels; priority from a mapped priority label, else `should`; status from a mapped status
 * label that agrees with the state ({@link labelStatus}), else from the state (and an in-progress label); tags are the
 * labels that are no mapped label. Then the issue's title, body, first assignee, milestone and URL, and external_ref
 * `<source>:<external_id>`. Returns the new ID; a body cut to DESCRIPTION_MAX adds a warning.
 */
export function insertImportedItem(
  service: OverseerService,
  remote: ImportItem,
  source: ImportSource,
  mapping: LabelMapping | undefined,
  ctx: Ctx,
  now: string,
  warnings: string[],
): string {
  const labels = remote.labels ?? [];
  const mapped = translateLabels(labels, mapping);
  const kind = mapped.kind ?? importKind(remote);
  const status =
    labelStatus(kind, remote.state, mapped.statuses) ?? (remote.state === 'closed' ? closedStatus(kind, source, remote.state_reason) : openStatus(kind, labels));
  const id = service.insertItem(
    {
      kind,
      title: remote.title,
      description: (remote.body ?? '').slice(0, DESCRIPTION_MAX),
      status,
      priority: mapped.priority ?? 'should',
      req_type: kind === 'requirement' ? (labels.some((label) => /nfr|non-functional|performance|security/i.test(label)) ? 'non_functional' : 'functional') : null,
      asked_by: null,
      source: remote.url,
      recorded_via: ctx.via,
      tags: mapped.tags,
      assignee: remote.assignees?.[0] ?? null,
      milestone: remote.milestone ?? null,
      external_ref: `${source}:${remote.external_id}`,
      external_url: remote.url,
      external_state: remote.state,
      external_synced_at: now,
      delivered_at: DELIVERED_STATUSES[kind].includes(status) ? now : null,
      created_at: remoteTime(remote.created_at, now),
      updated_at: now,
      status_changed_at: now,
    },
    ctx,
    [],
    'import',
  );
  const warning = descriptionCutWarning(id, remote);
  if (warning) warnings.push(warning);
  return id;
}

/**
 * Sets the parent of the item of `remote` to the item of its parent issue, both found by {@link findIssueItem} (the
 * remote ref on `connectionId`, else the `<source>:` external_ref).
 * A parent issue without an item, a parent of a kind the child cannot have, or another local parent leaves the parent
 * as it is, with a warning. Returns the child's ID when its parent was set, else null.
 */
export function linkImportedParent(
  service: OverseerService,
  source: ImportSource,
  remote: ImportItem,
  connectionId: number | undefined,
  ctx: Ctx,
  now: string,
  warnings: string[],
): string | null {
  if (!remote.parent_external_id) return null;
  const db = service.db;
  const childMatch = findIssueItem(db, connectionId, `${source}:${remote.external_id}`, remote.external_id);
  const parentMatch = findIssueItem(db, connectionId, `${source}:${remote.parent_external_id}`, remote.parent_external_id);
  const child = childMatch && db.prepare('SELECT * FROM items WHERE id = ?').get(childMatch.id);
  const parent = parentMatch && db.prepare('SELECT id, kind FROM items WHERE id = ?').get(parentMatch.id);
  if (!child) return null;
  const childId = String(child.id);
  const childKind = child.kind as Kind;
  if (!parent) {
    warnings.push(`${childId}: parent ${remote.parent_external_id} is not imported; parent left unset.`);
    return null;
  }
  const parentId = String(parent.id);
  if (!PARENT_KINDS[childKind].includes(parent.kind as Kind)) {
    warnings.push(`${childId}: a ${childKind} cannot have a ${String(parent.kind)} parent (${parentId}); parent left unset.`);
    return null;
  }
  if (child.parent_id === parentId) return null;
  if (child.parent_id !== null) {
    warnings.push(`${childId}: keeps its local parent ${String(child.parent_id)} (remote parent ${parentId} ignored).`);
    return null;
  }
  db.prepare('UPDATE items SET parent_id = ?, updated_at = ? WHERE id = ?').run(parentId, now, childId);
  service.addEvent(childId, ctx, now, 'update', 'parent_id', null, parentId);
  return childId;
}

/** Id of the connection whose repository the import comes from (same host and repository), if any. */
function importConnectionId(db: Database, source: ImportSource, repo: string): number | undefined {
  const row = db.prepare('SELECT id FROM connections WHERE host = ? AND lower(repository) = lower(?)').get(source, normalizeRepositoryPath(repo.trim()));
  return row ? Number(row.id) : undefined;
}

/** The items an issue upsert created, changed and left as they were, by ID, and its warnings. */
export type IssueUpsert = Pick<ImportResult, 'created' | 'updated' | 'unchanged' | 'warnings'>;

/**
 * Upserts issues of `source` into the board in the caller's transaction (import and sync start): an issue no item has
 * ({@link findIssueItem}: the remote ref on `connectionId`, else the `<source>:` external_ref) creates one; a known
 * issue updates its item's title, description, tags, assignee, milestone, status, URL and state. An item found
 * through a remote ref while its external_ref names another issue (pushed to another repository first) keeps its
 * external_ref, URL, state and synced time: the issue's URL, state and synced fields go to its remote ref only.
 * With `connectionId`, the labels are read through that connection's mapping
 * ({@link translateLabels}): mapped labels set the priority and, when they agree with the state, the status
 * ({@link labelStatus}) instead of becoming tags, and each item gets its remote ref there. Without a mapped status
 * label the status changes only with the open/closed state. Parents are linked after every upsert. An issue listed
 * twice uses its first entry, with a warning. Adds the item IDs and warnings to `result` and returns the
 * external_refs seen.
 */
export function upsertIssues(
  service: OverseerService,
  source: ImportSource,
  items: readonly ImportItem[],
  connectionId: number | undefined,
  importCtx: Ctx,
  now: string,
  result: IssueUpsert,
): Set<string> {
  const db = service.db;
  const mapping = connectionId === undefined ? undefined : service.mappings.get(connectionId).mapping;
  const refOf = (externalId: string) => `${source}:${externalId}`;
  /** Item of each upserted issue, for its remote ref. */
  const synced: { id: string; remote: ImportItem }[] = [];
  const seen = new Set<string>();
  for (const remote of items) {
    const externalRef = refOf(remote.external_id);
    if (seen.has(externalRef)) {
      result.warnings.push(`${remote.external_id}: listed twice in this batch; only the first entry was used.`);
      continue;
    }
    seen.add(externalRef);
    const description = (remote.body ?? '').slice(0, DESCRIPTION_MAX);
    const cutWarning = (id: string): void => {
      const warning = descriptionCutWarning(id, remote);
      if (warning) result.warnings.push(warning);
    };
    const match = findIssueItem(db, connectionId, externalRef, remote.external_id);
    if (!match) {
      const id = insertImportedItem(service, remote, source, mapping, importCtx, now, result.warnings);
      result.created.push(id);
      synced.push({ id, remote });
      continue;
    }

    const row = getRow(db, match.id)!;
    const current = toItem(row);
    const mapped = translateLabels(remote.labels ?? [], mapping);
    const kindWarning = kindLabelWarning(row.id, row.kind, mapped);
    if (kindWarning) result.warnings.push(kindWarning);
    const incoming: Partial<Item> = {
      title: remote.title,
      // A missing body keeps the stored description; an explicit "" or null clears it.
      ...(remote.body === undefined ? {} : { description }),
      tags: mapped.tags,
      ...(mapped.priority ? { priority: mapped.priority } : {}),
      assignee: remote.assignees?.[0] ?? null,
      milestone: remote.milestone ?? null,
      // The external_* columns describe the item's own external_ref; an issue found through a remote ref keeps them.
      ...(match.viaRemoteRef ? {} : { external_url: remote.url }),
    };
    const changes = (Object.keys(incoming) as (keyof Item)[]).filter(
      (field) => JSON.stringify(current[field] ?? null) !== JSON.stringify(incoming[field] ?? null),
    );
    const knownState = match.viaRemoteRef
      ? (db.prepare('SELECT state FROM item_remote_refs WHERE item_id = ? AND connection_id = ?').get(match.id, connectionId!)?.state as string | null | undefined)
      : current.external_state;
    const stateChanged = knownState !== remote.state;
    const status =
      labelStatus(row.kind, remote.state, mapped.statuses) ??
      (stateChanged ? (remote.state === 'closed' ? closedStatus(row.kind, source, remote.state_reason) : openStatus(row.kind, [])) : current.status);
    if (changes.length === 0 && !stateChanged && status === current.status) {
      if (!match.viaRemoteRef) db.prepare('UPDATE items SET external_synced_at = ? WHERE rid = ?').run(now, row.rid);
      result.unchanged.push(row.id);
      synced.push({ id: row.id, remote });
      continue;
    }
    const sets: string[] = match.viaRemoteRef ? ['updated_at = ?'] : ['external_synced_at = ?', 'updated_at = ?'];
    const params: (string | number | null)[] = match.viaRemoteRef ? [now] : [now, now];
    for (const field of changes) {
      const value = incoming[field];
      sets.push(`${field} = ?`);
      params.push(columnValue(value));
      service.addEvent(row.id, importCtx, now, 'update', field, current[field], value);
      if (field === 'description') cutWarning(row.id);
    }
    if (stateChanged && !match.viaRemoteRef) {
      sets.push('external_state = ?');
      params.push(remote.state);
    }
    if (status !== current.status) {
      sets.push('status = ?', 'status_changed_at = ?');
      params.push(status, now);
      const delivered = DELIVERED_STATUSES[row.kind].includes(status);
      if (delivered && !current.delivered_at) {
        sets.push('delivered_at = ?');
        params.push(now);
      } else if (!delivered && current.delivered_at) {
        sets.push('delivered_at = NULL');
      }
      service.addEvent(row.id, importCtx, now, 'status', 'status', current.status, status);
    }
    db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE rid = ?`).run(...params, row.rid);
    if (changes.some((field) => field === 'title' || field === 'description' || field === 'tags')) {
      writeFts(db, row.rid, toItem(getRow(db, row.id)!));
    }
    result.updated.push(row.id);
    synced.push({ id: row.id, remote });
  }

  // Parents are resolved after all upserts so a parent may appear anywhere in the batch (or a previous import).
  for (const remote of items) {
    const childId = linkImportedParent(service, source, remote, connectionId, importCtx, now, result.warnings);
    if (childId === null) continue;
    const unchangedIndex = result.unchanged.indexOf(childId);
    if (unchangedIndex >= 0) {
      result.unchanged.splice(unchangedIndex, 1);
      result.updated.push(childId);
    }
  }
  if (connectionId !== undefined) writeRemoteRefs(db, connectionId, synced, now, result.warnings);
  return seen;
}

/** Idempotent one-way upsert of GitHub/GitLab issues (S10). Imported text is stored as data only. */
export async function importItems(service: OverseerService, raw: unknown, ctx: Ctx): Promise<ImportResult> {
  const { input, warnings } = parseImportRequest(raw);
  const source: ImportSource = input.source;
  const refOf = (externalId: string) => `${source}:${externalId}`;
  const result: ImportResult = {
    created: [],
    updated: [],
    unchanged: [],
    deleted: [],
    warnings: [...warnings],
    possible_duplicates: [],
    last_import_at: '',
  };
  const now = nowIso();
  const db = service.db;
  const connectionId = importConnectionId(db, source, input.repo);
  // The imported connection already holds these changes: the outbox records them for the other connections only.
  const importCtx: Ctx = { ...ctx, via: `import:${source}`, origin_connection: connectionId };

  tx(db, () => {
    const seen = upsertIssues(service, source, input.items, connectionId, importCtx, now, result);
    deleteRemoved(service, input.deleted ?? [], seen, refOf, connectionId, importCtx, result);
    service.setMeta(`last_import:${source}:${input.repo}`, now);
  });

  for (const id of result.created) {
    const item = service.getItem(id).item;
    const similar = await service.findSimilar(`${item.title}\n${item.description}`, { excludeImported: true });
    const matches = similar.matches.filter(
      (match): match is typeof match & { similarity: number } =>
        match.similarity !== null && (match.match === 'duplicate' || match.match === 'related'),
    );
    if (matches.length > 0) {
      result.possible_duplicates.push({ id, similar_to: matches.map((match) => ({ id: match.id, similarity: match.similarity })) });
    }
  }
  result.last_import_at = now;
  return result;
}

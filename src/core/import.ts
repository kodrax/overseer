import { z } from 'zod';
import { type Database, nowIso, tx } from './db.js';
import { OverseerError } from './errors.js';
import { columnValue, getRow, toItem, writeFts } from './items.js';
import { normalizeRepositoryPath } from './remotes.js';
import { type Ctx, IMPORT_SOURCES, type ImportSource, type Item, KINDS, type Kind, PARENT_KINDS, parseInput } from './schema.js';
import type { OverseerService } from './service.js';

const DESCRIPTION_MAX = 20000;

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
      'Raw response of the GitHub MCP list_issues tool ({"issues": [...]}) or of the GitLab MCP list_work_items ({"items": [...]}) or get_work_item tool, as returned (object or JSON text); pass this or items.',
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

function openStatus(kind: Kind, labels: readonly string[]): string {
  if (kind === 'requirement') return 'approved';
  if (kind === 'epic') return 'open';
  return labels.some((label) => /in progress|doing|wip/i.test(label)) ? 'in_progress' : 'backlog';
}

/** GitHub close reasons (REST state_reason, GraphQL stateReason, any case) that cancel an item instead of finishing it. */
const CANCELLING_REASONS = ['not_planned', 'duplicate'];

/** Requirements become implemented; other kinds done, or cancelled for a GitHub issue closed as not planned or duplicate. */
function closedStatus(kind: Kind, source: ImportSource, reason: string | null | undefined): string {
  if (kind === 'requirement') return 'implemented';
  return source === 'github' && CANCELLING_REASONS.includes((reason ?? '').toLowerCase()) ? 'cancelled' : 'done';
}

function remoteTime(value: string | null | undefined, fallback: string): string {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? fallback : nowIso(new Date(time));
}

const PAYLOAD_FORMATS =
  'ImportItems ([...] or {"items": [...]}), a GitHub MCP list_issues response ({"issues": [...]}) or array of GitHub issues, or a GitLab MCP list_work_items response ({"items": [...], "pageInfo": {...}}), get_work_item response or array of work items';

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
 * Work items of zereight/gitlab-mcp list_work_items / get_work_item (index.ts listWorkItems, getWorkItem): widgets
 * flattened to `type`, `labels`, `assignees`, `milestone` and the hierarchy widget's `parent {iid, project, webUrl}`.
 */
const gitlabWorkItemSchema = z.object({
  iid: z.union([z.string(), z.number().int()]),
  id: z.union([z.string(), z.number()]).nullish(),
  title: z.string(),
  state: z.string(),
  description: z.string().nullish(),
  type: named('name').nullish(),
  webUrl: z.string().nullish(),
  web_url: z.string().nullish(),
  labels: z.array(named('title')).nullish(),
  assignees: z.array(named('username')).nullish(),
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

interface MappedPayload {
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

function fromGitlab(workItems: readonly z.infer<typeof gitlabWorkItemSchema>[], repo: string): MappedPayload {
  const items = workItems.map((workItem) => {
    const url = workItem.webUrl ?? workItem.web_url ?? '';
    const path = gitlabPath(url, repo);
    const typeHint = GITLAB_TYPES[(workItem.type ?? '').toLowerCase()];
    const parent = workItem.parent;
    return {
      external_id: `${path}#${workItem.iid}`,
      url,
      title: workItem.title,
      // list_work_items items have no description (nor id): omit body so a re-import keeps the stored one.
      // get_work_item and REST issues (with id) leave out or null an empty description.
      ...(workItem.id === undefined || workItem.id === null ? {} : { body: workItem.description ?? '' }),
      state: remoteState(workItem.state),
      labels: workItem.labels ?? [],
      ...(typeHint ? { type_hint: typeHint } : {}),
      assignees: workItem.assignees ?? [],
      milestone: workItem.milestone ?? null,
      created_at: workItem.createdAt ?? workItem.created_at ?? null,
      updated_at: workItem.updatedAt ?? workItem.updated_at ?? null,
      parent_external_id: parent ? `${parent.project ?? gitlabPath(parent.webUrl, path)}#${parent.iid}` : null,
    };
  });
  return { items, warnings: [] };
}

/** Maps a raw GitHub/GitLab MCP response (object or JSON text) to ImportItems; INVALID_INPUT naming the accepted formats otherwise. */
function mapImportPayload(payload: unknown, source: ImportSource, repo: string): MappedPayload {
  let data = payload;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      throw new OverseerError('INVALID_INPUT', `payload is text but not JSON; accepted formats: ${PAYLOAD_FORMATS}.`);
    }
  }
  let entries: unknown[] = [data];
  let container: ImportSource | undefined;
  if (Array.isArray(data)) entries = data;
  else if (typeof data === 'object' && data !== null && 'issues' in data && Array.isArray(data.issues)) [entries, container] = [data.issues, 'github'];
  else if (typeof data === 'object' && data !== null && 'items' in data && Array.isArray(data.items)) [entries, container] = [data.items, 'gitlab'];

  const github = container === 'gitlab' ? undefined : z.array(githubIssueSchema).safeParse(entries).data;
  const gitlab = github || container === 'github' ? undefined : z.array(gitlabWorkItemSchema).safeParse(entries).data;
  const format: ImportSource | undefined = entries.length === 0 ? (container ?? source) : github ? 'github' : gitlab ? 'gitlab' : undefined;
  if (format === undefined) throw new OverseerError('INVALID_INPUT', `Unrecognized import format; accepted formats: ${PAYLOAD_FORMATS}.`);
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

/**
 * Gives each imported item its remote ref in the import's connection (the issue's external_id, URL, state and the
 * import time). An issue already linked to another item there keeps that link, with a warning.
 */
function writeRemoteRefs(db: Database, connectionId: number, synced: readonly { id: string; remote: ImportItem }[], now: string, warnings: string[]): void {
  const holder = db.prepare('SELECT item_id FROM item_remote_refs WHERE connection_id = ? AND external_ref = ? AND item_id <> ?');
  const upsert = db.prepare(
    `INSERT INTO item_remote_refs(item_id, connection_id, external_ref, url, state, synced_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id, connection_id) DO UPDATE SET
       external_ref = excluded.external_ref, url = excluded.url, state = excluded.state, synced_at = excluded.synced_at`,
  );
  for (const { id, remote } of synced) {
    const other = holder.get(connectionId, remote.external_id, id);
    if (other) {
      warnings.push(`${id}: ${remote.external_id} is already linked to ${String(other.item_id)} in connection ${connectionId}; remote ref not written.`);
      continue;
    }
    upsert.run(id, connectionId, remote.external_id, remote.url, remote.state, now);
  }
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
    const row = db.prepare('SELECT id FROM items WHERE external_ref = ?').get(refOf(externalId));
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

/** Id of the connection whose repository the import comes from (same host and repository), if any. */
function importConnectionId(db: Database, source: ImportSource, repo: string): number | undefined {
  const row = db.prepare('SELECT id FROM connections WHERE host = ? AND lower(repository) = lower(?)').get(source, normalizeRepositoryPath(repo.trim()));
  return row ? Number(row.id) : undefined;
}

/** Idempotent one-way upsert of GitHub/GitLab issues (S10). Imported text is stored as data only. */
export async function importItems(service: OverseerService, raw: unknown, ctx: Ctx): Promise<ImportResult> {
  const { input, warnings } = parseImportRequest(raw);
  const source: ImportSource = input.source;
  const importCtx: Ctx = { ...ctx, via: `import:${source}` };
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
  const createdIds: string[] = [];
  const now = nowIso();
  const db = service.db;
  const connectionId = importConnectionId(db, source, input.repo);
  /** Item of each upserted issue, for its remote ref. */
  const synced: { id: string; remote: ImportItem }[] = [];

  tx(db, () => {
    const seen = new Set<string>();
    for (const remote of input.items) {
      const externalRef = refOf(remote.external_id);
      if (seen.has(externalRef)) {
        result.warnings.push(`${remote.external_id}: listed twice in this batch; only the first entry was used.`);
        continue;
      }
      seen.add(externalRef);
      const labels = remote.labels ?? [];
      const description = (remote.body ?? '').slice(0, DESCRIPTION_MAX);
      const cutWarning = (id: string): void => {
        const length = (remote.body ?? '').length;
        if (length > DESCRIPTION_MAX) result.warnings.push(`${id}: description cut to ${DESCRIPTION_MAX} of ${length} characters; full text at ${remote.url}`);
      };
      const existing = db.prepare('SELECT * FROM items WHERE external_ref = ?').get(externalRef);
      if (!existing) {
        const kind = importKind(remote);
        const status = remote.state === 'closed' ? closedStatus(kind, source, remote.state_reason) : openStatus(kind, labels);
        const createdAt = remoteTime(remote.created_at, now);
        const id = service.insertItem(
          {
            kind,
            title: remote.title,
            description,
            status,
            req_type:
              kind === 'requirement' ? (labels.some((label) => /nfr|non-functional|performance|security/i.test(label)) ? 'non_functional' : 'functional') : null,
            asked_by: null,
            source: remote.url,
            recorded_via: importCtx.via,
            tags: labels,
            assignee: remote.assignees?.[0] ?? null,
            milestone: remote.milestone ?? null,
            external_ref: externalRef,
            external_url: remote.url,
            external_state: remote.state,
            external_synced_at: now,
            delivered_at: status === 'done' || status === 'implemented' ? now : null,
            created_at: createdAt,
            updated_at: now,
            status_changed_at: now,
          },
          importCtx,
          [],
          'import',
        );
        result.created.push(id);
        cutWarning(id);
        createdIds.push(id);
        synced.push({ id, remote });
        continue;
      }

      const row = getRow(db, String(existing.id))!;
      const current = toItem(row);
      const incoming: Partial<Item> = {
        title: remote.title,
        // A missing body keeps the stored description; an explicit "" or null clears it.
        ...(remote.body === undefined ? {} : { description }),
        tags: labels,
        assignee: remote.assignees?.[0] ?? null,
        milestone: remote.milestone ?? null,
        external_url: remote.url,
      };
      const changes = (Object.keys(incoming) as (keyof Item)[]).filter(
        (field) => JSON.stringify(current[field] ?? null) !== JSON.stringify(incoming[field] ?? null),
      );
      const stateChanged = current.external_state !== remote.state;
      if (changes.length === 0 && !stateChanged) {
        db.prepare('UPDATE items SET external_synced_at = ? WHERE rid = ?').run(now, row.rid);
        result.unchanged.push(row.id);
        synced.push({ id: row.id, remote });
        continue;
      }
      const sets: string[] = ['external_synced_at = ?', 'updated_at = ?'];
      const params: (string | number | null)[] = [now, now];
      for (const field of changes) {
        const value = incoming[field];
        sets.push(`${field} = ?`);
        params.push(columnValue(value));
        service.addEvent(row.id, importCtx, now, 'update', field, current[field], value);
        if (field === 'description') cutWarning(row.id);
      }
      if (stateChanged) {
        sets.push('external_state = ?');
        params.push(remote.state);
        const status = remote.state === 'closed' ? closedStatus(row.kind, source, remote.state_reason) : openStatus(row.kind, []);
        if (status !== current.status) {
          sets.push('status = ?', 'status_changed_at = ?');
          params.push(status, now);
          const delivered = status === 'done' || status === 'implemented';
          if (delivered && !current.delivered_at) {
            sets.push('delivered_at = ?');
            params.push(now);
          } else if (!delivered && current.delivered_at) {
            sets.push('delivered_at = NULL');
          }
          service.addEvent(row.id, importCtx, now, 'status', 'status', current.status, status);
        }
      }
      db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE rid = ?`).run(...params, row.rid);
      if (changes.some((field) => field === 'title' || field === 'description' || field === 'tags')) {
        writeFts(db, row.rid, toItem(getRow(db, row.id)!));
      }
      result.updated.push(row.id);
      synced.push({ id: row.id, remote });
    }

    // Parents are resolved after all upserts so a parent may appear anywhere in the batch (or a previous import).
    for (const remote of input.items) {
      if (!remote.parent_external_id) continue;
      const child = db.prepare('SELECT * FROM items WHERE external_ref = ?').get(refOf(remote.external_id));
      const parent = db.prepare('SELECT id, kind FROM items WHERE external_ref = ?').get(refOf(remote.parent_external_id));
      if (!child) continue;
      const childId = String(child.id);
      const childKind = child.kind as Kind;
      if (!parent) {
        result.warnings.push(`${childId}: parent ${remote.parent_external_id} is not imported; parent left unset.`);
        continue;
      }
      const parentId = String(parent.id);
      if (!PARENT_KINDS[childKind].includes(parent.kind as Kind)) {
        result.warnings.push(`${childId}: a ${childKind} cannot have a ${String(parent.kind)} parent (${parentId}); parent left unset.`);
        continue;
      }
      if (child.parent_id === parentId) continue;
      if (child.parent_id !== null) {
        result.warnings.push(`${childId}: keeps its local parent ${String(child.parent_id)} (remote parent ${parentId} ignored).`);
        continue;
      }
      db.prepare('UPDATE items SET parent_id = ?, updated_at = ? WHERE id = ?').run(parentId, now, childId);
      service.addEvent(childId, importCtx, now, 'update', 'parent_id', null, parentId);
      const unchangedIndex = result.unchanged.indexOf(childId);
      if (unchangedIndex >= 0) {
        result.unchanged.splice(unchangedIndex, 1);
        result.updated.push(childId);
      }
    }
    if (connectionId !== undefined) writeRemoteRefs(db, connectionId, synced, now, result.warnings);
    deleteRemoved(service, input.deleted ?? [], seen, refOf, importCtx, result);
    service.setMeta(`last_import:${source}:${input.repo}`, now);
  });

  for (const id of createdIds) {
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

import { basename, isAbsolute, relative, resolve } from 'node:path';
import { type BatchCreateResult, type CompactBatchCreateResult, compactBatchResult, createBatch } from './batch.js';
import { Connections } from './connections.js';
import { computeCoverage, implementersByRequirement } from './coverage.js';
import { type Database, nowIso, openDatabase, tx } from './db.js';
import { type Embedder, TransformersEmbedder } from './embeddings.js';
import { OverseerError } from './errors.js';
import { allocateId, normalizeId, ORDER_BY_ID } from './ids.js';
import { allRows, columnValue, eventValue, getRow, type ItemRow, toItem, writeFts } from './items.js';
import { lintItem } from './lint.js';
import { ConnectionMappings } from './mappings.js';
import { SCHEMA_VERSION } from './migrations.js';
import { assertWritableRoot, defaultBaseBranch, isGuardedRoot } from './project.js';
import { parseIssueReference, resolveIssueReference } from './references.js';
import {
  buildReport,
  countsByKind,
  type LastImport,
  type LinkRow,
  type Report,
  type ReportDataMap,
  type ReportSnapshot,
} from './reports.js';
import {
  CLOSED_STATUSES,
  type CoverageState,
  type CreateInput,
  createInputSchema,
  type Ctx,
  DELIVERED_STATUSES,
  type EventAction,
  FIELD_KINDS,
  type Item,
  type ItemEvent,
  type ItemField,
  type ItemRef,
  type Kind,
  KINDS,
  type LinkRef,
  type LintWarning,
  PARENT_KINDS,
  type Relation,
  RELATION_RULES,
  RELATIONS,
  type ReportKind,
  type ReqType,
  STATUSES,
  type UpdateInput,
  updateInputSchema,
  parseInput,
} from './schema.js';
import { type ExportOptions, type ExportResult, exportReports } from './export.js';
import { type ImportResult, importItems } from './import.js';
import { type BatchSimilarEntry, type BatchSimilarResult, type MatchClass, type SearchResult, SemanticIndex, type SimilarMatch, type SimilarResult, type SimilarVerdict } from './search.js';
import { detectSetupCommand, SETUP_NONE } from './worktree.js';

export interface CreatedResult {
  created: true;
  item: Item;
  warnings: LintWarning[];
  similar: SimilarMatch[];
}

export interface DuplicateResult {
  created: false;
  reason: 'possible_duplicate';
  candidates: SimilarMatch[];
}

export type CreateResult = CreatedResult | DuplicateResult;

export interface UpdateResult {
  item: Item;
  changed_fields: string[];
  warnings: LintWarning[];
}

/** Requirement linked from an item by `implements` or `affects`, with its acceptance criteria. */
export interface RequirementRef extends LinkRef {
  acceptance_criteria: string[];
}

/** Duplicate-check candidate in the compact create results. */
export interface CandidateRef {
  id: string;
  title: string;
  similarity: number | null;
  match: MatchClass | null;
}

/** Agent-facing create result (MCP `create_item`, `overseer add --json`) without the full item. */
export interface CompactCreatedResult {
  created: true;
  id: string;
  title: string;
  status: string;
  verdict: SimilarVerdict;
  candidates: CandidateRef[];
  warnings: LintWarning[];
}

export interface CompactDuplicateResult {
  created: false;
  reason: 'possible_duplicate';
  verdict: 'duplicate';
  candidates: CandidateRef[];
}

export type CompactCreateResult = CompactCreatedResult | CompactDuplicateResult;

/** Agent-facing update result (MCP `update_item`, `overseer update --json`) without the full item. */
export interface CompactUpdateResult {
  id: string;
  title: string;
  status: string;
  changed_fields: string[];
  warnings: LintWarning[];
}

export interface ItemDetail {
  item: Item;
  coverage?: CoverageState;
  /** Only with `context`: the parent summary, null when the item has no parent. */
  parent?: ItemRef | null;
  /** Only with `context`: requirements this item implements or affects. */
  requirements?: RequirementRef[];
  links: { outgoing: LinkRef[]; incoming: LinkRef[] };
  children: ItemRef[];
  history?: ItemEvent[];
}

export interface ItemDetailOptions {
  history?: boolean;
  /** Adds `parent` and `requirements` (implements/affects targets with their acceptance criteria). */
  context?: boolean;
}

/** Most IDs one `getItems` call accepts. */
export const MAX_ITEM_IDS = 50;

export interface ListFilter {
  kind?: Kind;
  status?: string[];
  req_type?: ReqType;
  coverage?: CoverageState[];
  tag?: string;
  parent_id?: string;
  include_closed?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListRow {
  id: string;
  kind: Kind;
  title: string;
  status: string;
  priority: string;
  req_type?: ReqType | null;
  coverage?: CoverageState;
  in_backlog?: boolean;
  parent_id?: string;
}

export interface ListResult<T = ListRow> {
  total: number;
  items: T[];
}

export type BoardItem = Item & { implements: string[] };

export interface LinkResult {
  linked: boolean;
  src: string;
  rel: Relation;
  dst: string;
}

/** Issue a deleted item was linked to: a connection's remote ref, or the legacy `external_ref` (connection_id null). */
export interface TombstoneRef {
  connection_id: number | null;
  external_ref: string;
  url: string | null;
}

/** Result of a delete (MCP `delete_item`, `overseer delete`): the tombstone kept in place of the item. */
export interface DeleteResult {
  deleted: true;
  id: string;
  kind: Kind;
  title: string;
  external_refs: TombstoneRef[];
  deleted_at: string;
  actor: string;
}

export type CoverageVerdict = 'covered' | 'partially' | 'not_found' | 'unknown';

export interface CoverageCheck {
  semantic: boolean;
  warning?: string;
  verdict: CoverageVerdict;
  requirements: {
    id: string;
    title: string;
    status: string;
    coverage: CoverageState;
    similarity: number | null;
    implemented_by: { id: string; kind: Kind; status: string }[];
  }[];
}

export interface ProjectInfo {
  initialized: true;
  root: string;
  project_name: string;
  schema_version: number;
  vec_available: boolean;
  counts: Record<Kind, Record<string, number>>;
}

export const CONFIG_KEYS = [
  'project_name',
  'default_asked_by',
  'export_dir',
  'board_port',
  'worktree_root',
  'base_branch',
  'branch_pattern',
  'worktree_setup',
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export const DEFAULT_BRANCH_PATTERN = '{type}/{id}-{slug}';

/** Fields that feed the FTS row (and, partly, the embedding text). */
const TEXT_FIELDS: readonly string[] = ['title', 'description', 'rationale', 'acceptance_criteria', 'fit_criterion', 'tags', 'component'];

const DEFAULT_LIMIT = 50;

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function toRef(row: Pick<ItemRow, 'id' | 'kind' | 'title' | 'status'>): ItemRef {
  return { id: row.id, kind: row.kind, title: row.title, status: row.status };
}

function assertStatus(kind: Kind, status: string): void {
  if (!STATUSES[kind].includes(status)) {
    throw new OverseerError('INVALID_STATUS', `Invalid status "${status}" for ${kind}; valid: ${STATUSES[kind].join(', ')}.`);
  }
}

function assertApplicable(kind: Kind, fields: Partial<Record<string, unknown>>): void {
  for (const [field, kinds] of Object.entries(FIELD_KINDS)) {
    const value = fields[field];
    if (value !== undefined && value !== null && !kinds.includes(kind)) {
      throw new OverseerError('INVALID_INPUT', `Field "${field}" applies only to ${kinds.join('/')} items, not ${kind}.`);
    }
  }
}

/** Business logic shared by the CLI, MCP server and web board. */
export class OverseerService {
  readonly root: string;
  readonly db: Database;
  readonly vecAvailable: boolean;
  readonly semantic: SemanticIndex;
  /** The project's GitHub/GitLab repository connections. */
  readonly connections: Connections;
  /** Each connection's kind/status/priority mapping onto the repository's labels, issue types or states. */
  readonly mappings: ConnectionMappings;

  private constructor(root: string, db: Database, vecAvailable: boolean, embedder: Embedder | null) {
    this.root = root;
    this.db = db;
    this.vecAvailable = vecAvailable;
    this.semantic = new SemanticIndex(db, vecAvailable, embedder);
    this.connections = new Connections(db);
    this.mappings = new ConnectionMappings(db, this.connections);
  }

  /**
   * Opens the project database. Returns undefined when it does not exist and `create` is false, or when the
   * root is guarded (home/filesystem root) for reads; throws NO_PROJECT for writes on a guarded root.
   * `embedder`: undefined → local transformers.js model, null → FTS only.
   */
  static open(options: { root: string; create: boolean; embedder?: Embedder | null }): OverseerService | undefined {
    const root = resolve(options.root);
    if (isGuardedRoot(root)) {
      if (options.create) assertWritableRoot(root);
      return undefined;
    }
    const opened = openDatabase(root, { create: options.create });
    if (!opened) return undefined;
    const embedder = options.embedder === undefined ? new TransformersEmbedder() : options.embedder;
    return new OverseerService(root, opened.db, opened.vecAvailable, embedder);
  }

  close(): void {
    this.db.close();
  }

  // ---- meta / config ---------------------------------------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? String(row.value) : undefined;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getConfig(): Record<ConfigKey, string> {
    return Object.fromEntries(CONFIG_KEYS.map((key) => [key, this.configValue(key)])) as Record<ConfigKey, string>;
  }

  /** Settings stored in this project, leaving out the ones that still fall back to a default. */
  storedConfig(): Partial<Record<ConfigKey, string>> {
    const stored: Partial<Record<ConfigKey, string>> = {};
    for (const key of CONFIG_KEYS) {
      const value = this.getMeta(key);
      if (value !== undefined) stored[key] = value;
    }
    return stored;
  }

  /**
   * Stored value of a setting, else its default. Worktree defaults are computed on read: they follow the folder, the
   * remote and the lockfile (`worktree_setup` here is detected in the project root; `worktree start` detects it in the
   * new worktree).
   */
  configValue(key: ConfigKey): string {
    const stored = this.getMeta(key);
    if (stored !== undefined) return stored;
    switch (key) {
      case 'worktree_root':
        return `../${basename(this.root)}.worktrees`;
      case 'base_branch':
        return defaultBaseBranch(this.root);
      case 'branch_pattern':
        return DEFAULT_BRANCH_PATTERN;
      case 'worktree_setup':
        return detectSetupCommand(this.root) ?? SETUP_NONE;
      default:
        return '';
    }
  }

  setConfig(key: string, value: string): Record<ConfigKey, string> {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new OverseerError('INVALID_INPUT', `Unknown config key "${key}"; valid: ${CONFIG_KEYS.join(', ')}.`);
    }
    const trimmed = value.trim();
    if (trimmed === '') throw new OverseerError('INVALID_INPUT', `Config "${key}" must not be empty.`);
    if (key === 'board_port' && !(/^\d+$/.test(trimmed) && Number(trimmed) >= 1 && Number(trimmed) <= 65535)) {
      throw new OverseerError('INVALID_INPUT', 'board_port must be an integer between 1 and 65535.');
    }
    if (key === 'export_dir') this.resolveInside(trimmed);
    if (key === 'branch_pattern' && !trimmed.includes('{id}')) {
      throw new OverseerError('INVALID_INPUT', `branch_pattern must contain {id}, e.g. ${DEFAULT_BRANCH_PATTERN}.`);
    }
    tx(this.db, () => this.setMeta(key, trimmed));
    return this.getConfig();
  }

  /** Resolves a project-relative path, rejecting anything outside the project root. */
  resolveInside(path: string): string {
    const absolute = resolve(this.root, path);
    const rel = relative(this.root, absolute);
    if (isAbsolute(path) || rel.startsWith('..') || isAbsolute(rel)) {
      throw new OverseerError('INVALID_INPUT', `Path must stay inside the project root: ${path}`);
    }
    return absolute;
  }

  actor(ctx: Ctx): string {
    return ctx.actor || process.env.OVERSEER_ACTOR || this.getMeta('default_asked_by') || 'unknown';
  }

  info(): ProjectInfo {
    const rows = this.db.prepare('SELECT kind, status FROM items').all() as { kind: Kind; status: string }[];
    return {
      initialized: true,
      root: this.root,
      project_name: this.getMeta('project_name') ?? '',
      schema_version: Number(this.getMeta('schema_version') ?? SCHEMA_VERSION),
      vec_available: this.vecAvailable,
      counts: countsByKind(rows),
    };
  }

  /** Changes whenever another connection commits (PRAGMA data_version). */
  dataVersion(): number {
    return Number(this.db.prepare('PRAGMA data_version').get()?.data_version ?? 0);
  }

  // ---- reads -----------------------------------------------------------------------------------

  requireRow(id: string): ItemRow {
    const normalized = normalizeId(id);
    const row = getRow(this.db, normalized);
    if (!row) throw this.notFound([normalized]);
    return row;
  }

  /** NOT_FOUND naming each unknown ID; a deleted one says when it was deleted. */
  private notFound(ids: readonly string[]): OverseerError {
    const lookup = this.db.prepare('SELECT deleted_at FROM tombstones WHERE item_id = ?');
    const deletedAt = ids.map((id) => lookup.get(id)?.deleted_at);
    if (ids.length === 1) {
      return new OverseerError(
        'NOT_FOUND',
        deletedAt[0] === undefined ? `No item with id ${ids[0]}.` : `Item ${ids[0]} was deleted on ${String(deletedAt[0])}.`,
      );
    }
    const named = ids.map((id, index) => (deletedAt[index] === undefined ? id : `${id} (deleted on ${String(deletedAt[index])})`));
    return new OverseerError('NOT_FOUND', `No items with ids ${named.join(', ')}.`);
  }

  private coverageOf(row: Pick<ItemRow, 'id' | 'status' | 'in_backlog'>, implementers?: Map<string, ItemRef[]>): CoverageState {
    const work = (implementers ?? implementersByRequirement(this.db, row.id)).get(row.id) ?? [];
    return computeCoverage(row.status, row.in_backlog === 1, work);
  }

  /** Wire item; requirements carry derived `coverage`. */
  itemOf(row: ItemRow, implementers?: Map<string, ItemRef[]>): Item {
    const item = toItem(row);
    if (row.kind === 'requirement') item.coverage = this.coverageOf(row, implementers);
    return item;
  }

  /**
   * An item ID, normalized; a GitHub/GitLab issue reference (`#7`, `acme/demo#7`, `github:acme/demo#7`, an issue URL)
   * resolves to the ID of the item imported or synced from that issue (see resolveIssueReference).
   */
  private idOf(idOrReference: string): string {
    const reference = parseIssueReference(idOrReference);
    return reference ? resolveIssueReference(this.db, this.connections.list(), reference) : normalizeId(idOrReference);
  }

  /** One item by ID or issue reference. */
  getItem(id: string, options: ItemDetailOptions = {}): ItemDetail {
    return this.detailOf(this.requireRow(this.idOf(id)), options);
  }

  /**
   * Details of several items (IDs or issue references) in request order; the first reference that matches no item
   * fails as in getItem, and NOT_FOUND then names every unknown ID.
   */
  getItems(ids: readonly string[], options: ItemDetailOptions = {}): { items: ItemDetail[] } {
    if (ids.length === 0 || ids.length > MAX_ITEM_IDS) {
      throw new OverseerError('INVALID_INPUT', `ids must hold 1 to ${MAX_ITEM_IDS} item IDs; got ${ids.length}.`);
    }
    const normalized = ids.map((id) => this.idOf(id));
    const rows = normalized.map((id) => getRow(this.db, id));
    const unknown = [...new Set(normalized.filter((_, index) => !rows[index]))];
    if (unknown.length > 0) throw this.notFound(unknown);
    return { items: rows.map((row) => this.detailOf(row!, options)) };
  }

  private detailOf(row: ItemRow, options: ItemDetailOptions): ItemDetail {
    const item = this.itemOf(row);
    const outgoing = this.db
      .prepare(
        `SELECT l.rel, i.id, i.kind, i.title, i.status FROM links l JOIN items i ON i.id = l.dst WHERE l.src = ? ORDER BY l.rel, l.dst`,
      )
      .all(row.id) as unknown as LinkRef[];
    const incoming = this.db
      .prepare(
        `SELECT l.rel, i.id, i.kind, i.title, i.status FROM links l JOIN items i ON i.id = l.src WHERE l.dst = ? ORDER BY l.rel, l.src`,
      )
      .all(row.id) as unknown as LinkRef[];
    const children = (
      this.db.prepare(`SELECT id, kind, title, status FROM items WHERE parent_id = ? ORDER BY ${ORDER_BY_ID}`).all(row.id) as unknown as ItemRef[]
    ).map(toRef);
    const detail: ItemDetail = {
      item,
      ...(item.coverage ? { coverage: item.coverage } : {}),
      links: { outgoing: outgoing.map((link) => ({ rel: link.rel, ...toRef(link) })), incoming: incoming.map((link) => ({ rel: link.rel, ...toRef(link) })) },
      children,
    };
    if (options.context) {
      const parent = row.parent_id ? getRow(this.db, row.parent_id) : undefined;
      detail.parent = parent ? toRef(parent) : null;
      detail.requirements = detail.links.outgoing
        .filter((link) => (link.rel === 'implements' || link.rel === 'affects') && link.kind === 'requirement')
        .map((link) => ({ ...link, acceptance_criteria: toItem(getRow(this.db, link.id)!).acceptance_criteria }));
    }
    if (options.history) detail.history = this.history(row.id);
    return detail;
  }

  /** Events of an item plus link/unlink events of other items pointing at it, by sequence. */
  history(id: string): ItemEvent[] {
    const events = this.db
      .prepare(
        `SELECT * FROM events WHERE item_id = ?
           OR (action IN ('link', 'unlink') AND (new_value = ? OR old_value = ?))
         ORDER BY seq`,
      )
      .all(id, id, id) as unknown as ItemEvent[];
    return events.map((event) => ({ ...event }));
  }

  private filtered(filter: ListFilter): Item[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.kind) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.status && filter.status.length > 0) {
      const valid = filter.kind ? STATUSES[filter.kind] : KINDS.flatMap((kind) => STATUSES[kind]);
      for (const status of filter.status) {
        if (!valid.includes(status)) {
          throw new OverseerError('INVALID_STATUS', `Invalid status "${status}"; valid: ${[...new Set(valid)].join(', ')}.`);
        }
      }
      where.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
      params.push(...filter.status);
    }
    if (filter.req_type) {
      where.push('req_type = ?');
      params.push(filter.req_type);
    }
    if (filter.parent_id) {
      where.push('parent_id = ?');
      params.push(normalizeId(filter.parent_id));
    }
    if (filter.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(items.tags) WHERE lower(json_each.value) = lower(?))');
      params.push(filter.tag);
    }
    const rows = allRows(this.db, `${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${ORDER_BY_ID}`, params);
    const implementers = implementersByRequirement(this.db);
    let items = rows.map((row) => this.itemOf(row, implementers));
    if (!filter.include_closed && !(filter.status && filter.status.length > 0)) {
      items = items.filter((item) => !CLOSED_STATUSES[item.kind].includes(item.status));
    }
    const coverage = filter.coverage;
    if (coverage && coverage.length > 0) items = items.filter((item) => item.coverage !== undefined && coverage.includes(item.coverage));
    return items;
  }

  listItems(filter: ListFilter = {}): ListResult {
    const items = this.filtered(filter);
    const offset = filter.offset ?? 0;
    const page = items.slice(offset, offset + (filter.limit ?? DEFAULT_LIMIT));
    return {
      total: items.length,
      items: page.map((item) => {
        const row: ListRow = { id: item.id, kind: item.kind, title: item.title, status: item.status, priority: item.priority };
        if (item.kind === 'requirement') {
          row.req_type = item.req_type;
          row.coverage = item.coverage;
          row.in_backlog = item.in_backlog;
        }
        if (item.parent_id) row.parent_id = item.parent_id;
        return row;
      }),
    };
  }

  /** Full items plus the requirement IDs each one implements (board API). */
  listFullItems(filter: ListFilter = {}): ListResult<BoardItem> {
    const items = this.filtered(filter);
    const offset = filter.offset ?? 0;
    const page = items.slice(offset, offset + (filter.limit ?? DEFAULT_LIMIT));
    const implementsBySrc = new Map<string, string[]>();
    for (const link of this.links()) {
      if (link.rel !== 'implements') continue;
      implementsBySrc.set(link.src, [...(implementsBySrc.get(link.src) ?? []), link.dst]);
    }
    return { total: items.length, items: page.map((item) => ({ ...item, implements: implementsBySrc.get(item.id) ?? [] })) };
  }

  links(): LinkRow[] {
    return this.db.prepare('SELECT src, rel, dst, created_at FROM links ORDER BY src, rel, dst').all() as unknown as LinkRow[];
  }

  lastImports(): LastImport[] {
    const rows = this.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'last_import:%' ORDER BY key").all() as {
      key: string;
      value: string;
    }[];
    return rows.map(({ key, value }) => {
      const [, source = '', ...repo] = key.split(':');
      return { source, repo: repo.join(':'), at: value };
    });
  }

  snapshot(): ReportSnapshot {
    const implementers = implementersByRequirement(this.db);
    return {
      projectName: this.getMeta('project_name') ?? '',
      root: this.root,
      vecAvailable: this.vecAvailable,
      items: allRows(this.db, `ORDER BY ${ORDER_BY_ID}`).map((row) => this.itemOf(row, implementers)),
      links: this.links(),
      implementers,
      lastImports: this.lastImports(),
    };
  }

  report<K extends ReportKind>(kind: K): Report<ReportDataMap[K]> {
    return buildReport(kind, this.snapshot());
  }

  // ---- semantic --------------------------------------------------------------------------------

  async findSimilar(text: string, options: { kind?: Kind; limit?: number; excludeImported?: boolean } = {}): Promise<SimilarResult> {
    const result = await this.semantic.findSimilar(text, options);
    const implementers = implementersByRequirement(this.db);
    for (const match of result.matches) {
      if (match.kind === 'requirement') match.coverage = this.coverageOf(this.requireRow(match.id), implementers);
    }
    return result;
  }

  async search(query: string, options: { kind?: Kind; limit?: number } = {}): Promise<SearchResult> {
    return this.semantic.search(query, options);
  }

  async checkCoverage(text: string, options: { limit?: number } = {}): Promise<CoverageCheck> {
    const similar = await this.semantic.findSimilar(text, { kind: 'requirement', limit: options.limit ?? 5 });
    const implementers = implementersByRequirement(this.db);
    const requirements = similar.matches.map((match) => ({
      id: match.id,
      title: match.title,
      status: match.status,
      coverage: this.coverageOf(this.requireRow(match.id), implementers),
      similarity: match.similarity,
      implemented_by: (implementers.get(match.id) ?? []).map(({ id, kind, status }) => ({ id, kind, status })),
    }));
    const best = similar.matches[0]?.match;
    const verdict: CoverageVerdict = !similar.semantic
      ? 'unknown'
      : best === 'duplicate'
        ? 'covered'
        : best === 'related'
          ? 'partially'
          : 'not_found';
    return { semantic: similar.semantic, ...(similar.warning ? { warning: similar.warning } : {}), verdict, requirements };
  }

  async reindex(): Promise<{ items: number; semantic: boolean; warning?: string }> {
    return this.semantic.reindex();
  }

  // ---- writes ----------------------------------------------------------------------------------

  addEvent(
    itemId: string,
    ctx: Ctx,
    at: string,
    action: EventAction,
    field: string | null = null,
    oldValue: unknown = null,
    newValue: unknown = null,
  ): void {
    this.db
      .prepare('INSERT INTO events(item_id, at, actor, via, action, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(itemId, at, this.actor(ctx), ctx.via, action, field, eventValue(oldValue), eventValue(newValue));
  }

  private assertParent(kind: Kind, parentId: string, selfId?: string): ItemRow {
    const allowed = PARENT_KINDS[kind];
    if (allowed.length === 0) throw new OverseerError('INVALID_PARENT', `A ${kind} cannot have a parent.`);
    const parent = this.requireRow(parentId);
    if (!allowed.includes(parent.kind)) {
      throw new OverseerError(
        'INVALID_PARENT',
        `A ${kind} can only have a ${allowed.join(' or ')} parent; ${parent.id} is a ${parent.kind}.`,
      );
    }
    for (let cursor: ItemRow | undefined = parent; cursor; cursor = cursor.parent_id ? getRow(this.db, cursor.parent_id) : undefined) {
      if (cursor.id === selfId) throw new OverseerError('INVALID_PARENT', `${parent.id} cannot be the parent of ${selfId}: that creates a cycle.`);
    }
    return parent;
  }

  /** INVALID_LINK unless `rel` may link `src` to `dst`; `id` names an item or a batch key reference. */
  assertLink(src: { id?: string; kind: Kind }, rel: Relation, dst: { id: string; kind: Kind }): void {
    if (!(RELATIONS as readonly string[]).includes(rel)) {
      throw new OverseerError('INVALID_LINK', `Unknown relation "${rel}"; valid: ${RELATIONS.join(', ')}.`);
    }
    if (src.id === dst.id) throw new OverseerError('INVALID_LINK', `${dst.id} cannot link to itself.`);
    const rule = RELATION_RULES[rel];
    if (!rule.src.includes(src.kind) || !rule.dst.includes(dst.kind) || (rule.same && src.kind !== dst.kind)) {
      const allowed = rule.same ? 'items of the same kind' : `${rule.src.join('/')} → ${rule.dst.join('/')}`;
      throw new OverseerError('INVALID_LINK', `"${rel}" links ${allowed}; got ${src.kind} → ${dst.kind} (${dst.id}).`);
    }
  }

  /** Inserts a link (idempotent) with its event; `implements` puts the requirement in the backlog. */
  insertLink(src: string, rel: Relation, dst: string, ctx: Ctx, at: string): boolean {
    const inserted = this.db.prepare('INSERT OR IGNORE INTO links(src, rel, dst, created_at) VALUES (?, ?, ?, ?)').run(src, rel, dst, at);
    if (inserted.changes === 0) return false;
    this.addEvent(src, ctx, at, 'link', rel, null, dst);
    if (rel === 'implements') {
      const target = getRow(this.db, dst)!;
      if (target.in_backlog === 0) {
        this.db.prepare('UPDATE items SET in_backlog = 1, updated_at = ? WHERE id = ?').run(at, dst);
        this.addEvent(dst, ctx, at, 'update', 'in_backlog', false, true);
      }
    }
    return true;
  }

  /** Full create result (web board, `--full`). */
  async createItem(raw: unknown, ctx: Ctx): Promise<CreateResult> {
    return (await this.create(raw, ctx)).result;
  }

  /** Compact create result for agents: the `find_similar` verdict of the duplicate check and its candidates, no item. */
  async createItemCompact(raw: unknown, ctx: Ctx): Promise<CompactCreateResult> {
    const { result, verdict } = await this.create(raw, ctx);
    const candidates = (result.created ? result.similar : result.candidates).map(({ id, title, similarity, match }): CandidateRef => ({ id, title, similarity, match }));
    if (!result.created) return { created: false, reason: 'possible_duplicate', verdict: 'duplicate', candidates };
    const { item, warnings } = result;
    return { created: true, id: item.id, title: item.title, status: item.status, verdict, candidates, warnings };
  }

  /** Batch create (`items`), full results: `{created:true, items:[{key, item, warnings, similar}]}`. */
  async createBatch(raw: unknown, ctx: Ctx): Promise<BatchCreateResult> {
    return (await createBatch(this, raw, ctx)).result;
  }

  /** Batch create (`items`), compact results: `{created:true, items:[{key, id, title, status, verdict, candidates, warnings}]}`. */
  async createBatchCompact(raw: unknown, ctx: Ctx): Promise<CompactBatchCreateResult> {
    return compactBatchResult(await createBatch(this, raw, ctx));
  }

  /** `findSimilarBatch` of the semantic index, with requirement coverage on the stored matches. */
  async findSimilarBatch(entries: readonly BatchSimilarEntry[]): Promise<BatchSimilarResult[]> {
    const results = await this.semantic.findSimilarBatch(entries);
    const implementers = implementersByRequirement(this.db);
    for (const match of results.flatMap((result) => result.board.matches)) {
      if (match.kind === 'requirement') match.coverage = this.coverageOf(this.requireRow(match.id), implementers);
    }
    return results;
  }

  /** Kind rules of a parsed create input (kind-specific fields, req_type, status); returns the status to store. */
  checkCreate(input: CreateInput): string {
    const { kind } = input;
    assertApplicable(kind, input);
    if (kind === 'requirement' && !input.req_type) {
      throw new OverseerError('INVALID_INPUT', 'req_type is required for requirements (functional | non_functional).');
    }
    const status = input.status ?? STATUSES[kind][0]!;
    assertStatus(kind, status);
    return status;
  }

  /** Column values of a new item from a checked create input (S4 defaults). */
  createValues(input: CreateInput, status: string, parentId: string | null, ctx: Ctx, now: string): Record<string, unknown> {
    const { kind } = input;
    return {
      kind,
      title: input.title,
      description: input.description ?? '',
      status,
      priority: input.priority ?? 'should',
      req_type: input.req_type ?? null,
      nfr_category: input.nfr_category ?? null,
      rationale: input.rationale ?? null,
      acceptance_criteria: input.acceptance_criteria ?? [],
      fit_criterion: input.fit_criterion ?? null,
      verification_method: input.verification_method ?? null,
      asked_by: input.asked_by === undefined ? (this.getMeta('default_asked_by') ?? null) : input.asked_by,
      source: input.source ?? null,
      recorded_via: ctx.via,
      in_backlog: input.in_backlog ?? false,
      parent_id: parentId,
      assignee: input.assignee ?? null,
      estimate: input.estimate ?? null,
      milestone: input.milestone ?? null,
      severity: input.severity ?? null,
      bug_details: input.bug_details ?? null,
      component: input.component ?? null,
      tags: input.tags ?? [],
      code_refs: input.code_refs ?? [],
      delivered_at: DELIVERED_STATUSES[kind].includes(status) ? now : null,
      delivered_in: input.delivered_in ?? null,
      created_at: now,
      updated_at: now,
      status_changed_at: now,
    };
  }

  private async create(raw: unknown, ctx: Ctx): Promise<{ result: CreateResult; verdict: SimilarVerdict }> {
    const input: CreateInput = parseInput(createInputSchema, raw);
    const { kind } = input;
    const status = this.checkCreate(input);
    const parentId = input.parent_id ? this.assertParent(kind, normalizeId(input.parent_id)).id : null;
    const links = (input.links ?? []).map(({ rel, to }) => {
      const dst = this.requireRow(to);
      this.assertLink({ kind }, rel, dst);
      return { rel, dst: dst.id };
    });

    const similar = await this.findSimilar(`${input.title}\n${input.description ?? ''}`, { kind });
    const candidates = similar.matches.filter((match) => match.match === 'duplicate' || match.match === 'related');
    if (!input.allow_duplicate && similar.matches.some((match) => match.match === 'duplicate')) {
      return { result: { created: false, reason: 'possible_duplicate', candidates }, verdict: 'duplicate' };
    }

    const id = this.insertItem(this.createValues(input, status, parentId, ctx, nowIso()), ctx, links, 'create');
    const item = this.itemOf(this.requireRow(id));
    return {
      result: {
        created: true,
        item,
        warnings: lintItem(item),
        similar: similar.semantic ? candidates : similar.matches,
      },
      verdict: similar.verdict,
    };
  }

  /**
   * Inserts a fully validated item row with its FTS row, creation event and outgoing links.
   * Returns the ID: `preset` when the caller allocated it in its transaction, else a newly allocated one.
   * Callers validate beforehand; this never partially writes.
   */
  insertItem(
    values: Record<string, unknown>,
    ctx: Ctx,
    links: { rel: Relation; dst: string }[],
    action: 'create' | 'import',
    preset?: string,
  ): string {
    return tx(this.db, () => {
      const kind = values.kind as Kind;
      const id = preset ?? allocateId(this.db, kind);
      const columns = ['id', ...Object.keys(values)];
      const result = this.db
        .prepare(`INSERT INTO items(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(id, ...Object.values(values).map(columnValue));
      const rid = Number(result.lastInsertRowid);
      writeFts(this.db, rid, toItem(getRow(this.db, id)!));
      const at = String(values.created_at);
      this.addEvent(id, ctx, at, action, null, null, action === 'import' ? values.external_ref : values.title);
      for (const link of links) this.insertLink(id, link.rel, link.dst, ctx, at);
      return id;
    });
  }

  async updateItem(raw: unknown, ctx: Ctx): Promise<UpdateResult> {
    if (raw && typeof raw === 'object' && 'kind' in raw) {
      throw new OverseerError('INVALID_INPUT', '"kind" is immutable; create a new item instead.');
    }
    const input: UpdateInput = parseInput(updateInputSchema, raw);
    const row = this.requireRow(input.id);
    const current = toItem(row);
    const { id: _id, status, comment, ...fields } = input;
    assertApplicable(current.kind, fields);
    if (fields.parent_id) fields.parent_id = this.assertParent(current.kind, normalizeId(fields.parent_id), row.id).id;
    if (status !== undefined) assertStatus(current.kind, status);

    const changes = (Object.entries(fields) as [ItemField, unknown][]).filter(
      ([field, value]) => value !== undefined && !sameValue(current[field], value),
    );
    const statusChanged = status !== undefined && status !== current.status;
    if (changes.length > 0 || statusChanged || comment) {
      tx(this.db, () => {
        const now = nowIso();
        const sets: string[] = [];
        const params: (string | number | null)[] = [];
        for (const [field, value] of changes) {
          sets.push(`${field} = ?`);
          params.push(columnValue(value));
          this.addEvent(row.id, ctx, now, 'update', field, current[field], value);
        }
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
          this.addEvent(row.id, ctx, now, 'status', 'status', current.status, status);
        }
        if (sets.length > 0) {
          sets.push('updated_at = ?');
          params.push(now);
          this.db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...params, row.id);
        }
        if (changes.some(([field]) => TEXT_FIELDS.includes(field))) writeFts(this.db, row.rid, toItem(getRow(this.db, row.id)!));
        if (comment) this.addEvent(row.id, ctx, now, 'comment', null, null, comment);
      });
    }
    const item = this.itemOf(this.requireRow(row.id));
    return {
      item,
      changed_fields: [...changes.map(([field]) => field), ...(statusChanged ? ['status'] : [])],
      warnings: lintItem(item),
    };
  }

  /** Compact update result for agents: no item. */
  async updateItemCompact(raw: unknown, ctx: Ctx): Promise<CompactUpdateResult> {
    const { item, changed_fields, warnings } = await this.updateItem(raw, ctx);
    return { id: item.id, title: item.title, status: item.status, changed_fields, warnings };
  }

  link(src: string, rel: Relation, dst: string, ctx: Ctx, remove = false): LinkResult {
    const from = this.requireRow(src);
    const to = this.requireRow(dst);
    if (remove) {
      tx(this.db, () => {
        const result = this.db.prepare('DELETE FROM links WHERE src = ? AND rel = ? AND dst = ?').run(from.id, rel, to.id);
        if (result.changes > 0) this.addEvent(from.id, ctx, nowIso(), 'unlink', rel, to.id, null);
      });
      return { linked: false, src: from.id, rel, dst: to.id };
    }
    this.assertLink(from, rel, to);
    tx(this.db, () => this.insertLink(from.id, rel, to.id, ctx, nowIso()));
    return { linked: true, src: from.id, rel, dst: to.id };
  }

  /**
   * Deletes an item without children in one transaction: its links (both directions, each with an unlink event), its
   * embeddings, vectors and search-index row, and its remote refs (cascade). A tombstone keeps the ID, kind, title,
   * remote refs, time and actor, and a delete event joins the history. IDs come from monotonic counters: never reused.
   */
  deleteItem(id: string, ctx: Ctx): DeleteResult {
    return tx(this.db, () => {
      const row = this.requireRow(id);
      const children = this.db
        .prepare(`SELECT id, kind, title, status FROM items WHERE parent_id = ? ORDER BY ${ORDER_BY_ID}`)
        .all(row.id) as unknown as ItemRef[];
      if (children.length > 0) {
        throw new OverseerError(
          'CONFLICT',
          `${row.id} has children: ${children.map((child) => child.id).join(', ')}. Delete them or give them another parent first; nothing was deleted.`,
          { children: children.map(toRef) },
        );
      }
      const remote = this.db
        .prepare('SELECT connection_id, external_ref, url FROM item_remote_refs WHERE item_id = ? ORDER BY connection_id')
        .all(row.id) as unknown as TombstoneRef[];
      const externalRefs: TombstoneRef[] = [
        ...(row.external_ref ? [{ connection_id: null, external_ref: row.external_ref, url: row.external_url }] : []),
        ...remote.map(({ connection_id, external_ref, url }) => ({ connection_id, external_ref, url })),
      ];
      const now = nowIso();
      const links = this.db.prepare('SELECT src, rel, dst FROM links WHERE src = ? OR dst = ? ORDER BY src, rel, dst').all(row.id, row.id) as {
        src: string;
        rel: Relation;
        dst: string;
      }[];
      this.db.prepare('DELETE FROM links WHERE src = ? OR dst = ?').run(row.id, row.id);
      for (const link of links) this.addEvent(link.src, ctx, now, 'unlink', link.rel, link.dst, null);
      this.semantic.removeItem(row.rid);
      this.db.prepare('DELETE FROM items_fts WHERE rowid = ?').run(row.rid);
      this.db.prepare('DELETE FROM items WHERE rid = ?').run(row.rid);
      const actor = this.actor(ctx);
      this.db
        .prepare('INSERT INTO tombstones(item_id, kind, title, external_refs, deleted_at, actor) VALUES (?, ?, ?, ?, ?, ?)')
        .run(row.id, row.kind, row.title, JSON.stringify(externalRefs), now, actor);
      this.addEvent(row.id, ctx, now, 'delete', null, row.title, null);
      return { deleted: true, id: row.id, kind: row.kind, title: row.title, external_refs: externalRefs, deleted_at: now, actor };
    });
  }

  // ---- export / import -------------------------------------------------------------------------

  exportReports(options: ExportOptions = {}): ExportResult {
    return exportReports(this, options);
  }

  importItems(input: unknown, ctx: Ctx): Promise<ImportResult> {
    return importItems(this, input, ctx);
  }
}

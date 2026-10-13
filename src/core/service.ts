import { isAbsolute, relative, resolve } from 'node:path';
import { computeCoverage, implementersByRequirement } from './coverage.js';
import { type Database, nowIso, openDatabase, tx } from './db.js';
import { type Embedder, TransformersEmbedder } from './embeddings.js';
import { OverseerError } from './errors.js';
import { allocateId, normalizeId, ORDER_BY_ID } from './ids.js';
import { allRows, columnValue, eventValue, getRow, type ItemRow, toItem, writeFts } from './items.js';
import { lintItem } from './lint.js';
import { SCHEMA_VERSION } from './migrations.js';
import { assertWritableRoot, isGuardedRoot } from './project.js';
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
import { type SearchResult, SemanticIndex, type SimilarMatch, type SimilarResult } from './search.js';

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

export interface ItemDetail {
  item: Item;
  coverage?: CoverageState;
  links: { outgoing: LinkRef[]; incoming: LinkRef[] };
  children: ItemRef[];
  history?: ItemEvent[];
}

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

export const CONFIG_KEYS = ['project_name', 'default_asked_by', 'export_dir', 'board_port'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

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

  private constructor(root: string, db: Database, vecAvailable: boolean, embedder: Embedder | null) {
    this.root = root;
    this.db = db;
    this.vecAvailable = vecAvailable;
    this.semantic = new SemanticIndex(db, vecAvailable, embedder);
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
    return Object.fromEntries(CONFIG_KEYS.map((key) => [key, this.getMeta(key) ?? ''])) as Record<ConfigKey, string>;
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
    if (!row) throw new OverseerError('NOT_FOUND', `No item with id ${normalized}.`);
    return row;
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

  getItem(id: string, options: { history?: boolean } = {}): ItemDetail {
    const row = this.requireRow(id);
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

  private assertLink(src: { id?: string; kind: Kind }, rel: Relation, dst: ItemRow): void {
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
  private insertLink(src: string, rel: Relation, dst: string, ctx: Ctx, at: string): boolean {
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

  async createItem(raw: unknown, ctx: Ctx): Promise<CreateResult> {
    const input: CreateInput = parseInput(createInputSchema, raw);
    const { kind } = input;
    assertApplicable(kind, input);
    if (kind === 'requirement' && !input.req_type) {
      throw new OverseerError('INVALID_INPUT', 'req_type is required for requirements (functional | non_functional).');
    }
    const status = input.status ?? STATUSES[kind][0]!;
    assertStatus(kind, status);
    const parentId = input.parent_id ? this.assertParent(kind, normalizeId(input.parent_id)).id : null;
    const links = (input.links ?? []).map(({ rel, to }) => {
      const dst = this.requireRow(to);
      this.assertLink({ kind }, rel, dst);
      return { rel, dst: dst.id };
    });

    const description = input.description ?? '';
    const similar = await this.findSimilar(`${input.title}\n${description}`, { kind });
    const candidates = similar.matches.filter((match) => match.match === 'duplicate' || match.match === 'related');
    if (!input.allow_duplicate && similar.matches.some((match) => match.match === 'duplicate')) {
      return { created: false, reason: 'possible_duplicate', candidates };
    }

    const now = nowIso();
    const values: Record<string, unknown> = {
      kind,
      title: input.title,
      description,
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
    const id = this.insertItem(values, ctx, links, 'create');
    const item = this.itemOf(this.requireRow(id));
    return {
      created: true,
      item,
      warnings: lintItem(item),
      similar: similar.semantic ? candidates : similar.matches,
    };
  }

  /**
   * Inserts a fully validated item row with its FTS row, creation event and outgoing links.
   * Returns the allocated ID. Callers validate beforehand; this never partially writes.
   */
  insertItem(
    values: Record<string, unknown>,
    ctx: Ctx,
    links: { rel: Relation; dst: string }[],
    action: 'create' | 'import',
  ): string {
    return tx(this.db, () => {
      const kind = values.kind as Kind;
      const id = allocateId(this.db, kind);
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

  // ---- export / import -------------------------------------------------------------------------

  exportReports(options: ExportOptions = {}): ExportResult {
    return exportReports(this, options);
  }

  importItems(input: unknown, ctx: Ctx): Promise<ImportResult> {
    return importItems(this, input, ctx);
  }
}

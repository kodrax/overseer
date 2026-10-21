import { createHash } from 'node:crypto';
import { type Database, tx, warnOnce } from './db.js';
import { type Centering, DEFAULT_MODEL, type Embedder, MODEL_REGISTRY, type ModelInfo } from './embeddings.js';
import { errorMessage } from './errors.js';
import { allRows, writeFts } from './items.js';
import { createVecTableSql, VEC_TABLES, type VecTable } from './migrations.js';
import type { CoverageState, ItemRef, Kind } from './schema.js';

const BATCH = 32;
const CANDIDATES = 50;
const RRF_K = 60;
const EMBED_TEXT_MAX = 2000;

export type MatchClass = 'duplicate' | 'related' | 'weak';
export type SimilarVerdict = 'duplicate' | 'related' | 'new' | 'unknown';

export interface SimilarMatch extends ItemRef {
  similarity: number | null;
  match: MatchClass | null;
  coverage?: CoverageState;
}

export interface SimilarResult {
  semantic: boolean;
  warning?: string;
  verdict: SimilarVerdict;
  matches: SimilarMatch[];
}

export interface SearchHit extends ItemRef {
  score: number;
  similarity: number | null;
  fts_rank: number | null;
}

export interface SearchResult {
  semantic: boolean;
  warning?: string;
  results: SearchHit[];
}

interface EmbedSourceRow {
  rid: number;
  kind: Kind;
  title: string;
  description: string;
  acceptance_criteria: string;
  fit_criterion: string | null;
  content_hash: string | null;
  model: string | null;
}

interface CandidateRow extends ItemRef {
  rid: number;
  external_ref: string | null;
}

interface EmbeddableItem {
  title: string;
  description: string;
  acceptance_criteria: readonly string[];
  fit_criterion: string | null;
}

/** Full text of an item: `title\ndescription\n` + AC lines (+ fit criterion), max 2000 chars, model prefix. */
function embeddingText(item: EmbeddableItem, prefix: string): string {
  let text = `${item.title}\n${item.description}\n${item.acceptance_criteria.join('\n')}`;
  if (item.fit_criterion) text += `\n${item.fit_criterion}`;
  return prefix + text.slice(0, EMBED_TEXT_MAX);
}

/**
 * Texts embedded per item, one per vec table: the full text; the title, because short queries ("password reset") score
 * far below full statements against the full-text vector; and `title\ndescription`, the duplicate-guard query shape,
 * so a reworded item matches whatever its acceptance criteria. Items score the highest similarity over the three.
 */
export function embeddingTexts(item: EmbeddableItem, prefix: string): Record<VecTable, string> {
  return {
    items_vec: embeddingText(item, prefix),
    items_title_vec: prefix + item.title.slice(0, EMBED_TEXT_MAX),
    items_statement_vec: prefix + `${item.title}\n${item.description}`.slice(0, EMBED_TEXT_MAX),
  };
}

/** FTS5 query: unicode word tokens (≥2 chars), each double-quoted, OR-joined; undefined when nothing is searchable. */
export function ftsQuery(text: string): string | undefined {
  const tokens = [...new Set(text.match(/[\p{L}\p{N}]+/gu) ?? [])].filter((token) => token.length >= 2);
  return tokens.length > 0 ? tokens.map((token) => `"${token}"`).join(' OR ') : undefined;
}

/** Running sum of the vectors stored in one vec table, kept in `meta` under `vec_sum:<table>`. */
export interface VectorSum {
  n: number;
  sum: Float64Array;
}

/** Adds (`sign` 1) or removes (`sign` -1) one stored vector. */
export function accumulate(total: VectorSum, vector: ArrayLike<number>, sign: 1 | -1): void {
  total.n += sign;
  for (let i = 0; i < total.sum.length; i++) total.sum[i]! += sign * vector[i]!;
}

/** Center of one vec table: mean of its stored vectors blended with the reference mean weighted as `prior` items. */
export function centerOf(stored: VectorSum, centering: Centering, table: VecTable): Float64Array {
  const reference = centering.reference[table];
  const weight = stored.n + centering.prior || 1;
  return Float64Array.from(stored.sum, (value, i) => (value + centering.prior * reference[i]!) / weight);
}

/** `vector − center` scaled to unit length (all zeros when they coincide). */
export function centerVector(vector: ArrayLike<number>, center: Float64Array): Float64Array {
  const out = new Float64Array(center.length);
  let norm = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] = vector[i]! - center[i]!;
    norm += out[i]! * out[i]!;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i]! /= norm;
  return out;
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** Float32 vector of a vec0 `embedding` blob. */
function vectorOf(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

const FALLBACK_INFO: ModelInfo = { dims: 384, prefix: '', duplicate: 0.92, related: 0.85 };

/** Hybrid FTS5 + sqlite-vec index over items; degrades to FTS-only when vectors are unavailable. */
export class SemanticIndex {
  private readonly db: Database;
  private readonly vecAvailable: boolean;
  private readonly embedder: Embedder | null;

  constructor(db: Database, vecAvailable: boolean, embedder: Embedder | null) {
    this.db = db;
    this.vecAvailable = vecAvailable;
    this.embedder = embedder;
  }

  get model(): string {
    return this.embedder?.model ?? DEFAULT_MODEL;
  }

  get info(): ModelInfo {
    return MODEL_REGISTRY[this.model] ?? FALLBACK_INFO;
  }

  classify(similarity: number): MatchClass {
    const { duplicate, related } = this.info;
    return similarity >= duplicate ? 'duplicate' : similarity >= related ? 'related' : 'weak';
  }

  /**
   * Embeds every item lacking a current embedding (missing row, stale hash or other model).
   * Returns a warning when semantic search is unavailable, undefined when vectors are ready.
   */
  async embedPending(): Promise<string | undefined> {
    if (!this.vecAvailable) return 'sqlite-vec is unavailable: keyword (FTS) results only.';
    if (!this.embedder) return 'No embedding model configured: keyword (FTS) results only.';
    const embedder = this.embedder;
    try {
      this.syncModel(embedder);
      this.ensureVectorSums(embedder.dims);
      const pending = this.pendingItems(embedder.model);
      for (let start = 0; start < pending.length; start += BATCH) {
        const batch = pending.slice(start, start + BATCH);
        const vectors = await embedder.embed(batch.flatMap((item) => item.texts));
        tx(this.db, () => {
          const record = this.db.prepare(
            `INSERT INTO item_embeddings(rid, content_hash, model) VALUES (?, ?, ?)
             ON CONFLICT(rid) DO UPDATE SET content_hash = excluded.content_hash, model = excluded.model`,
          );
          VEC_TABLES.forEach((table, variant) => {
            const total = this.vectorSum(table, embedder.dims);
            const previous = this.db.prepare(`SELECT embedding FROM ${table} WHERE rid = ?`);
            const remove = this.db.prepare(`DELETE FROM ${table} WHERE rid = ?`);
            const insert = this.db.prepare(`INSERT INTO ${table}(rid, kind, embedding) VALUES (?, ?, ?)`);
            batch.forEach((item, index) => {
              const old = previous.get(BigInt(item.rid)) as { embedding: Uint8Array } | undefined;
              if (old) accumulate(total, vectorOf(old.embedding), -1);
              remove.run(BigInt(item.rid));
              const vector = vectors[VEC_TABLES.length * index + variant]!;
              insert.run(BigInt(item.rid), item.kind, vector);
              accumulate(total, vector, 1);
            });
            this.writeVectorSum(table, total);
          });
          for (const item of batch) record.run(item.rid, item.hash, embedder.model);
        });
      }
      return undefined;
    } catch (error) {
      const warning = `Semantic search unavailable (${errorMessage(error)}): keyword (FTS) results only.`;
      warnOnce('embed', warning);
      return warning;
    }
  }

  /**
   * Drops a deleted item's embedding record and its vectors, taking them out of the stored running sums. Runs inside
   * the caller's transaction. Without sqlite-vec the vec tables are unreadable; a later item reusing the rid replaces
   * the leftover vectors when it is embedded.
   */
  removeItem(rid: number): void {
    this.db.prepare('DELETE FROM item_embeddings WHERE rid = ?').run(rid);
    if (!this.vecAvailable) return;
    for (const table of VEC_TABLES) {
      const old = this.db.prepare(`SELECT embedding FROM ${table} WHERE rid = ?`).get(BigInt(rid)) as { embedding: Uint8Array } | undefined;
      if (!old) continue;
      if (this.db.prepare('SELECT 1 FROM meta WHERE key = ?').get(`vec_sum:${table}`)) {
        const vector = vectorOf(old.embedding);
        const total = this.vectorSum(table, vector.length);
        accumulate(total, vector, -1);
        this.writeVectorSum(table, total);
      }
      this.db.prepare(`DELETE FROM ${table} WHERE rid = ?`).run(BigInt(rid));
    }
  }

  /** On a model change, drop all vectors (and their running sums) so every item is re-embedded with the new model. */
  private syncModel(embedder: Embedder): void {
    const current = this.db.prepare("SELECT value FROM meta WHERE key = 'embed_model'").get()?.value;
    if (current === embedder.model) return;
    tx(this.db, () => {
      for (const table of VEC_TABLES) {
        this.db.exec(`DROP TABLE IF EXISTS ${table}`);
        this.db.exec(createVecTableSql(table, embedder.dims));
      }
      this.db.exec('DELETE FROM item_embeddings');
      this.db.exec("DELETE FROM meta WHERE key LIKE 'vec_sum:%'");
      this.db
        .prepare("INSERT INTO meta(key, value) VALUES ('embed_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(embedder.model);
    });
  }

  /** Running sum of a vec table from `meta`, or rebuilt from its stored vectors when absent. */
  private vectorSum(table: VecTable, dims: number): VectorSum {
    const value = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(`vec_sum:${table}`)?.value;
    if (typeof value === 'string') {
      const stored = JSON.parse(value) as { n: number; sum: string };
      const bytes = Buffer.from(stored.sum, 'base64');
      return { n: stored.n, sum: new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) };
    }
    const total: VectorSum = { n: 0, sum: new Float64Array(dims) };
    const rows = this.db.prepare(`SELECT embedding FROM ${table}`).all() as { embedding: Uint8Array }[];
    for (const row of rows) accumulate(total, vectorOf(row.embedding), 1);
    return total;
  }

  private writeVectorSum(table: VecTable, total: VectorSum): void {
    const sum = Buffer.from(total.sum.buffer, total.sum.byteOffset, total.sum.byteLength).toString('base64');
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`vec_sum:${table}`, JSON.stringify({ n: total.n, sum }));
  }

  /** Persists the running sums of databases whose vectors were stored before the sums existed. */
  private ensureVectorSums(dims: number): void {
    const missing = VEC_TABLES.filter((table) => !this.db.prepare('SELECT 1 FROM meta WHERE key = ?').get(`vec_sum:${table}`));
    if (missing.length === 0) return;
    tx(this.db, () => {
      for (const table of missing) this.writeVectorSum(table, this.vectorSum(table, dims));
    });
  }

  private pendingItems(model: string): { rid: number; kind: Kind; texts: string[]; hash: string }[] {
    const rows = this.db
      .prepare(
        `SELECT i.rid, i.kind, i.title, i.description, i.acceptance_criteria, i.fit_criterion, e.content_hash, e.model
         FROM items i LEFT JOIN item_embeddings e ON e.rid = i.rid ORDER BY i.rid`,
      )
      .all() as unknown as EmbedSourceRow[];
    const pending: { rid: number; kind: Kind; texts: string[]; hash: string }[] = [];
    for (const row of rows) {
      const byTable = embeddingTexts({ ...row, acceptance_criteria: JSON.parse(row.acceptance_criteria) as string[] }, this.info.prefix);
      const texts = VEC_TABLES.map((table) => byTable[table]);
      const hash = createHash('sha256').update(`${model}\n${texts.join('\n\u0000')}`).digest('hex');
      if (row.content_hash !== hash || row.model !== model) pending.push({ rid: row.rid, kind: row.kind, texts, hash });
    }
    return pending;
  }

  private async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.embedder!.embed([this.info.prefix + text.slice(0, EMBED_TEXT_MAX)]);
    return vector!;
  }

  /** rid → smallest cosine distance over the vec tables (top 50 of each). */
  private knn(vector: Float32Array, kind?: Kind): Map<number, number> {
    const distances = new Map<number, number>();
    for (const table of VEC_TABLES) {
      const rows = this.db
        .prepare(`SELECT rid, distance FROM ${table} WHERE embedding MATCH ? AND k = ${CANDIDATES}${kind ? ' AND kind = ?' : ''}`)
        .all(vector, ...(kind ? [kind] : [])) as { rid: number; distance: number }[];
      for (const { rid, distance } of rows) distances.set(rid, Math.min(distance, distances.get(rid) ?? Infinity));
    }
    return distances;
  }

  /** rid → highest similarity over the vec tables after subtracting each table's center from query and item vectors. */
  private centeredSimilarities(query: Float32Array, rids: number[], centering: Centering): Map<number, number> {
    const similarities = new Map<number, number>();
    if (rids.length === 0) return similarities;
    for (const table of VEC_TABLES) {
      const center = centerOf(this.vectorSum(table, query.length), centering, table);
      const centeredQuery = centerVector(query, center);
      const rows = this.db
        .prepare(`SELECT rid, embedding FROM ${table} WHERE rid IN (${rids.map(() => '?').join(',')})`)
        .all(...rids.map(BigInt)) as { rid: number; embedding: Uint8Array }[];
      for (const row of rows) {
        const similarity = dot(centeredQuery, centerVector(vectorOf(row.embedding), center));
        similarities.set(row.rid, Math.max(similarity, similarities.get(row.rid) ?? -Infinity));
      }
    }
    return similarities;
  }

  /** rid → 1-based bm25 rank (title weighted 2×). */
  ftsRanks(text: string, kind?: Kind, limit = CANDIDATES): Map<number, number> {
    const query = ftsQuery(text);
    if (!query) return new Map();
    const rows = this.db
      .prepare(
        `SELECT items_fts.rowid AS rid FROM items_fts JOIN items ON items.rid = items_fts.rowid
         WHERE items_fts MATCH ?${kind ? ' AND items.kind = ?' : ''}
         ORDER BY bm25(items_fts, 2.0, 1.0), items_fts.rowid LIMIT ${limit}`,
      )
      .all(query, ...(kind ? [kind] : [])) as { rid: number }[];
    return new Map(rows.map((row, index) => [row.rid, index + 1]));
  }

  private candidates(rids: Iterable<number>): Map<number, CandidateRow> {
    const list = [...rids];
    if (list.length === 0) return new Map();
    const rows = this.db
      .prepare(`SELECT rid, id, kind, title, status, external_ref FROM items WHERE rid IN (${list.map(() => '?').join(',')})`)
      .all(...list) as unknown as CandidateRow[];
    return new Map(rows.map((row) => [row.rid, row]));
  }

  /**
   * Nearest items among the KNN candidates by similarity (centered cosine when the model defines `centering`, else
   * cosine); FTS hits with `similarity: null` when not semantic.
   */
  async findSimilar(
    text: string,
    options: { kind?: Kind; limit?: number; excludeImported?: boolean } = {},
  ): Promise<SimilarResult> {
    const limit = options.limit ?? 5;
    let warning = await this.embedPending();
    let similarities: Map<number, number> | undefined;
    if (!warning) {
      try {
        const query = await this.embedQuery(text);
        const distances = this.knn(query, options.kind);
        const { centering } = this.info;
        similarities = centering
          ? this.centeredSimilarities(query, [...distances.keys()], centering)
          : new Map([...distances].map(([rid, distance]) => [rid, 1 - distance]));
      } catch (error) {
        warning = `Semantic search unavailable (${errorMessage(error)}): keyword (FTS) results only.`;
        warnOnce('embed', warning);
      }
    }
    if (!similarities) {
      const ranks = this.ftsRanks(text, options.kind);
      const rows = this.candidates(ranks.keys());
      const matches = [...ranks.keys()]
        .map((rid) => rows.get(rid)!)
        .filter((row) => !(options.excludeImported && row.external_ref))
        .slice(0, limit)
        .map((row): SimilarMatch => ({ ...ref(row), similarity: null, match: null }));
      return { semantic: false, warning, verdict: 'unknown', matches };
    }
    const rows = this.candidates(similarities.keys());
    const matches = [...similarities.entries()]
      .map(([rid, similarity]) => ({ row: rows.get(rid)!, similarity: round4(similarity) }))
      .filter(({ row }) => !(options.excludeImported && row.external_ref))
      .sort((a, b) => b.similarity - a.similarity || a.row.rid - b.row.rid)
      .slice(0, limit)
      .map(({ row, similarity }): SimilarMatch => ({ ...ref(row), similarity, match: this.classify(similarity) }));
    const best = matches[0]?.match;
    const verdict: SimilarVerdict = best === 'duplicate' ? 'duplicate' : best === 'related' ? 'related' : 'new';
    return { semantic: true, verdict, matches };
  }

  /** Hybrid search: FTS top 50 (bm25) + KNN top 50 fused by reciprocal rank fusion. */
  async search(query: string, options: { kind?: Kind; limit?: number } = {}): Promise<SearchResult> {
    const limit = options.limit ?? 10;
    let warning = await this.embedPending();
    const ftsRanks = this.ftsRanks(query, options.kind);
    let distances = new Map<number, number>();
    if (!warning) {
      try {
        distances = this.knn(await this.embedQuery(query), options.kind);
      } catch (error) {
        warning = `Semantic search unavailable (${errorMessage(error)}): keyword (FTS) results only.`;
        warnOnce('embed', warning);
      }
    }
    const knnRanks = new Map(
      [...distances.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([rid], index) => [rid, index + 1]),
    );
    const scores = new Map<number, number>();
    for (const [rid, rank] of ftsRanks) scores.set(rid, (scores.get(rid) ?? 0) + 1 / (RRF_K + rank));
    for (const [rid, rank] of knnRanks) scores.set(rid, (scores.get(rid) ?? 0) + 1 / (RRF_K + rank));
    const rows = this.candidates(scores.keys());
    const results = [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, limit)
      .map(([rid, score]): SearchHit => {
        const distance = distances.get(rid);
        return {
          ...ref(rows.get(rid)!),
          score: Math.round(score * 1e6) / 1e6,
          similarity: distance === undefined ? null : round4(1 - distance),
          fts_rank: ftsRanks.get(rid) ?? null,
        };
      });
    return warning ? { semantic: false, warning, results } : { semantic: true, results };
  }

  /** Rebuilds every FTS row and re-embeds every item. */
  async reindex(): Promise<{ items: number; semantic: boolean; warning?: string }> {
    const rows = allRows(this.db);
    tx(this.db, () => {
      this.db.exec('DELETE FROM items_fts');
      for (const row of rows) {
        writeFts(this.db, row.rid, {
          ...row,
          acceptance_criteria: JSON.parse(row.acceptance_criteria) as string[],
          tags: JSON.parse(row.tags) as string[],
        });
      }
      this.db.exec('DELETE FROM item_embeddings');
      if (this.vecAvailable) for (const table of VEC_TABLES) this.db.exec(`DELETE FROM ${table}`);
      this.db.exec("DELETE FROM meta WHERE key LIKE 'vec_sum:%'");
    });
    const warning = await this.embedPending();
    return warning ? { items: rows.length, semantic: false, warning } : { items: rows.length, semantic: true };
  }
}

function ref(row: ItemRef): ItemRef {
  return { id: row.id, kind: row.kind, title: row.title, status: row.status };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

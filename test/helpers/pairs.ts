import { readFileSync } from 'node:fs';
import { type Centering, type Embedder, MODEL_REGISTRY } from '../../src/core/embeddings.js';
import { VEC_TABLES, type VecTable } from '../../src/core/migrations.js';
import { accumulate, centerOf, centerVector, dot, embeddingTexts, type VectorSum } from '../../src/core/search.js';

export type PairClass = 'duplicate' | 'related' | 'unrelated';

export interface Pair {
  class: PairClass;
  /** "Title\nStatement" */
  a: string;
  b: string;
  cross_language?: boolean;
}

export interface RegistryItem {
  id: string;
  component: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  fit_criterion: string | null;
}

export interface RegistryDuplicate {
  of: string;
  title: string;
  description: string;
  cross_language?: boolean;
}

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as T;

export const PAIRS: Pair[] = fixture<{ pairs: Pair[] }>('similarity-pairs.json').pairs;

/** This repository's requirement registry, rewordings of some of its items and the pairs BUG-0001 reported. */
export const REGISTRY = fixture<{ items: RegistryItem[]; duplicates: RegistryDuplicate[]; not_duplicates: [string, string][] }>(
  'registry-pairs.json',
);

/** Fixture pair sides as items: "Title\nStatement" without acceptance criteria. */
export const PAIR_ITEMS = PAIRS.flatMap((pair) => [pair.a, pair.b]).map((side) => {
  const [title = '', ...rest] = side.split('\n');
  return { title, description: rest.join('\n'), acceptance_criteria: [] as string[], fit_criterion: null };
});

type ItemText = Parameters<typeof embeddingTexts>[0];

export async function embedAll(embedder: Embedder, texts: string[]): Promise<Float32Array[]> {
  const vectors: Float32Array[] = [];
  for (let start = 0; start < texts.length; start += 32) vectors.push(...(await embedder.embed(texts.slice(start, start + 32))));
  return vectors;
}

/** Vectors of items as the index stores them, per vec table. */
export type StoredVectors = Record<VecTable, Float32Array[]>;

export async function storedVectors(embedder: Embedder, items: ItemText[]): Promise<StoredVectors> {
  const prefix = MODEL_REGISTRY[embedder.model]?.prefix ?? '';
  const texts = items.map((item) => embeddingTexts(item, prefix));
  const stored = {} as StoredVectors;
  for (const table of VEC_TABLES) stored[table] = await embedAll(embedder, texts.map((byTable) => byTable[table]));
  return stored;
}

/** Query vectors as the index embeds them (model prefix + text). */
export async function queryVectors(embedder: Embedder, texts: string[]): Promise<Float32Array[]> {
  const prefix = MODEL_REGISTRY[embedder.model]?.prefix ?? '';
  return embedAll(embedder, texts.map((text) => prefix + text));
}

export function vectorSum(vectors: Float32Array[]): VectorSum {
  const total: VectorSum = { n: 0, sum: new Float64Array(vectors[0]!.length) };
  for (const vector of vectors) accumulate(total, vector, 1);
  return total;
}

export type Scorer = (query: Float32Array) => (index: number) => number;

/**
 * Production similarity of a query against the item at `index` of a registry holding exactly `stored`: highest over
 * the vec tables, centered on the registry mean blended with the reference when `centering` is given.
 */
export function registryScorer(stored: StoredVectors, centering: Centering | undefined): Scorer {
  const tables = VEC_TABLES.map((table) => {
    if (!centering) return { center: undefined, vectors: stored[table] as ArrayLike<number>[] };
    const center = centerOf(vectorSum(stored[table]), centering, table);
    return { center, vectors: stored[table].map((vector) => centerVector(vector, center)) };
  });
  return (query) => {
    const queries = tables.map(({ center, vectors }) => ({ query: center ? centerVector(query, center) : query, vectors }));
    return (index) => Math.max(...queries.map(({ query: q, vectors }) => dot(q, vectors[index]!)));
  };
}

/**
 * Similarity of each fixture pair in both directions, the fixture sides forming the registry: one side stored as an
 * item, the other as the duplicate-guard query (`title\ndescription`, the side's statement vector).
 */
export async function pairSimilarities(
  embedder: Embedder,
  centering: Centering | undefined = MODEL_REGISTRY[embedder.model]?.centering,
): Promise<{ pair: Pair; similarity: number }[]> {
  const stored = await storedVectors(embedder, PAIR_ITEMS);
  const score = registryScorer(stored, centering);
  return PAIRS.flatMap((pair, index) =>
    [
      [2 * index, 2 * index + 1],
      [2 * index + 1, 2 * index],
    ].map(([item, query]) => ({ pair, similarity: score(stored.items_statement_vec[query!]!)(item!) })),
  );
}

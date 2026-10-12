import { createHash } from 'node:crypto';
import { type Embedder, MODEL_REGISTRY } from '../../src/core/embeddings.js';

export const HASH_MODEL = 'test/hash-embedder';

// Deterministic stand-in for the real model: thresholds tuned to token overlap.
MODEL_REGISTRY[HASH_MODEL] = { dims: 384, prefix: 'query: ', duplicate: 0.9, related: 0.5 };

/**
 * Bag-of-words embedder: lowercased, accent-stripped tokens hashed into 384 signed buckets, L2-normalized.
 * Identical token sets → similarity 1; disjoint vocabularies → ~0.
 */
export class HashEmbedder implements Embedder {
  readonly model: string;
  readonly dims = 384;
  /** Every text passed to embed(), in order. */
  readonly embedded: string[] = [];
  fail = false;

  constructor(model = HASH_MODEL) {
    this.model = model;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.fail) throw new Error('model offline');
    this.embedded.push(...texts);
    return texts.map((text) => {
      const vector = new Float32Array(this.dims);
      const tokens = text
        .replace(/^query: /, '')
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [];
      for (const token of tokens) {
        const digest = createHash('sha1').update(token).digest();
        const bucket = digest.readUInt16BE(0) % this.dims;
        vector[bucket]! += digest[2]! & 1 ? 1 : -1;
      }
      const norm = Math.hypot(...vector) || 1;
      return vector.map((value) => value / norm);
    });
  }
}

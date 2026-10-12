import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { VecTable } from './migrations.js';
import { REFERENCE_MEANS } from './reference-means.js';

export interface Embedder {
  model: string;
  dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface Centering {
  /** Mean vector per vec table over a reference corpus; stands in for the registry's mean while it has few items. */
  reference: Readonly<Record<VecTable, Float32Array>>;
  /** Weight of `reference` in the center, counted in items. */
  prior: number;
}

export interface ModelInfo {
  dims: number;
  /** Prepended to every stored item text and query. */
  prefix: string;
  /** Similarity at or above which two texts are reported as duplicates. */
  duplicate: number;
  /** Similarity at or above which two texts are reported as related. */
  related: number;
  /**
   * When set, similarity is the cosine of query and item vectors after subtracting a center from both: the mean of the
   * registry's vectors of that vec table, blended with `reference`. Texts of one domain share a large common direction
   * that puts unrelated items above any usable plain-cosine threshold; centering removes it. Unset: plain cosine.
   */
  centering?: Centering;
}

export const DEFAULT_MODEL = 'Xenova/multilingual-e5-small';

/** Centering from the generated reference means, which hold base64 float32 vectors per vec table. */
function centering(model: string, prior: number): Centering {
  const reference = Object.fromEntries(
    Object.entries(REFERENCE_MEANS[model]!).map(([table, base64]) => {
      const bytes = Buffer.from(base64, 'base64');
      return [table, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))];
    }),
  ) as Record<VecTable, Float32Array>;
  return { reference, prior };
}

export const MODEL_REGISTRY: Record<string, ModelInfo> = {
  // Thresholds from `npm run calibrate` on 2026-10-11, centered similarity with prior 20. Duplicate: lowest threshold
  // classing at most 5% of the nearest neighbours of test/fixtures/registry-pairs.json (242 requirements of one
  // domain, none a duplicate; plain cosine put 0.85–0.96 between them) as duplicates; it classes 84% of 31 rewordings
  // and 70% of the similarity-pairs.json duplicates as duplicate, the rest as related. Related: lowest threshold classing
  // at most 5% of the registry's pairs from different components as related; 2% of similarity-pairs.json unrelated pairs.
  'Xenova/multilingual-e5-small': {
    dims: 384,
    prefix: 'query: ',
    duplicate: 0.61,
    related: 0.22,
    centering: centering('Xenova/multilingual-e5-small', 20),
  },
};

/** Files transformers.js needs for the q8 feature-extraction pipeline. */
const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

/** Model cache: OVERSEER_MODEL_DIR, else the per-OS user cache dir. */
export function modelCacheDir(env: Record<string, string | undefined> = process.env): string {
  if (env.OVERSEER_MODEL_DIR) return env.OVERSEER_MODEL_DIR;
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'overseer', 'models');
  if (process.platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'overseer', 'models');
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'overseer', 'models');
}

/** True when every file of `model` is present in the cache (no network needed to load it). */
export function isModelCached(model: string = DEFAULT_MODEL, cacheDir: string = modelCacheDir()): boolean {
  return MODEL_FILES.every((file) => existsSync(join(cacheDir, model, file)));
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: ArrayLike<number>; dims: number[] }>;

const RETRY_AFTER_MS = 5 * 60_000;

/** Local ONNX embedder via transformers.js; the model loads lazily on first use. */
export class TransformersEmbedder implements Embedder {
  readonly model: string;
  readonly dims: number;
  private extractor?: Promise<FeatureExtractor>;
  private failedAt = 0;

  constructor(model: string = DEFAULT_MODEL) {
    this.model = model;
    this.dims = MODEL_REGISTRY[model]?.dims ?? 384;
  }

  private load(): Promise<FeatureExtractor> {
    if (this.extractor) return this.extractor;
    if (this.failedAt && Date.now() - this.failedAt < RETRY_AFTER_MS) {
      return Promise.reject(new Error('model load failed recently; retrying later'));
    }
    this.extractor = (async () => {
      // Lazy on purpose: importing transformers.js loads onnxruntime's native binding, which would slow every CLI command.
      const transformers = await import('@huggingface/transformers');
      transformers.env.cacheDir = modelCacheDir();
      const pipe = await transformers.pipeline('feature-extraction', this.model, { dtype: 'q8' });
      // The pipeline's declared call signature is a broad union; this is the feature-extraction overload.
      const extractor = pipe as unknown as FeatureExtractor;
      return extractor;
    })();
    this.extractor.catch(() => {
      this.extractor = undefined;
      this.failedAt = Date.now();
    });
    return this.extractor;
  }

  /** Downloads (if needed) and loads the model; used by `overseer models pull`. */
  async warmup(): Promise<void> {
    this.failedAt = 0;
    await this.load();
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    const dims = output.dims.at(-1) ?? this.dims;
    const data = Float32Array.from(output.data);
    return texts.map((_, index) => data.slice(index * dims, (index + 1) * dims));
  }
}

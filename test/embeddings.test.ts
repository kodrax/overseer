import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pullModel } from '../src/cli/commands/models.js';
import { DEFAULT_MODEL, isModelCached, type TransformersModule, TransformersEmbedder } from '../src/core/embeddings.js';
import { OverseerService } from '../src/core/service.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { ctx } from './helpers/service.js';
import { tempDir, tempRepo } from './helpers/tmp.js';

const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

interface PipelineCall {
  model: string;
  cacheDir: string | null;
  local_files_only: boolean;
}

/**
 * transformers.js stand-in: counts imports, records pipeline calls and, when downloads are allowed, writes the model
 * files into the cache the way the hub download does. Its extractor embeds with the hash embedder.
 */
function stubTransformers() {
  const hash = new HashEmbedder();
  const calls: PipelineCall[] = [];
  let imports = 0;
  const module: TransformersModule = {
    env: { cacheDir: null },
    async pipeline(_task, model, options) {
      const cacheDir = module.env.cacheDir;
      calls.push({ model, cacheDir, local_files_only: options.local_files_only });
      if (!options.local_files_only && cacheDir) {
        for (const file of MODEL_FILES) {
          const path = join(cacheDir, model, file);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, '');
        }
      }
      return async (texts: string[]) => {
        const vectors = await hash.embed(texts);
        const data = new Float32Array(vectors.length * hash.dims);
        vectors.forEach((vector, index) => data.set(vector, index * hash.dims));
        return { data, dims: [vectors.length, hash.dims] };
      };
    },
  };
  return {
    calls,
    imports: () => imports,
    importTransformers: async () => {
      imports += 1;
      return module;
    },
  };
}

function open(embedder: TransformersEmbedder): OverseerService {
  return OverseerService.open({ root: tempRepo(), create: true, embedder })!;
}

async function addRequirement(service: OverseerService): Promise<void> {
  await service.createItem(
    { kind: 'requirement', title: 'Password reset by email', description: 'Users receive a reset link by email', req_type: 'functional' },
    ctx,
  );
}

describe('TransformersEmbedder model cache', () => {
  it('answers from the keyword index without downloading while the cache is empty', async () => {
    const cacheDir = tempDir('ovs-models-');
    const stub = stubTransformers();
    const service = open(new TransformersEmbedder(DEFAULT_MODEL, { cacheDir, importTransformers: stub.importTransformers }));
    await addRequirement(service);
    const warning = expect.stringContaining('run overseer models pull');

    const search = await service.search('password reset');
    expect(search).toMatchObject({ semantic: false, warning });
    expect(search.results[0]).toMatchObject({ similarity: null, fts_rank: 1 });
    expect(await service.findSimilar('Password reset by email')).toMatchObject({ semantic: false, verdict: 'unknown', warning });
    expect(await service.checkCoverage('Password reset by email')).toMatchObject({ semantic: false, verdict: 'unknown', warning });

    // transformers.js is never imported, so no download can start.
    expect(stub.imports()).toBe(0);
    expect(stub.calls).toEqual([]);
    expect(readdirSync(cacheDir)).toEqual([]);
    service.close();
  });

  it('downloads the model only on models pull, then loads it from the cache offline', async () => {
    const cacheDir = tempDir('ovs-models-');
    const stub = stubTransformers();
    const pull = await pullModel(new TransformersEmbedder(DEFAULT_MODEL, { cacheDir, importTransformers: stub.importTransformers }));
    expect(pull).toEqual({ ready: true, message: `Model ${DEFAULT_MODEL} ready in ${cacheDir}` });
    expect(stub.calls).toEqual([{ model: DEFAULT_MODEL, cacheDir, local_files_only: false }]);
    expect(isModelCached(DEFAULT_MODEL, cacheDir)).toBe(true);

    const service = open(new TransformersEmbedder(DEFAULT_MODEL, { cacheDir, importTransformers: stub.importTransformers }));
    await addRequirement(service);
    const search = await service.search('password reset');
    expect(search.semantic).toBe(true);
    expect(search.warning).toBeUndefined();
    expect((await service.findSimilar('Password reset by email')).semantic).toBe(true);
    expect((await service.checkCoverage('Password reset by email')).semantic).toBe(true);
    // One load for the whole service, from local files only.
    expect(stub.calls).toEqual([
      { model: DEFAULT_MODEL, cacheDir, local_files_only: false },
      { model: DEFAULT_MODEL, cacheDir, local_files_only: true },
    ]);
    service.close();
  });

  it('starts using the model as soon as it lands in the cache, without waiting for the retry window', async () => {
    const cacheDir = tempDir('ovs-models-');
    const stub = stubTransformers();
    const embedder = new TransformersEmbedder(DEFAULT_MODEL, { cacheDir, importTransformers: stub.importTransformers });
    await expect(embedder.embed(['hello'])).rejects.toThrow(`embedding model ${DEFAULT_MODEL} is not downloaded; run overseer models pull`);

    // Another process (`overseer models pull`) fills the cache.
    await pullModel(new TransformersEmbedder(DEFAULT_MODEL, { cacheDir, importTransformers: stub.importTransformers }));
    const [vector] = await embedder.embed(['hello']);
    expect(vector).toHaveLength(384);
    expect(stub.calls.at(-1)).toEqual({ model: DEFAULT_MODEL, cacheDir, local_files_only: true });
  });
});

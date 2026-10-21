import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { tempDir, tempRepo, tempUserConfig } from './helpers/tmp.js';

// Offline stand-in for transformers.js in this file: every model load fails the way an unreachable hub does.
const { pipeline, transformersEnv } = vi.hoisted(() => ({ pipeline: vi.fn(), transformersEnv: { cacheDir: null as string | null } }));
vi.mock('@huggingface/transformers', () => ({ env: transformersEnv, pipeline }));

async function cli(cwd: string, args: string[], env: Record<string, string | undefined>) {
  let out = '';
  let err = '';
  const io = {
    stdout: { write: (chunk: string) => (out += chunk) },
    stderr: { write: (chunk: string) => (err += chunk) },
    stdin: Readable.from([]),
  };
  // No injected embedder: the commands build the real TransformersEmbedder, which imports the mocked module.
  const code = await runCli(args, io, { env: { OVERSEER_CONFIG_DIR: tempUserConfig(), ...env }, cwd });
  return { code, out, err };
}

describe('model download failures in the CLI', () => {
  beforeEach(() => {
    pipeline.mockReset();
    pipeline.mockRejectedValue(new Error('fetch failed: getaddrinfo ENOTFOUND huggingface.co'));
  });

  it('models pull prints the cause on stderr and exits 1', async () => {
    const result = await cli(tempRepo(), ['models', 'pull'], { HOME: tempDir('ovs-home-') });
    expect(result).toEqual({ code: 1, out: '', err: 'error: model download failed: fetch failed: getaddrinfo ENOTFOUND huggingface.co\n' });
    expect(pipeline).toHaveBeenCalledOnce();
    expect(pipeline.mock.calls[0]?.slice(0, 2)).toEqual(['feature-extraction', 'Xenova/multilingual-e5-small']);
    expect(pipeline.mock.calls[0]?.[2]).toMatchObject({ local_files_only: false });
  });

  it('install installs the harness files, then exits 1 when the download fails (REQ-0150)', async () => {
    const home = tempDir('ovs-home-');
    const env = { HOME: home, PATH: '' };
    const human = await cli(tempRepo(), ['install', '--targets', 'omp'], env);
    expect(human.code).toBe(1);
    expect(human.err).toBe('error: model download failed: fetch failed: getaddrinfo ENOTFOUND huggingface.co\n');
    expect(existsSync(join(home, '.omp'))).toBe(true);

    const json = await cli(tempRepo(), ['install', '--targets', 'omp', '--json'], env);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({
      targets: ['omp'],
      model: { ready: false, message: 'model download failed: fetch failed: getaddrinfo ENOTFOUND huggingface.co' },
    });
  });
});

// BUG-0011: the model folder comes from the CLI's injected environment, never from process.env.
describe('model folder from the CLI environment', () => {
  let cacheDirsUsed: (string | null)[];

  beforeEach(() => {
    cacheDirsUsed = [];
    pipeline.mockReset();
    pipeline.mockImplementation(() => {
      cacheDirsUsed.push(transformersEnv.cacheDir);
      return Promise.resolve(() => Promise.resolve({ data: new Float32Array(384), dims: [1, 384] }));
    });
  });

  function markCached(modelDir: string): void {
    const model = join(modelDir, 'Xenova', 'multilingual-e5-small');
    mkdirSync(join(model, 'onnx'), { recursive: true });
    for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']) writeFileSync(join(model, file), '');
  }

  it('models pull downloads into OVERSEER_MODEL_DIR from the CLI env and names it', async () => {
    const modelDir = tempDir('ovs-models-');
    expect(process.env.OVERSEER_MODEL_DIR).not.toBe(modelDir);
    const result = await cli(tempRepo(), ['models', 'pull'], { HOME: tempDir('ovs-home-'), OVERSEER_MODEL_DIR: modelDir });
    expect(result).toEqual({ code: 0, out: `Model Xenova/multilingual-e5-small ready in ${modelDir}\n`, err: '' });
    expect(cacheDirsUsed).toEqual([modelDir]);
  });

  it('install without --skip-model uses the same folder', async () => {
    const modelDir = tempDir('ovs-models-');
    const result = await cli(tempRepo(), ['install', '--targets', 'omp'], { HOME: tempDir('ovs-home-'), PATH: '', OVERSEER_MODEL_DIR: modelDir });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`ready in ${modelDir}`);
    expect(cacheDirsUsed).toEqual([modelDir]);
  });

  it('doctor, models pull, install and search all use one folder', async () => {
    const modelDir = tempDir('ovs-models-');
    const repo = tempRepo();
    const env = { HOME: tempDir('ovs-home-'), PATH: '', OVERSEER_MODEL_DIR: modelDir };
    await cli(repo, ['models', 'pull'], env);
    await cli(repo, ['install', '--targets', 'omp'], env);
    markCached(modelDir);
    expect((await cli(repo, ['doctor'], env)).out).toContain(`cached in ${modelDir}`);
    const added = await cli(repo, ['add', 'requirement', '--title', 'Searchable thing', '--type', 'functional'], env);
    expect(added.err).toBe('');
    const search = await cli(repo, ['search', 'thing'], env);
    expect(search.code).toBe(0);
    expect(cacheDirsUsed.length).toBeGreaterThan(2);
    expect(new Set(cacheDirsUsed)).toEqual(new Set([modelDir]));
  });
});

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { tempDir, tempRepo, tempUserConfig } from './helpers/tmp.js';

// Offline stand-in for transformers.js in this file: every model load fails the way an unreachable hub does.
const pipeline = vi.hoisted(() => vi.fn());
vi.mock('@huggingface/transformers', () => ({ env: { cacheDir: null }, pipeline }));

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

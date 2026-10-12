import type { Command } from 'commander';
import { modelCacheDir, TransformersEmbedder } from '../../core/embeddings.js';
import { errorMessage } from '../../core/errors.js';
import type { CliRuntime } from '../runtime.js';

export interface ModelPull {
  ready: boolean;
  message: string;
}

/** Downloads (if needed) and loads the embedding model. */
export async function pullModel(): Promise<ModelPull> {
  const embedder = new TransformersEmbedder();
  try {
    await embedder.warmup();
    return { ready: true, message: `Model ${embedder.model} ready in ${modelCacheDir()}` };
  } catch (error) {
    return { ready: false, message: `model download failed: ${errorMessage(error)}` };
  }
}

/** Prints a pull outcome; failure → `error: model download failed: <cause>` on stderr and exit code 1. */
export function reportModelPull(rt: CliRuntime, pull: ModelPull): void {
  if (pull.ready) {
    rt.out(pull.message);
    return;
  }
  rt.err(`error: ${pull.message}`);
  rt.exitCode = 1;
}

export function registerModelCommands(program: Command, rt: CliRuntime): void {
  program
    .command('models')
    .description('manage the local embedding model')
    .command('pull')
    .description('download the embedding model into the local cache')
    .action(async () => {
      reportModelPull(rt, await pullModel());
    });
}

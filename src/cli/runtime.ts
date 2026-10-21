import type { Readable } from 'node:stream';
import type { Command } from 'commander';
import { DEFAULT_MODEL, type Embedder, modelCacheDir, TransformersEmbedder } from '../core/embeddings.js';
import { errorMessage, isOverseerError } from '../core/errors.js';
import { pickStartDir, resolveProjectRoot } from '../core/project.js';
import type { Ctx } from '../core/schema.js';
import { OverseerService } from '../core/service.js';
import { assertProjectEnabled } from '../core/user-config.js';

export interface CliWriter {
  write(chunk: string): unknown;
}

export interface CliIo {
  stdout: CliWriter;
  stderr: CliWriter;
  stdin: Readable;
}

export interface CliDeps {
  /** undefined → local transformers.js model; null → keyword search only. */
  embedder?: Embedder | null;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/** Options every command can see: the global `--project` plus its own `--json`. */
export interface GlobalOptions {
  project?: string;
  json?: boolean;
}

/** Shared state of one `runCli` invocation: streams, injected dependencies and the exit code. */
export class CliRuntime {
  readonly io: CliIo;
  readonly embedder: Embedder | null;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  exitCode = 0;

  constructor(io: CliIo, deps: CliDeps) {
    this.io = io;
    this.env = deps.env ?? process.env;
    this.embedder = deps.embedder === undefined ? this.localEmbedder() : deps.embedder;
    this.cwd = deps.cwd ?? process.cwd();
  }

  /** The local transformers.js embedder, with its model folder taken from this runtime's environment. */
  localEmbedder(): TransformersEmbedder {
    return new TransformersEmbedder(DEFAULT_MODEL, { cacheDir: modelCacheDir(this.env) });
  }

  get ctx(): Ctx {
    const actor = this.env.OVERSEER_ACTOR;
    return actor ? { via: 'cli', actor } : { via: 'cli' };
  }

  /** True when stdin is a terminal, so commands may ask questions instead of guessing. */
  get interactive(): boolean {
    const { stdin } = this.io;
    return 'isTTY' in stdin && stdin.isTTY === true;
  }

  out(text: string): void {
    this.io.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  err(text: string): void {
    this.io.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  /** `--json` → the value as 2-space JSON; otherwise the human rendering. */
  emit<T>(json: boolean | undefined, value: T, human: (value: T) => string): void {
    this.out(json ? JSON.stringify(value, null, 2) : human(value));
  }

  /** Reports an error (`error: <CODE>: <message>` on stderr, or the JSON envelope on stdout) and sets exit code 1. */
  fail(error: unknown, json: boolean): void {
    const code = isOverseerError(error) ? error.code : 'INTERNAL';
    const message = errorMessage(error);
    if (json) this.out(JSON.stringify({ error: { code, message } }));
    else this.err(`error: ${code}: ${message}`);
    this.exitCode = 1;
  }

  projectRoot(explicit: string | undefined): string {
    return resolveProjectRoot(pickStartDir({ explicit, env: this.env, cwd: this.cwd }));
  }

  /**
   * Runs `fn` with the project's service, closing it afterwards. Projects are off unless turned on with `overseer enable`
   * (else DISABLED). Writes create the data folder (home guard → NO_PROJECT); reads on an uninitialized project print
   * `{ initialized: false, root }` and exit 0.
   */
  async withService(command: Command, mode: 'read' | 'write', fn: (service: OverseerService, options: GlobalOptions) => Promise<void> | void): Promise<void> {
    const options = command.optsWithGlobals<GlobalOptions>();
    const root = this.projectRoot(options.project);
    assertProjectEnabled(root, this.env);
    const service = OverseerService.open({ root, create: mode === 'write', embedder: this.embedder });
    if (!service) {
      this.emit(options.json, { initialized: false, root }, () => `overseer is not initialized in ${root} (run "overseer init" there, or pass --project).`);
      return;
    }
    try {
      await fn(service, options);
    } finally {
      service.close();
    }
  }
}

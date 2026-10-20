import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OverseerError } from '../core/errors.js';
import type { CliRuntime } from './runtime.js';

/** Text of `file` (relative to the working directory), or of stdin for `-`. `label` names the input in errors. */
export async function readInput(rt: CliRuntime, file: string, label: string): Promise<string> {
  if (file !== '-') {
    const path = resolve(rt.cwd, file);
    if (!existsSync(path)) throw new OverseerError('INVALID_INPUT', `${label} file not found: ${path}`);
    return readFileSync(path, 'utf8');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of rt.io.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

/** Parsed JSON of an input; INVALID_INPUT `<label> input is not valid JSON` otherwise. */
export function parseJsonInput(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new OverseerError('INVALID_INPUT', `${label} input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

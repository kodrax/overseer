import { OverseerService } from '../../src/core/service.js';
import type { Ctx } from '../../src/core/schema.js';
import { HashEmbedder } from './hash-embedder.js';
import { tempRepo } from './tmp.js';

export const ctx: Ctx = { via: 'test', actor: 'tester' };

/** Fresh initialized project (temp git repo) with the deterministic hash embedder. */
export function openService(root = tempRepo(), embedder: HashEmbedder | null = new HashEmbedder()): OverseerService {
  return OverseerService.open({ root, create: true, embedder })!;
}

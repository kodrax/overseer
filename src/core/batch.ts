import { z } from 'zod';
import { nowIso, tx } from './db.js';
import { isOverseerError, OverseerError } from './errors.js';
import { allocateId } from './ids.js';
import { lintItem } from './lint.js';
import { type CreateInput, createInputSchema, type Ctx, type Item, issueTexts, type Kind, type LintWarning, PARENT_KINDS, parseInput, type Relation } from './schema.js';
import type { MatchClass, SimilarMatch, SimilarVerdict } from './search.js';
import type { OverseerService } from './service.js';

/** Most entries one batch create accepts. */
export const MAX_BATCH_ITEMS = 50;

/** Candidates reported per entry, as for a single create. */
const CANDIDATE_LIMIT = 5;

/**
 * Batch keys: 1–64 letters, digits, `_`, `.` or `-`; a leading `@` is dropped. `parent_id` and link `to` name a batch
 * entry as `@<key>`. Item IDs never start with `@`, so a reference is a key exactly when it does.
 */
const KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

const keySchema = z
  .string()
  .transform((key) => (key.startsWith('@') ? key.slice(1) : key))
  .pipe(z.string().regex(KEY_PATTERN, 'key must be 1–64 letters, digits, "_", "." or "-"'));

/** One `items` entry: the single-create input plus an optional `key`. */
export const batchItemSchema = createInputSchema.extend({ key: keySchema.optional() }).strict();

const batchRequestSchema = z.object({ items: z.array(z.unknown()).min(1).max(MAX_BATCH_ITEMS) });

/** An earlier entry of the same batch found by the duplicate check; `id` is set once the batch is written. */
export interface BatchMatch {
  id?: string;
  index: number;
  key?: string;
  kind: Kind;
  title: string;
  status: string;
  similarity: number;
  match: MatchClass;
}

export type BatchSimilar = SimilarMatch | BatchMatch;

/** Compact candidate: a stored item (`id`) or an earlier entry of the batch (`index`, `key`, and `id` once written). */
export interface BatchCandidateRef {
  id?: string;
  index?: number;
  key?: string;
  title: string;
  similarity: number | null;
  match: MatchClass | null;
}

export interface BatchDuplicate<C> {
  index: number;
  key?: string;
  candidates: C[];
}

export interface BatchCreatedItem {
  key?: string;
  item: Item;
  warnings: LintWarning[];
  similar: BatchSimilar[];
}

export type BatchCreateResult =
  | { created: true; items: BatchCreatedItem[] }
  | { created: false; reason: 'possible_duplicate'; duplicates: BatchDuplicate<BatchSimilar>[] };

export interface CompactBatchCreatedItem {
  key?: string;
  id: string;
  title: string;
  status: string;
  verdict: SimilarVerdict;
  candidates: BatchCandidateRef[];
  warnings: LintWarning[];
}

export type CompactBatchCreateResult =
  | { created: true; items: CompactBatchCreatedItem[] }
  | { created: false; reason: 'possible_duplicate'; duplicates: BatchDuplicate<BatchCandidateRef>[] };

/** Full result plus the duplicate-check verdict per entry (for the compact result). */
export interface BatchOutcome {
  result: BatchCreateResult;
  verdicts: SimilarVerdict[];
}

/** A resolved reference: a stored item, or a batch entry (`index`, `id` = `@<key>`; `kind` unknown when that entry is invalid). */
interface Ref {
  id: string;
  kind?: Kind;
  index?: number;
}

interface Entry {
  index: number;
  key?: string;
  input: CreateInput;
  status: string;
  parent?: Ref;
  links: { rel: Relation; to: Ref }[];
}

function label(index: number, key: string | undefined): string {
  return `items[${index}]${key ? ` (@${key})` : ''}`;
}

/**
 * Validates the whole batch before anything is written (REQ-0026): each entry's schema and kind rules, keys, and
 * parent and link references (stored IDs or `@<key>`) with their kind rules and parent cycles. INVALID_INPUT lists
 * every problem with its entry index and key.
 */
function validateBatch(service: OverseerService, raw: unknown): Entry[] {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const extra = Object.entries(raw)
      .filter(([field, value]) => field !== 'items' && value !== undefined)
      .map(([field]) => field);
    if (extra.length > 0) {
      throw new OverseerError('INVALID_INPUT', `Pass either one item's fields or items, not both; move ${extra.join(', ')} into the items entries.`);
    }
  }
  const { items } = parseInput(batchRequestSchema, raw);
  // Keys first, so references to an entry that fails validation still resolve (its own problems are listed).
  const keys = items.map((item) => {
    const key = item !== null && typeof item === 'object' && 'key' in item ? keySchema.safeParse(item.key) : undefined;
    return key?.success ? key.data : undefined;
  });
  const problems: { index: number; text: string }[] = [];
  const problem = (index: number, text: string): void => {
    problems.push({ index, text: `${label(index, keys[index])}: ${text}` });
  };
  const keyed = new Map<string, number>();
  keys.forEach((key, index) => {
    if (key === undefined) return;
    const first = keyed.get(key);
    if (first === undefined) keyed.set(key, index);
    else problem(index, `key "@${key}" is already used by ${label(first, key)}`);
  });

  const parsed = items.map((item) => batchItemSchema.safeParse(item));
  const resolve = (reference: string): Ref | string => {
    if (reference.startsWith('@')) {
      const index = keyed.get(reference.slice(1));
      if (index === undefined) return `no entry of this batch has key "${reference}"`;
      const target = parsed[index]!;
      return { id: reference, index, ...(target.success ? { kind: target.data.kind } : {}) };
    }
    try {
      const row = service.requireRow(reference);
      return { id: row.id, kind: row.kind };
    } catch (error) {
      // The service's NOT_FOUND text, which also says when a deleted ID was deleted.
      if (!isOverseerError(error)) throw error;
      return `${error.message}${keyed.has(reference.trim()) ? ` Write "@${reference.trim()}" to refer to the batch entry with that key.` : ''}`;
    }
  };

  const entries: (Entry | undefined)[] = parsed.map((result, index) => {
    if (!result.success) {
      for (const text of issueTexts(result.error)) problem(index, text);
      return undefined;
    }
    const { key, ...input } = result.data;
    let status = '';
    try {
      status = service.checkCreate(input);
    } catch (error) {
      if (!isOverseerError(error)) throw error;
      problem(index, error.message);
    }
    const entry: Entry = { index, ...(key ? { key } : {}), input, status, links: [] };
    const { kind } = input;
    if (input.parent_id !== undefined) {
      const allowed = PARENT_KINDS[kind];
      const parent = resolve(input.parent_id);
      if (allowed.length === 0) problem(index, `parent_id: A ${kind} cannot have a parent.`);
      else if (typeof parent === 'string') problem(index, `parent_id "${input.parent_id}": ${parent}`);
      else if (parent.kind && !allowed.includes(parent.kind)) {
        problem(index, `parent_id: A ${kind} can only have a ${allowed.join(' or ')} parent; ${parent.id} is a ${parent.kind}.`);
      } else entry.parent = parent;
    }
    (input.links ?? []).forEach(({ rel, to }, position) => {
      const target = resolve(to);
      if (typeof target === 'string') {
        problem(index, `links[${position}].to "${to}": ${target}`);
        return;
      }
      if (target.kind) {
        try {
          service.assertLink({ ...(key ? { id: `@${key}` } : {}), kind }, rel, { id: target.id, kind: target.kind });
        } catch (error) {
          if (!isOverseerError(error)) throw error;
          problem(index, `links[${position}]: ${error.message}`);
          return;
        }
      }
      entry.links.push({ rel, to: target });
    });
    return entry;
  });

  // Parent cycles among batch entries (only requirements can nest in one another); reported once, on the first entry.
  for (const entry of entries) {
    if (!entry) continue;
    const chain = [entry.index];
    for (let cursor = entry.parent?.index; cursor !== undefined; cursor = entries[cursor]?.parent?.index) {
      if (cursor === entry.index) {
        if (Math.min(...chain) === entry.index) problem(entry.index, `parent_id cycle: ${[...chain, cursor].map((index) => `@${keys[index]}`).join(' → ')}`);
        break;
      }
      if (chain.includes(cursor)) break;
      chain.push(cursor);
    }
  }

  if (problems.length > 0) {
    const texts = problems.sort((a, b) => a.index - b.index).map((entry) => entry.text);
    throw new OverseerError('INVALID_INPUT', `Nothing written: ${texts.length} problem${texts.length === 1 ? '' : 's'} in the batch: ${texts.join('; ')}`, {
      problems: texts,
    });
  }
  return entries as Entry[];
}

/**
 * Creates up to 50 items in one transaction (`create_item {items}`, `overseer add --batch`). Entries may carry a `key`;
 * `parent_id` and link `to` take a stored ID or `@<key>`. The whole batch is validated first; then each entry is checked
 * for duplicates against the stored items and the earlier entries. Any likely duplicate without its own
 * `allow_duplicate` → nothing is written.
 */
export async function createBatch(service: OverseerService, raw: unknown, ctx: Ctx): Promise<BatchOutcome> {
  const entries = validateBatch(service, raw);
  const checks = await service.findSimilarBatch(
    entries.map(({ input }) => {
      const description = input.description ?? '';
      return {
        kind: input.kind,
        text: `${input.title}\n${description}`,
        item: { title: input.title, description, acceptance_criteria: input.acceptance_criteria ?? [], fit_criterion: input.fit_criterion ?? null },
      };
    }),
  );

  const similar: BatchSimilar[][] = [];
  const verdicts: SimilarVerdict[] = [];
  const duplicates: BatchDuplicate<BatchSimilar>[] = [];
  checks.forEach(({ board, earlier }, index) => {
    const entry = entries[index]!;
    const fromBatch = earlier.map(({ index: other, similarity, match }): BatchMatch => {
      const { key, input, status } = entries[other]!;
      return { index: other, ...(key ? { key } : {}), kind: input.kind, title: input.title, status, similarity, match };
    });
    const matches: BatchSimilar[] = board.semantic
      ? [...board.matches.filter((match) => match.match === 'duplicate' || match.match === 'related'), ...fromBatch]
          .sort((a, b) => b.similarity! - a.similarity!)
          .slice(0, CANDIDATE_LIMIT)
      : board.matches;
    // The board verdict is its best match's class; earlier entries add theirs.
    const classes: string[] = [board.verdict, ...fromBatch.map((match) => match.match)];
    const verdict: SimilarVerdict = !board.semantic ? 'unknown' : classes.includes('duplicate') ? 'duplicate' : classes.includes('related') ? 'related' : 'new';
    similar.push(matches);
    verdicts.push(verdict);
    if (verdict === 'duplicate' && !entry.input.allow_duplicate) duplicates.push({ index, ...(entry.key ? { key: entry.key } : {}), candidates: matches });
  });
  if (duplicates.length > 0) return { result: { created: false, reason: 'possible_duplicate', duplicates }, verdicts };

  const now = nowIso();
  const ids = tx(service.db, () => {
    // IDs follow the batch order; rows go in parents first, so a parent may come later in the batch.
    const allocated = entries.map(({ input }) => allocateId(service.db, input.kind));
    const idOf = (ref: Ref): string => (ref.index === undefined ? ref.id : allocated[ref.index]!);
    const inserted = new Set<number>();
    const insert = (index: number): void => {
      if (inserted.has(index)) return;
      inserted.add(index);
      const { input, status, parent } = entries[index]!;
      if (parent?.index !== undefined) insert(parent.index);
      service.insertItem(service.createValues(input, status, parent ? idOf(parent) : null, ctx, now), ctx, [], 'create', allocated[index]);
    };
    entries.forEach((_, index) => insert(index));
    entries.forEach(({ links }, index) => {
      for (const link of links) service.insertLink(allocated[index]!, link.rel, idOf(link.to), ctx, now);
    });
    return allocated;
  });

  const items = entries.map(({ key }, index): BatchCreatedItem => {
    const item = service.itemOf(service.requireRow(ids[index]!));
    return {
      ...(key ? { key } : {}),
      item,
      warnings: lintItem(item),
      similar: similar[index]!.map((match) => ('index' in match ? { id: ids[match.index]!, ...match } : match)),
    };
  });
  return { result: { created: true, items }, verdicts };
}

/** Compact batch result for agents: per entry its key, ID, title, status, duplicate-check verdict, candidates and warnings. */
export function compactBatchResult({ result, verdicts }: BatchOutcome): CompactBatchCreateResult {
  const candidate = (match: BatchSimilar): BatchCandidateRef => {
    const { id, title, similarity, match: matchClass } = match;
    if (!('index' in match)) return { id: id!, title, similarity, match: matchClass };
    return { ...(id ? { id } : {}), index: match.index, ...(match.key ? { key: match.key } : {}), title, similarity, match: matchClass };
  };
  if (!result.created) {
    return {
      created: false,
      reason: 'possible_duplicate',
      duplicates: result.duplicates.map(({ candidates, ...entry }) => ({ ...entry, candidates: candidates.map(candidate) })),
    };
  }
  return {
    created: true,
    items: result.items.map(({ key, item, warnings, similar }, index) => ({
      ...(key ? { key } : {}),
      id: item.id,
      title: item.title,
      status: item.status,
      verdict: verdicts[index]!,
      candidates: similar.map(candidate),
      warnings,
    })),
  };
}

import { z } from 'zod';
import { nowIso, tx } from './db.js';
import { columnValue, getRow, toItem, writeFts } from './items.js';
import { type Ctx, IMPORT_SOURCES, type ImportSource, type Item, KINDS, type Kind, PARENT_KINDS, parseInput } from './schema.js';
import type { OverseerService } from './service.js';

const DESCRIPTION_MAX = 20000;

export const importItemSchema = z.object({
  external_id: z.string().trim().min(1).max(500),
  url: z.string().max(2000),
  title: z.string().trim().min(1).max(500),
  body: z.string().nullish(),
  state: z.enum(['open', 'closed']),
  labels: z.array(z.string().max(200)).max(100).optional(),
  type_hint: z.enum(KINDS).optional(),
  assignees: z.array(z.string().max(200)).max(50).optional(),
  milestone: z.string().max(500).nullish(),
  created_at: z.string().max(100).nullish(),
  updated_at: z.string().max(100).nullish(),
  parent_external_id: z.string().max(500).nullish(),
});

export const importInputSchema = z.object({
  source: z.enum(IMPORT_SOURCES),
  repo: z.string().trim().min(1).max(500),
  items: z.array(importItemSchema).min(1).max(100),
});

export type ImportItem = z.infer<typeof importItemSchema>;
export type ImportInput = z.infer<typeof importInputSchema>;

export interface ImportResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  warnings: string[];
  possible_duplicates: { id: string; similar_to: { id: string; similarity: number }[] }[];
  last_import_at: string;
}

/** Kind from `type_hint`, else from labels (S10). */
export function importKind(item: Pick<ImportItem, 'type_hint' | 'labels'>): Kind {
  if (item.type_hint) return item.type_hint;
  const labels = (item.labels ?? []).map((label) => label.toLowerCase());
  const has = (pattern: RegExp) => labels.some((label) => pattern.test(label));
  if (has(/bug|defect|regression|incident/)) return 'bug';
  if (has(/epic/)) return 'epic';
  if (has(/requirement|^req$|nfr|non-functional/)) return 'requirement';
  if (has(/story|feature|enhancement/)) return 'story';
  return 'task';
}

function openStatus(kind: Kind, labels: readonly string[]): string {
  if (kind === 'requirement') return 'approved';
  if (kind === 'epic') return 'open';
  return labels.some((label) => /in progress|doing|wip/i.test(label)) ? 'in_progress' : 'backlog';
}

function closedStatus(kind: Kind): string {
  return kind === 'requirement' ? 'implemented' : 'done';
}

function remoteTime(value: string | null | undefined, fallback: string): string {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? fallback : nowIso(new Date(time));
}

/** Idempotent one-way upsert of GitHub/GitLab issues (S10). Imported text is stored as data only. */
export async function importItems(service: OverseerService, raw: unknown, ctx: Ctx): Promise<ImportResult> {
  const input: ImportInput = parseInput(importInputSchema, raw);
  const source: ImportSource = input.source;
  const importCtx: Ctx = { ...ctx, via: `import:${source}` };
  const refOf = (externalId: string) => `${source}:${externalId}`;
  const result: ImportResult = { created: [], updated: [], unchanged: [], warnings: [], possible_duplicates: [], last_import_at: '' };
  const createdIds: string[] = [];
  const now = nowIso();
  const db = service.db;

  tx(db, () => {
    const seen = new Set<string>();
    for (const remote of input.items) {
      const externalRef = refOf(remote.external_id);
      if (seen.has(externalRef)) {
        result.warnings.push(`${remote.external_id}: listed twice in this batch; only the first entry was used.`);
        continue;
      }
      seen.add(externalRef);
      const labels = remote.labels ?? [];
      const description = (remote.body ?? '').slice(0, DESCRIPTION_MAX);
      const existing = db.prepare('SELECT * FROM items WHERE external_ref = ?').get(externalRef);
      if (!existing) {
        const kind = importKind(remote);
        const status = remote.state === 'closed' ? closedStatus(kind) : openStatus(kind, labels);
        const createdAt = remoteTime(remote.created_at, now);
        const id = service.insertItem(
          {
            kind,
            title: remote.title,
            description,
            status,
            req_type:
              kind === 'requirement' ? (labels.some((label) => /nfr|non-functional|performance|security/i.test(label)) ? 'non_functional' : 'functional') : null,
            asked_by: null,
            source: remote.url,
            recorded_via: importCtx.via,
            tags: labels,
            assignee: remote.assignees?.[0] ?? null,
            milestone: remote.milestone ?? null,
            external_ref: externalRef,
            external_url: remote.url,
            external_state: remote.state,
            external_synced_at: now,
            delivered_at: status === 'done' || status === 'implemented' ? now : null,
            created_at: createdAt,
            updated_at: now,
            status_changed_at: now,
          },
          importCtx,
          [],
          'import',
        );
        result.created.push(id);
        createdIds.push(id);
        continue;
      }

      const row = getRow(db, String(existing.id))!;
      const current = toItem(row);
      const incoming: Partial<Item> = {
        title: remote.title,
        description,
        tags: labels,
        assignee: remote.assignees?.[0] ?? null,
        milestone: remote.milestone ?? null,
        external_url: remote.url,
      };
      const changes = (Object.keys(incoming) as (keyof Item)[]).filter(
        (field) => JSON.stringify(current[field] ?? null) !== JSON.stringify(incoming[field] ?? null),
      );
      const stateChanged = current.external_state !== remote.state;
      if (changes.length === 0 && !stateChanged) {
        db.prepare('UPDATE items SET external_synced_at = ? WHERE rid = ?').run(now, row.rid);
        result.unchanged.push(row.id);
        continue;
      }
      const sets: string[] = ['external_synced_at = ?', 'updated_at = ?'];
      const params: (string | number | null)[] = [now, now];
      for (const field of changes) {
        const value = incoming[field];
        sets.push(`${field} = ?`);
        params.push(columnValue(value));
        service.addEvent(row.id, importCtx, now, 'update', field, current[field], value);
      }
      if (stateChanged) {
        sets.push('external_state = ?');
        params.push(remote.state);
        const status = remote.state === 'closed' ? closedStatus(row.kind) : openStatus(row.kind, []);
        if (status !== current.status) {
          sets.push('status = ?', 'status_changed_at = ?');
          params.push(status, now);
          const delivered = status === 'done' || status === 'implemented';
          if (delivered && !current.delivered_at) {
            sets.push('delivered_at = ?');
            params.push(now);
          } else if (!delivered && current.delivered_at) {
            sets.push('delivered_at = NULL');
          }
          service.addEvent(row.id, importCtx, now, 'status', 'status', current.status, status);
        }
      }
      db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE rid = ?`).run(...params, row.rid);
      if (changes.some((field) => field === 'title' || field === 'description' || field === 'tags')) {
        writeFts(db, row.rid, toItem(getRow(db, row.id)!));
      }
      result.updated.push(row.id);
    }

    // Parents are resolved after all upserts so a parent may appear anywhere in the batch (or a previous import).
    for (const remote of input.items) {
      if (!remote.parent_external_id) continue;
      const child = db.prepare('SELECT * FROM items WHERE external_ref = ?').get(refOf(remote.external_id));
      const parent = db.prepare('SELECT id, kind FROM items WHERE external_ref = ?').get(refOf(remote.parent_external_id));
      if (!child) continue;
      const childId = String(child.id);
      const childKind = child.kind as Kind;
      if (!parent) {
        result.warnings.push(`${childId}: parent ${remote.parent_external_id} is not imported; parent left unset.`);
        continue;
      }
      const parentId = String(parent.id);
      if (!PARENT_KINDS[childKind].includes(parent.kind as Kind)) {
        result.warnings.push(`${childId}: a ${childKind} cannot have a ${String(parent.kind)} parent (${parentId}); parent left unset.`);
        continue;
      }
      if (child.parent_id === parentId) continue;
      if (child.parent_id !== null) {
        result.warnings.push(`${childId}: keeps its local parent ${String(child.parent_id)} (remote parent ${parentId} ignored).`);
        continue;
      }
      db.prepare('UPDATE items SET parent_id = ?, updated_at = ? WHERE id = ?').run(parentId, now, childId);
      service.addEvent(childId, importCtx, now, 'update', 'parent_id', null, parentId);
      const unchangedIndex = result.unchanged.indexOf(childId);
      if (unchangedIndex >= 0) {
        result.unchanged.splice(unchangedIndex, 1);
        result.updated.push(childId);
      }
    }
    service.setMeta(`last_import:${source}:${input.repo}`, now);
  });

  for (const id of createdIds) {
    const item = service.getItem(id).item;
    const similar = await service.findSimilar(`${item.title}\n${item.description}`, { excludeImported: true });
    const matches = similar.matches.filter(
      (match): match is typeof match & { similarity: number } =>
        match.similarity !== null && (match.match === 'duplicate' || match.match === 'related'),
    );
    if (matches.length > 0) {
      result.possible_duplicates.push({ id, similar_to: matches.map((match) => ({ id: match.id, similarity: match.similarity })) });
    }
  }
  result.last_import_at = now;
  return result;
}

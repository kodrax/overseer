import type { Database } from './db.js';
import type { BugDetails, Item, Kind, Priority, ReqType } from './schema.js';

/** Raw `items` row as stored (JSON columns serialized, `in_backlog` 0/1). */
export interface ItemRow {
  rid: number;
  id: string;
  kind: Kind;
  title: string;
  description: string;
  status: string;
  priority: Priority;
  req_type: ReqType | null;
  nfr_category: string | null;
  rationale: string | null;
  acceptance_criteria: string;
  fit_criterion: string | null;
  verification_method: string | null;
  asked_by: string | null;
  source: string | null;
  recorded_via: string;
  in_backlog: number;
  parent_id: string | null;
  assignee: string | null;
  estimate: number | null;
  milestone: string | null;
  severity: string | null;
  bug_details: string | null;
  component: string | null;
  tags: string;
  code_refs: string;
  external_ref: string | null;
  external_url: string | null;
  external_state: string | null;
  external_synced_at: string | null;
  delivered_at: string | null;
  delivered_in: string | null;
  created_at: string;
  updated_at: string;
  status_changed_at: string;
}

/** Columns holding JSON text. */
export const JSON_COLUMNS = ['acceptance_criteria', 'tags', 'code_refs', 'bug_details'] as const;

export function toItem(row: ItemRow): Item {
  const { rid: _rid, ...columns } = row;
  return {
    ...columns,
    acceptance_criteria: JSON.parse(row.acceptance_criteria) as string[],
    in_backlog: row.in_backlog === 1,
    bug_details: row.bug_details === null ? null : (JSON.parse(row.bug_details) as BugDetails),
    tags: JSON.parse(row.tags) as string[],
    code_refs: JSON.parse(row.code_refs) as string[],
  };
}

export function getRow(db: Database, id: string): ItemRow | undefined {
  // Rows come from our own schema; the cast only restores the column types SQLite erases.
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
  return row;
}

export function allRows(db: Database, where = '', params: (string | number)[] = []): ItemRow[] {
  const rows = db.prepare(`SELECT * FROM items ${where}`).all(...params) as unknown as ItemRow[];
  return rows;
}

/** Full-text body: description + rationale + AC + fit criterion + tags + component. */
export function ftsBody(item: Pick<Item, 'description' | 'rationale' | 'acceptance_criteria' | 'fit_criterion' | 'tags' | 'component'>): string {
  return [item.description, item.rationale, ...item.acceptance_criteria, item.fit_criterion, ...item.tags, item.component]
    .filter((part): part is string => Boolean(part))
    .join('\n');
}

export function writeFts(db: Database, rid: number, item: Parameters<typeof ftsBody>[0] & { title: string }): void {
  db.prepare('DELETE FROM items_fts WHERE rowid = ?').run(rid);
  db.prepare('INSERT INTO items_fts(rowid, title, body) VALUES (?, ?, ?)').run(rid, item.title, ftsBody(item));
}

/** Event value encoding: strings verbatim, numbers/booleans stringified, arrays/objects as JSON, null kept. */
export function eventValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Column value encoding for writes. */
export function columnValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number') return value;
  return JSON.stringify(value);
}

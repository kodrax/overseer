import type { Database } from './db.js';
import { ID_PREFIX, KINDS, type Kind } from './schema.js';

const KIND_BY_PREFIX: Record<string, Kind> = Object.fromEntries(KINDS.map((kind) => [ID_PREFIX[kind], kind]));

/** SQL ORDER BY fragment for "ID ascending": prefix alphabetically, then the number numerically. */
export const ORDER_BY_ID = "substr(id, 1, instr(id, '-') - 1), CAST(substr(id, instr(id, '-') + 1) AS INTEGER)";

/** Allocates the next `<PREFIX>-NNNN` for `kind`; MUST run inside the create transaction. */
export function allocateId(db: Database, kind: Kind): string {
  db.prepare('INSERT INTO counters(kind, next_seq) VALUES (?, 1) ON CONFLICT(kind) DO NOTHING').run(kind);
  const row = db.prepare('UPDATE counters SET next_seq = next_seq + 1 WHERE kind = ? RETURNING next_seq - 1 AS seq').get(kind);
  return `${ID_PREFIX[kind]}-${String(row!.seq).padStart(4, '0')}`;
}

/** Accepts `req-7`, `REQ-0007`, ` us-12 ` → canonical `REQ-0007` / `US-0012`; anything else is returned trimmed. */
export function normalizeId(id: string): string {
  const trimmed = id.trim();
  const match = /^([A-Za-z]+)-(\d+)$/.exec(trimmed);
  if (!match) return trimmed;
  const prefix = match[1]!.toUpperCase();
  return prefix in KIND_BY_PREFIX ? `${prefix}-${match[2]!.padStart(4, '0')}` : trimmed;
}

/** Sort comparator matching ORDER_BY_ID. */
export function compareIds(a: string, b: string): number {
  const [pa = '', na = ''] = a.split('-');
  const [pb = '', nb = ''] = b.split('-');
  return pa === pb ? Number(na) - Number(nb) : pa < pb ? -1 : 1;
}

import { z } from 'zod';
import type { Connections } from './connections.js';
import { type Database, tx } from './db.js';
import { OverseerError } from './errors.js';
import { KINDS, PRIORITIES, parseInput, STATUSES } from './schema.js';

/** What a mapping translates: an item's kind, status or priority. */
export const MAPPING_DIMENSIONS = ['kind', 'status', 'priority'] as const;
export type MappingDimension = (typeof MAPPING_DIMENSIONS)[number];

/** Local values each dimension maps, in display order; status is the union of every kind's statuses. */
export const MAPPING_LOCAL_VALUES: Record<MappingDimension, readonly string[]> = {
  kind: KINDS,
  status: [...new Set(KINDS.flatMap((kind) => STATUSES[kind]))],
  priority: PRIORITIES,
};

const MAX_REMOTE_VALUE = 255;
const remoteValueSchema = z.string().trim().min(1).max(MAX_REMOTE_VALUE);

/** Remote label or state per local value of one dimension; null when unmapped. */
export type DimensionMapping = Record<string, string | null>;

/** A connection's whole mapping: every dimension with every local value, unmapped ones null. */
export interface ConnectionMapping {
  connection_id: number;
  mapping: Record<MappingDimension, DimensionMapping>;
}

/** One stored pair and the remote value it replaced (null when the local value was unmapped). */
export interface MappingChange {
  connection_id: number;
  dimension: MappingDimension;
  local_value: string;
  remote_value: string;
  previous_value: string | null;
}

export interface MappingPair {
  dimension: string;
  local_value: string;
  remote_value: string;
}

interface MappingRow {
  dimension: MappingDimension;
  local_value: string;
  remote_value: string;
}

/** A strict object over `shape`, all keys optional; an unknown key or a non-object names the valid keys. */
function strictObject<S extends Record<string, z.ZodType>>(shape: S, label: string) {
  const keys = Object.keys(shape).join(', ');
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code === 'unrecognized_keys') return `unknown ${label} ${issue.keys.map((key) => `"${key}"`).join(', ')}; valid: ${keys}`;
      if (issue.code === 'invalid_type') return `expected an object keyed by ${label} (${keys})`;
      return undefined;
    },
  });
}

const dimensionSchema = (dimension: MappingDimension) =>
  strictObject(Object.fromEntries(MAPPING_LOCAL_VALUES[dimension].map((local) => [local, remoteValueSchema.nullable().optional()])), `${dimension} value`).optional();

/**
 * A whole mapping: `{"kind": {<local value>: <remote value>|null}, "status": {…}, "priority": {…}}`. A missing
 * dimension, a missing local value or null leaves that local value unmapped.
 */
const mappingSchema = strictObject({ kind: dimensionSchema('kind'), status: dimensionSchema('status'), priority: dimensionSchema('priority') }, 'dimension');

/**
 * Each connection's kind/status/priority mapping onto the repository's labels or states (the
 * `connection_mappings` rows): one remote value per connection, dimension and local value. Only the local database
 * is read and written; nothing goes into item history. An unknown connection gives NOT_FOUND before anything else.
 */
export class ConnectionMappings {
  readonly db: Database;
  readonly connections: Connections;

  constructor(db: Database, connections: Connections) {
    this.db = db;
    this.connections = connections;
  }

  /** The connection's mapping with every local value of each dimension; unmapped values are null. */
  get(connectionId: number | string): ConnectionMapping {
    const connection = this.connections.require(connectionId);
    const unmapped = (dimension: MappingDimension): DimensionMapping => Object.fromEntries(MAPPING_LOCAL_VALUES[dimension].map((local) => [local, null]));
    const mapping = { kind: unmapped('kind'), status: unmapped('status'), priority: unmapped('priority') };
    const rows = this.db
      .prepare('SELECT dimension, local_value, remote_value FROM connection_mappings WHERE connection_id = ?')
      .all(connection.id) as unknown as MappingRow[];
    for (const row of rows) {
      if (row.local_value in mapping[row.dimension]) mapping[row.dimension][row.local_value] = row.remote_value;
    }
    return { connection_id: connection.id, mapping };
  }

  /** Stores one pair, replacing the local value's earlier remote value. */
  set(connectionId: number | string, pair: MappingPair): MappingChange {
    return tx(this.db, () => {
      const connection = this.connections.require(connectionId);
      const dimension = MAPPING_DIMENSIONS.find((candidate) => candidate === pair.dimension);
      if (dimension === undefined) {
        throw new OverseerError('INVALID_INPUT', `Invalid dimension "${pair.dimension}"; valid: ${MAPPING_DIMENSIONS.join(', ')}.`);
      }
      const locals = MAPPING_LOCAL_VALUES[dimension];
      if (!locals.includes(pair.local_value)) {
        throw new OverseerError('INVALID_INPUT', `Invalid ${dimension} value "${pair.local_value}"; valid: ${locals.join(', ')}.`);
      }
      const remote = remoteValueSchema.safeParse(pair.remote_value).data;
      if (remote === undefined) throw new OverseerError('INVALID_INPUT', `Remote value must hold 1 to ${MAX_REMOTE_VALUE} characters.`);
      const previous = this.db
        .prepare('SELECT remote_value FROM connection_mappings WHERE connection_id = ? AND dimension = ? AND local_value = ?')
        .get(connection.id, dimension, pair.local_value) as { remote_value: string } | undefined;
      this.db
        .prepare(
          `INSERT INTO connection_mappings(connection_id, dimension, local_value, remote_value) VALUES (?, ?, ?, ?)
           ON CONFLICT(connection_id, dimension, local_value) DO UPDATE SET remote_value = excluded.remote_value`,
        )
        .run(connection.id, dimension, pair.local_value, remote);
      return { connection_id: connection.id, dimension, local_value: pair.local_value, remote_value: remote, previous_value: previous?.remote_value ?? null };
    });
  }

  /**
   * Replaces the connection's whole mapping with `input` (the `mapping` object `get` returns), all or nothing: every
   * problem in it gives one INVALID_INPUT and nothing is written.
   */
  replace(connectionId: number | string, input: unknown): ConnectionMapping {
    return tx(this.db, () => {
      const connection = this.connections.require(connectionId);
      const mapping = parseInput(mappingSchema, input);
      this.db.prepare('DELETE FROM connection_mappings WHERE connection_id = ?').run(connection.id);
      const insert = this.db.prepare('INSERT INTO connection_mappings(connection_id, dimension, local_value, remote_value) VALUES (?, ?, ?, ?)');
      for (const dimension of MAPPING_DIMENSIONS) {
        for (const [local, remote] of Object.entries(mapping[dimension] ?? {})) {
          if (typeof remote === 'string') insert.run(connection.id, dimension, local, remote);
        }
      }
      return this.get(connection.id);
    });
  }
}

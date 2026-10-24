import type { Command } from 'commander';
import { CONNECTION_HOSTS, type Connection, type SourceOfTruth, type SyncStatus } from '../../core/connections.js';
import { type ConnectionMapping, MAPPING_DIMENSIONS, MAPPING_LOCAL_VALUES } from '../../core/mappings.js';
import { detectRemotes } from '../../core/remotes.js';
import { IMPORT_SOURCES } from '../../core/schema.js';
import { confirmSync } from '../../core/sync-confirm.js';
import { planSync, type SyncPlan } from '../../core/sync-plan.js';
import { pullSync, type SyncPullResult } from '../../core/sync-pull.js';
import { startSync } from '../../core/sync-start.js';
import { bundleKeys, inspectTracking, type TrackingSetup } from '../../core/tracking.js';
import { assertProjectEnabled } from '../../core/user-config.js';
import { fields, table } from '../format.js';
import { parseJsonInput, readInput } from '../input.js';
import { oneOf } from '../options.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

const INSPECT_HELP = `
The bundle is one JSON object keyed by MCP tool name; each value is that tool's raw answer (the JSON, or its text
as a string), or an array of answers from several calls (pages, several issues or work item types). Example:
  {"list_label": {"labels": [...], "totalCount": 2, "pageInfo": {...}}, "list_issue_types": [...]}
A part no tool in the bundle answers is null (unknown, not empty) with a warning naming the tool to add.

${IMPORT_SOURCES.map((source) => `${source}: ${bundleKeys(source)}`).join('\n')}
`;

/** `fields` lines for a setup: names comma-separated, `none` for an empty list, `unknown` for null. */
function formatSetup(setup: TrackingSetup): string {
  const names = (values: string[] | null) => (values === null ? 'unknown' : values.length > 0 ? values.join(', ') : 'none');
  return [
    fields([
      ['labels', names(setup.labels)],
      ['issue_types', names(setup.issue_types)],
      ['milestones', names(setup.milestones)],
      ['sub_issues', setup.sub_issues ?? 'unknown'],
      ['boards', names(setup.boards)],
    ]),
    ...setup.warnings.map((warning) => `warning: ${warning}`),
  ].join('\n');
}

const AUTO_SYNC_STATES = ['on', 'off'] as const;

function formatConnection(connection: Connection): string {
  return fields([
    ['id', connection.id],
    ['host', connection.host],
    ['repository', connection.repository],
    ['mcp_server', connection.mcp_server ?? '-'],
    ['auto_sync', connection.auto_sync ? 'on' : 'off'],
    ['last_sync_cursor', connection.last_sync_cursor ?? '-'],
    ['sync_started_at', connection.sync_started_at ?? '-'],
    ['created_at', connection.created_at],
  ]);
}

/** `source_of_truth: board`, or the connection id with its host and repository lines, then why. */
function formatSourceOfTruth(source: SourceOfTruth): string {
  return fields([
    ['source_of_truth', source.source_of_truth],
    ['host', source.host],
    ['repository', source.repository],
    ['reason', source.reason],
  ]);
}

/**
 * Connections table (or `No connections.`), the source of truth with its host and repository, then one table per
 * connection whose latest pull or confirm overwrote fields.
 */
function formatStatus({ connections, source_of_truth }: SyncStatus): string {
  return [
    connections.length === 0
      ? 'No connections.'
      : table(
          ['Id', 'Host', 'Repository', 'MCP server', 'Auto-sync', 'Last sync', 'Sync started', 'Pending outbox'],
          connections.map((connection) => [
            connection.id,
            connection.host,
            connection.repository,
            connection.mcp_server,
            connection.auto_sync ? 'on' : 'off',
            connection.last_sync_cursor ?? 'never',
            connection.sync_started_at ?? 'never',
            connection.pending_outbox,
          ]),
        ),
    source_of_truth === 'board'
      ? 'Source of truth: board'
      : `Source of truth: connection ${source_of_truth.id} (${source_of_truth.host} ${source_of_truth.repository})`,
    ...connections
      .filter((connection) => connection.overwritten.length > 0)
      .map(
        (connection) =>
          `\nOverwritten by the latest pull and confirm of connection ${connection.id} (${connection.host} ${connection.repository}):\n${table(
            ['Step', 'Item', 'Issue', 'Field', 'Overwritten', 'Winner', 'Value', 'At'],
            connection.overwritten.map((entry) => [entry.step, entry.item_id, entry.external_ref, entry.field, planValue(entry.overwritten), entry.winner, planValue(entry.value), entry.at]),
          )}`,
      ),
  ].join('\n');
}

const MAPPING_HELP = `
The mapping file is one JSON object keyed by dimension; each one maps local values to the repository's label, issue
type or state. A missing dimension, a missing local value or null leaves the value unmapped. Example:
  {"kind": {"task": "Task", "bug": "Bug", "story": "Feature"}, "status": {"done": "closed"}, "priority": {"must": "P1"}}
The "mapping" object of sync mapping <connection> --json is accepted as is.

${MAPPING_DIMENSIONS.map((dimension) => `${dimension}: ${MAPPING_LOCAL_VALUES[dimension].join(', ')}`).join('\n')}
`;

/** One row per dimension and local value; unmapped values show `(unmapped)`. */
function formatMapping({ mapping }: ConnectionMapping): string {
  return table(
    ['Dimension', 'Local', 'Remote'],
    MAPPING_DIMENSIONS.flatMap((dimension) => Object.entries(mapping[dimension]).map(([local, remote]) => [dimension, local, remote ?? '(unmapped)'])),
  );
}

const PLAN_HELP = `
The listing is the raw answer of the connection's MCP server: a GitHub list_issues response ({"issues": [...]}) or an
array of GitHub issues, or a GitLab list_work_items response ({"items": [...], "pageInfo": {...}}), get_work_item
response or array of work items. Join the pages into one array to plan against every issue. Nothing is written.
`;

const START_HELP = `
The listing is the raw answer of the connection's MCP server, as for sync plan; join every page into one array.
An empty repository is seeded from the board: every item of every kind and status without an issue on the connection
gets one pending create in its outbox (whatever the auto-sync flag); then run sync plan, push the creates and sync
confirm. A repository with issues comes to the board instead: its issues are created or linked as import does, nothing
is queued, and sync plan never pushes a create for an item that existed before the start (its entries go to ack);
items created later get create pushes as usual. Either way the connection records its sync start time, once: a second
start gives CONFLICT.
`;

const CONFIRM_HELP = `
Each result is one push op of sync plan as the MCP server answered it:
  [{"seqs": [12], "item_id": "TASK-0001", "external_id": "owner/repo#34", "url": "https://…", "state": "open",
    "fields": ["title", "body", "labels", "state", "assignee", "milestone"], "overwritten": {"title": "Issue title"}}]
"fields" (optional) is the plan op's fields; the snapshot gets the item's values for them. "overwritten" (optional)
is the plan op's overwritten, as is: each field gets an overwrite event in the item's history with the issue's value
the push replaced, and sync status lists it. Any invalid result gives INVALID_INPUT and nothing is written.
`;

/** A conflicting or overwritten value in the text plan: JSON, cut to 60 characters. */
function planValue(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** Counts line, then a table per non-empty part, an `ack:` line with the seqs to acknowledge and a `warning:` line per warning. */
function formatPlan(connectionId: number, { push, pull, conflicts, ack, overwritten, warnings }: SyncPlan): string {
  const parts = [
    `Sync plan for connection ${connectionId}: ${push.length} push, ${pull.length} pull, ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}, ${overwritten.length} overwritten.`,
  ];
  if (push.length > 0) {
    parts.push(`\nPush:\n${table(['Op', 'Item', 'Issue', 'Seq', 'Fields'], push.map((op) => [op.op, op.item_id, op.external_ref, op.seq, op.fields.join(', ')]))}`);
  }
  if (pull.length > 0) {
    parts.push(`\nPull:\n${table(['Op', 'Issue', 'Item', 'Fields'], pull.map((op) => [op.op, op.external_ref, op.item_id, op.fields.join(', ')]))}`);
  }
  if (conflicts.length > 0) {
    parts.push(
      `\nConflicts:\n${table(
        ['Item', 'Issue', 'Field', 'Local', 'Remote', 'Snapshot'],
        conflicts.map((conflict) => [conflict.item_id, conflict.external_ref, conflict.field, planValue(conflict.local), planValue(conflict.remote), planValue(conflict.snapshot)]),
      )}`,
    );
  }
  if (overwritten.length > 0) {
    parts.push(
      `\nOverwritten:\n${table(
        ['Item', 'Issue', 'Field', 'Winner', 'Value', 'Overwritten'],
        overwritten.map((entry) => [entry.item_id, entry.external_ref, entry.field, entry.winner, planValue(entry.value), planValue(entry.overwritten)]),
      )}`,
    );
  }
  if (ack.length > 0) parts.push(`\nack: ${ack.join(', ')} (nothing to push; acknowledge with sync outbox ack)`);
  if (warnings.length > 0) parts.push(`\n${warnings.map((warning) => `warning: ${warning}`).join('\n')}`);
  return parts.join('\n');
}

const PULL_HELP = `
The listing is the raw answer of the connection's MCP server, as for sync plan; join every page into one array.
Only the plan's pull operations are applied, in one transaction, with events via sync:<host>; the changes are queued
in the outbox of the other connections, not this one. A local edit the issue's value overwrites (this connection is
the source of truth) also gets an overwrite event naming the field, the local value and the issue's, and sync status
lists it. Applying the same listing again changes nothing.
`;

/** Counts line, then a table of created and updated items, the conflicts left untouched and a `warning:` line per warning. */
function formatPull(connectionId: number, { created, updated, conflicts, warnings }: SyncPullResult): string {
  const parts = [`Sync pull for connection ${connectionId}: ${created.length} created, ${updated.length} updated, ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} left untouched.`];
  if (created.length + updated.length > 0) {
    parts.push(
      `\n${table(
        ['Op', 'Issue', 'Item', 'Fields'],
        [...created.map((entry) => ['create', entry.external_ref, entry.item_id, '-']), ...updated.map((entry) => ['update', entry.external_ref, entry.item_id, entry.fields.join(', ')])],
      )}`,
    );
  }
  if (conflicts.length > 0) {
    parts.push(
      `\nConflicts:\n${table(
        ['Item', 'Issue', 'Field', 'Local', 'Remote', 'Snapshot'],
        conflicts.map((conflict) => [conflict.item_id, conflict.external_ref, conflict.field, planValue(conflict.local), planValue(conflict.remote), planValue(conflict.snapshot)]),
      )}`,
    );
  }
  if (warnings.length > 0) parts.push(`\n${warnings.map((warning) => `warning: ${warning}`).join('\n')}`);
  return parts.join('\n');
}

/** `overseer sync …`: GitHub and GitLab repository connections. Each subcommand registers on the `sync` group. */
export function registerSyncCommands(program: Command, rt: CliRuntime): void {
  const sync = program.command('sync').description('GitHub and GitLab repositories of this project');

  sync
    .command('remotes')
    .description('GitHub, GitLab and other repositories named by every git remote (local git config only, no network)')
    .option('--json', 'print JSON')
    .action((options: { json?: boolean }, command: Command) => {
      const root = rt.projectRoot(command.optsWithGlobals<GlobalOptions>().project);
      assertProjectEnabled(root, rt.env);
      rt.emit(options.json, detectRemotes(root), (repositories) =>
        repositories.length === 0
          ? 'No git remotes.'
          : table(
              ['Host', 'Hostname', 'Repository', 'Remotes'],
              repositories.map((repository) => [
                repository.host,
                repository.hostname,
                repository.repository,
                repository.remotes.map((remote) => `${remote.name} ${remote.url}`).join(', '),
              ]),
            ),
      );
    });

  sync
    .command('inspect')
    .description(
      "summarise a repository's tracking setup (labels, issue types, milestones, sub-issue support, boards) from a bundle of raw GitHub or GitLab MCP responses in a file or stdin (-); no network",
    )
    .argument('<file>', 'JSON bundle file, or - for stdin')
    .requiredOption('--source <source>', `MCP server the responses come from: ${IMPORT_SOURCES.join(' | ')}`)
    .option('--json', 'print JSON')
    .addHelpText('after', INSPECT_HELP)
    .action(async (file: string, options: { source: string; json?: boolean }, command: Command) => {
      const root = rt.projectRoot(command.optsWithGlobals<GlobalOptions>().project);
      assertProjectEnabled(root, rt.env);
      const source = oneOf(IMPORT_SOURCES, options.source, 'source');
      rt.emit(options.json, inspectTracking(parseJsonInput(await readInput(rt, file, 'Bundle'), 'Bundle'), source), formatSetup);
    });

  sync
    .command('status')
    .description('each connection with its pending outbox entries and the fields its latest pull and confirm overwrote, and the source of truth (local database only, no network)')
    .option('--json', 'print JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      await rt.withService(command, 'read', (service) => {
        rt.emit(options.json, service.connections.status(), formatStatus);
      });
    });

  sync
    .command('connections')
    .description('repository connections of this project, with their MCP server and auto-sync flag (local database only, no network)')
    .option('--json', 'print JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      await rt.withService(command, 'read', (service) => {
        rt.emit(options.json, service.connections.list(), (connections) =>
          connections.length === 0
            ? 'No connections.'
            : table(
                ['Id', 'Host', 'Repository', 'MCP server', 'Auto-sync', 'Last sync', 'Sync started'],
                connections.map((connection) => [
                  connection.id,
                  connection.host,
                  connection.repository,
                  connection.mcp_server,
                  connection.auto_sync ? 'on' : 'off',
                  connection.last_sync_cursor,
                  connection.sync_started_at,
                ]),
              ),
        );
      });
    });

  const connection = sync.command('connection').description('add, change or remove a repository connection (local database only, no network)');
  connection
    .command('add')
    .description('connect a GitHub or GitLab repository to this project, with auto-sync on')
    .requiredOption('--host <host>', `hosting service: ${CONNECTION_HOSTS.join(' | ')}`)
    .requiredOption('--repo <repo>', 'owner/repo on GitHub, group/project or group/subgroup/…/project on GitLab')
    .option('--mcp-server <name>', 'harness MCP server that reaches the repository')
    .option('--json', 'print JSON')
    .action(async (options: { host: string; repo: string; mcpServer?: string; json?: boolean }, command: Command) => {
      await rt.withService(command, 'write', (service) => {
        const added = service.connections.add({
          host: options.host,
          repository: options.repo,
          ...(options.mcpServer !== undefined ? { mcp_server: options.mcpServer } : {}),
        });
        rt.emit(options.json, added, formatConnection);
      });
    });
  connection
    .command('set')
    .description("change a connection's auto-sync flag or MCP server")
    .argument('<id>', 'connection id (see sync connections)')
    .option('--auto-sync <state>', `push local changes without an explicit sync: ${AUTO_SYNC_STATES.join(' | ')}`)
    .option('--mcp-server <name>', 'harness MCP server that reaches the repository')
    .option('--json', 'print JSON')
    .action(async (id: string, options: { autoSync?: string; mcpServer?: string; json?: boolean }, command: Command) => {
      await rt.withService(command, 'write', (service) => {
        const changed = service.connections.set(id, {
          ...(options.autoSync !== undefined ? { auto_sync: oneOf(AUTO_SYNC_STATES, options.autoSync, 'auto-sync state') === 'on' } : {}),
          ...(options.mcpServer !== undefined ? { mcp_server: options.mcpServer } : {}),
        });
        rt.emit(options.json, changed, formatConnection);
      });
    });
  connection
    .command('remove')
    .description('delete a connection with its remote refs, mappings and pending outbox rows; a removed source of truth goes back to the board')
    .argument('<id>', 'connection id (see sync connections)')
    .option('--json', 'print JSON')
    .action(async (id: string, options: { json?: boolean }, command: Command) => {
      await rt.withService(command, 'write', (service) => {
        rt.emit(
          options.json,
          service.connections.remove(id),
          ({ removed, remote_refs, mappings, outbox, source_of_truth_reset }) =>
            [
              `Removed connection ${removed.id} (${removed.host} ${removed.repository}) with ${remote_refs} remote refs, ${mappings} mappings and ${outbox} outbox rows.`,
              ...(source_of_truth_reset ? ['Source of truth reset to board.'] : []),
            ].join('\n'),
        );
      });
    });

  sync
    .command('source-of-truth')
    .description('show where synced fields win a conflict and why: the board until sync starts on a connection, then that connection (local database only, no network)')
    .option('--json', 'print JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      await rt.withService(command, 'read', (service) => {
        rt.emit(options.json, service.connections.sourceOfTruth(), formatSourceOfTruth);
      });
    });

  // `--json` is read from optsWithGlobals: commander gives it to `mapping` when it comes after a subcommand's name.
  const mapping = sync
    .command('mapping')
    .description("a connection's kind, status and priority mapping onto the repository's labels, issue types or states (local database only, no network)")
    .argument('<connection>', 'connection id (see sync connections)')
    .option('--json', 'print JSON')
    .addHelpText('after', MAPPING_HELP)
    .action(async (connectionId: string, _options: unknown, command: Command) => {
      await rt.withService(command, 'read', (service, { json }) => {
        rt.emit(json, service.mappings.get(connectionId), formatMapping);
      });
    });
  mapping
    .command('set')
    .description('map one local kind, status or priority value to a remote label, issue type or state, replacing its earlier remote value')
    .argument('<connection>', 'connection id (see sync connections)')
    .requiredOption('--dimension <dimension>', MAPPING_DIMENSIONS.join(' | '))
    .requiredOption('--local <value>', 'local value of the dimension (see sync mapping --help)')
    .requiredOption('--remote <value>', 'label, issue type or state in the repository')
    .option('--json', 'print JSON')
    .action(async (connectionId: string, options: { dimension: string; local: string; remote: string }, command: Command) => {
      await rt.withService(command, 'write', (service, { json }) => {
        const change = service.mappings.set(connectionId, { dimension: options.dimension, local_value: options.local, remote_value: options.remote });
        rt.emit(
          json,
          change,
          ({ connection_id, dimension, local_value, remote_value, previous_value }) =>
            `Mapped ${dimension} ${local_value} to "${remote_value}" on connection ${connection_id}${previous_value === null ? '' : ` (was "${previous_value}")`}.`,
        );
      });
    });
  mapping
    .command('import')
    .description("replace a connection's whole mapping with a JSON mapping file or stdin (-), all or nothing")
    .argument('<connection>', 'connection id (see sync connections)')
    .argument('<file>', 'JSON mapping file, or - for stdin')
    .option('--json', 'print JSON')
    .addHelpText('after', MAPPING_HELP)
    .action(async (connectionId: string, file: string, _options: unknown, command: Command) => {
      await rt.withService(command, 'write', async (service, { json }) => {
        // An unknown connection gives NOT_FOUND before the file is read.
        service.connections.require(connectionId);
        const replaced = service.mappings.replace(connectionId, parseJsonInput(await readInput(rt, file, 'Mapping'), 'Mapping'));
        rt.emit(json, replaced, (result) => `Replaced the mapping of connection ${result.connection_id}.\n${formatMapping(result)}`);
      });
    });

  // `--json` is read from optsWithGlobals: commander gives it to `outbox` when it comes after `ack`.
  const outbox = sync
    .command('outbox')
    .description('pending local item changes per connection with auto-sync on, waiting for a push (local database only, no network)')
    .argument('[connection]', 'connection id (see sync connections); all connections when omitted')
    .option('--json', 'print JSON')
    .action(async (connectionId: string | undefined, _options: unknown, command: Command) => {
      await rt.withService(command, 'read', (service, { json }) => {
        rt.emit(json, service.outbox.list(connectionId), (entries) =>
          entries.length === 0
            ? 'No pending outbox entries.'
            : table(
                ['Seq', 'Connection', 'Item', 'Operation', 'Changed fields', 'Changed at'],
                entries.map((entry) => [entry.seq, entry.connection_id, entry.item_id, entry.operation, entry.changed_fields.join(', '), entry.created_at]),
              ),
        );
      });
    });
  outbox
    .command('ack')
    .description('remove outbox entries once their push is confirmed; an unknown seq gives NOT_FOUND and removes nothing')
    .argument('<seq...>', 'seq of each pushed entry (see sync outbox)')
    .option('--json', 'print JSON')
    .action(async (seqs: string[], _options: unknown, command: Command) => {
      await rt.withService(command, 'write', (service, { json }) => {
        rt.emit(json, service.outbox.ack(seqs), ({ acked }) => `Removed ${acked.length} outbox ${acked.length === 1 ? 'entry' : 'entries'}: ${acked.join(', ')}.`);
      });
    });

  sync
    .command('start')
    .description(
      "start syncing a connection from a raw MCP listing of its issues in a file or stdin (-): an empty repository is seeded from the board (a create queued for every item without an issue there), a repository with issues comes to the board as an import (nothing queued); records the sync start time; no network",
    )
    .argument('<connection>', 'connection id (see sync connections)')
    .argument('<file>', 'JSON listing file, or - for stdin')
    .option('--json', 'print JSON')
    .addHelpText('after', START_HELP)
    .action(async (connectionId: string, file: string, options: { json?: boolean }, command: Command) => {
      await rt.withService(command, 'write', async (service) => {
        // An unknown connection gives NOT_FOUND before the file is read.
        const connection = service.connections.require(connectionId);
        const started = startSync(service, connection.id, parseJsonInput(await readInput(rt, file, 'Listing'), 'Listing'), rt.ctx);
        rt.emit(options.json, started, ({ started_at, from, queued, by_kind, created, linked, warnings, next }) =>
          [
            from === 'board'
              ? `Started sync of connection ${connection.id} (${connection.host} ${connection.repository}) at ${started_at}: queued ${queued} create${queued === 1 ? '' : 's'} (${Object.entries(
                  by_kind,
                )
                  .map(([kind, count]) => `${kind} ${count}`)
                  .join(', ')}).`
              : `Started sync of connection ${connection.id} (${connection.host} ${connection.repository}) at ${started_at} from its issues: created ${created} item${created === 1 ? '' : 's'}, linked ${linked}; queued nothing.`,
            ...warnings.map((warning) => `warning: ${warning}`),
            `Next: ${next}`,
          ].join('\n'),
        );
      });
    });

  sync
    .command('plan')
    .description(
      "the push, pull and conflict operations that sync a connection, from its outbox, remote refs and mapping and a raw MCP listing of its issues in a file or stdin (-); writes nothing, no network",
    )
    .argument('<connection>', 'connection id (see sync connections)')
    .argument('<file>', 'JSON listing file, or - for stdin')
    .option('--json', 'print JSON')
    .addHelpText('after', PLAN_HELP)
    .action(async (connectionId: string, file: string, options: { json?: boolean }, command: Command) => {
      await rt.withService(command, 'read', async (service) => {
        // An unknown connection gives NOT_FOUND before the file is read.
        const connection = service.connections.require(connectionId);
        const plan = planSync(service, connection.id, parseJsonInput(await readInput(rt, file, 'Listing'), 'Listing'));
        rt.emit(options.json, plan, (value) => formatPlan(connection.id, value));
      });
    });

  sync
    .command('pull')
    .description(
      "apply the pull operations of a connection's sync plan (the same computation as sync plan) from a raw MCP listing of its issues in a file or stdin (-): create items for new issues, apply remote changes without a pending local change, leave conflicts untouched; no network",
    )
    .argument('<connection>', 'connection id (see sync connections)')
    .argument('<file>', 'JSON listing file, or - for stdin')
    .option('--json', 'print JSON')
    .addHelpText('after', PULL_HELP)
    .action(async (connectionId: string, file: string, options: { json?: boolean }, command: Command) => {
      await rt.withService(command, 'write', async (service) => {
        // An unknown connection gives NOT_FOUND before the file is read.
        const connection = service.connections.require(connectionId);
        const pulled = pullSync(service, connection.id, parseJsonInput(await readInput(rt, file, 'Listing'), 'Listing'), rt.ctx);
        rt.emit(options.json, pulled, (value) => formatPull(connection.id, value));
      });
    });

  sync
    .command('confirm')
    .description(
      "record the pushes run for a connection's sync plan from a JSON array of results in a file or stdin (-): remote ref, snapshot of the pushed fields, outbox ack; all or nothing, no network",
    )
    .argument('<connection>', 'connection id (see sync connections)')
    .argument('<file>', 'JSON results file, or - for stdin')
    .option('--json', 'print JSON')
    .addHelpText('after', CONFIRM_HELP)
    .action(async (connectionId: string, file: string, options: { json?: boolean }, command: Command) => {
      await rt.withService(command, 'write', async (service) => {
        // An unknown connection gives NOT_FOUND before the file is read.
        const connection = service.connections.require(connectionId);
        const confirmation = confirmSync(service, connection.id, parseJsonInput(await readInput(rt, file, 'Results'), 'Results'), rt.ctx);
        rt.emit(options.json, confirmation, ({ confirmed, acked }) =>
          [
            ...confirmed.map((push) => `${push.item_id}: ${push.external_id} (${push.state}) ${push.url}`),
            `Confirmed ${confirmed.length} push${confirmed.length === 1 ? '' : 'es'} on connection ${connection.id}; acknowledged outbox ${acked.join(', ')}.`,
          ].join('\n'),
        );
      });
    });
}

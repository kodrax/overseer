import type { Command } from 'commander';
import { CONNECTION_HOSTS, type Connection, type SourceOfTruth, type SyncStatus } from '../../core/connections.js';
import { type ConnectionMapping, MAPPING_DIMENSIONS, MAPPING_LOCAL_VALUES } from '../../core/mappings.js';
import { detectRemotes } from '../../core/remotes.js';
import { IMPORT_SOURCES } from '../../core/schema.js';
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
    ['created_at', connection.created_at],
  ]);
}

/** `source_of_truth: board`, or the connection id with its host and repository lines. */
function formatSourceOfTruth(source: SourceOfTruth): string {
  return fields([
    ['source_of_truth', source.source_of_truth],
    ['host', source.host],
    ['repository', source.repository],
  ]);
}

/** Connections table (or `No connections.`) and the source of truth with its host and repository. */
function formatStatus({ connections, source_of_truth }: SyncStatus): string {
  return [
    connections.length === 0
      ? 'No connections.'
      : table(
          ['Id', 'Host', 'Repository', 'MCP server', 'Auto-sync', 'Last sync', 'Pending outbox'],
          connections.map((connection) => [
            connection.id,
            connection.host,
            connection.repository,
            connection.mcp_server,
            connection.auto_sync ? 'on' : 'off',
            connection.last_sync_cursor ?? 'never',
            connection.pending_outbox,
          ]),
        ),
    source_of_truth === 'board'
      ? 'Source of truth: board'
      : `Source of truth: connection ${source_of_truth.id} (${source_of_truth.host} ${source_of_truth.repository})`,
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
    .description('each connection with its pending outbox entries, and the source of truth (local database only, no network)')
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
                ['Id', 'Host', 'Repository', 'MCP server', 'Auto-sync', 'Last sync'],
                connections.map((connection) => [
                  connection.id,
                  connection.host,
                  connection.repository,
                  connection.mcp_server,
                  connection.auto_sync ? 'on' : 'off',
                  connection.last_sync_cursor,
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

  const sourceOfTruth = sync
    .command('source-of-truth')
    .description('show where synced fields win a conflict: board or a connection (local database only, no network)')
    .option('--json', 'print JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      await rt.withService(command, 'read', (service) => {
        rt.emit(options.json, service.connections.sourceOfTruth(), formatSourceOfTruth);
      });
    });
  sourceOfTruth
    .command('set')
    .description('make the board or a connection the source of truth; connections, remote refs and mappings stay unchanged')
    .argument('<target>', 'board, or a connection id (see sync connections)')
    .option('--json', 'print JSON')
    // `--json` after `set` is parsed by `source-of-truth`, which has the same option; withService sees either.
    .action(async (target: string, _options: { json?: boolean }, command: Command) => {
      await rt.withService(command, 'write', (service, { json }) => {
        rt.emit(json, service.connections.setSourceOfTruth(target), formatSourceOfTruth);
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
}

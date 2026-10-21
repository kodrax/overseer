import type { Command } from 'commander';
import { CONNECTION_HOSTS, type Connection, type SourceOfTruth } from '../../core/connections.js';
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
}

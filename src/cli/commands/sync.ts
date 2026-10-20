import type { Command } from 'commander';
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
}

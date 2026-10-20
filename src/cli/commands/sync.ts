import type { Command } from 'commander';
import { detectRemotes } from '../../core/remotes.js';
import { assertProjectEnabled } from '../../core/user-config.js';
import { table } from '../format.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

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
}

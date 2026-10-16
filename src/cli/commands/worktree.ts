import type { Command } from 'commander';
import { PR_TYPES } from '../../core/pr-draft.js';
import { startWorktree, type WorktreeStartResult } from '../../core/worktree.js';
import type { CliRuntime } from '../runtime.js';

interface StartOptions {
  type?: string;
  slug?: string;
  base?: string;
  setup: boolean;
  json?: boolean;
}

function describeStart(result: WorktreeStartResult): string {
  const lines = [`${result.reused ? 'Reusing' : 'Created'} worktree ${result.path}`, `branch ${result.branch} (base ${result.base})`];
  if (result.setup.ran) lines.push(`setup: ran ${result.setup.command}`);
  else if (!result.reused && result.setup.command !== null) lines.push(`setup: skipped (${result.setup.command})`);
  return lines.join('\n');
}

export function registerWorktreeCommands(program: Command, rt: CliRuntime): void {
  const worktree = program.command('worktree').description('git worktrees for board items');

  worktree
    .command('start')
    .description('create or reuse the worktree and branch of a task or bug, then run the project setup in a new worktree')
    .argument('<id>', 'task or bug id')
    .option('--type <type>', `Conventional Commit type: ${PR_TYPES.join(' | ')} (default: fix for bugs, feat for tasks)`)
    .option('--slug <slug>', 'branch slug, lowercase words joined by hyphens (default: from the item title)')
    .option('--base <branch>', 'branch to start from (default: the base_branch setting)')
    .option('--no-setup', 'skip the setup command (worktree_setup) in a new worktree')
    .option('--json', 'print JSON')
    .action(async (id: string, options: StartOptions, command: Command) => {
      await rt.withService(command, 'read', async (service) => {
        const result = await startWorktree(service, id, {
          ...(options.type !== undefined ? { type: options.type } : {}),
          ...(options.slug !== undefined ? { slug: options.slug } : {}),
          ...(options.base !== undefined ? { base: options.base } : {}),
          setup: options.setup,
          output: (chunk) => rt.io.stderr.write(chunk),
        });
        rt.emit(options.json, result, describeStart);
      });
    });
}

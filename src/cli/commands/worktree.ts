import type { Command } from 'commander';
import { PR_TYPES } from '../../core/pr-draft.js';
import { finishWorktree, listWorktrees, startWorktree, type WorktreeFinishResult, type WorktreeStartResult } from '../../core/worktree.js';
import { table } from '../format.js';
import type { CliRuntime } from '../runtime.js';

interface StartOptions {
  type?: string;
  slug?: string;
  base?: string;
  setup: boolean;
  json?: boolean;
}

interface FinishOptions {
  mergedHead: string;
  pr?: string;
  base?: string;
  json?: boolean;
}

function describeStart(result: WorktreeStartResult): string {
  const lines = [`${result.reused ? 'Reusing' : 'Created'} worktree ${result.path}`, `branch ${result.branch} (base ${result.base})`];
  if (result.setup.ran) lines.push(`setup: ran ${result.setup.command}`);
  else if (!result.reused && result.setup.command !== null) lines.push(`setup: skipped (${result.setup.command})`);
  return lines.join('\n');
}

function describeFinish(result: WorktreeFinishResult): string {
  const removed = [result.path && `worktree ${result.path}`, result.branch && `branch ${result.branch}`, result.remote_branch].filter(Boolean);
  const { base } = result;
  return [
    `${result.id} is ${result.status} (${result.delivered_in})`,
    removed.length > 0 ? `removed ${removed.join(', ')}` : 'no worktree or branch left to remove',
    base.fast_forwarded
      ? `${base.branch} fast-forwarded to ${base.head!.slice(0, 7)}`
      : base.reason === null
        ? `${base.branch} already up to date`
        : `${base.branch} not fast-forwarded: ${base.reason}`,
    `code_refs: ${result.code_refs.join(', ') || '(none)'}`,
  ].join('\n');
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

  worktree
    .command('finish')
    .description('after the pull request is merged: remove the worktree and branches, fast-forward the base branch and set the item done')
    .argument('<id>', 'task or bug id')
    .requiredOption('--merged-head <sha>', "head commit of the merged pull request; the branches must not have commits it lacks")
    .option('--pr <url>', "pull request URL for delivered_in (default: the item's delivered_in)")
    .option('--base <branch>', 'base branch to fast-forward and diff against (default: the base_branch setting)')
    .option('--json', 'print JSON')
    .action(async (id: string, options: FinishOptions, command: Command) => {
      await rt.withService(command, 'write', async (service) => {
        const result = await finishWorktree(
          service,
          id,
          {
            mergedHead: options.mergedHead,
            ...(options.pr !== undefined ? { pr: options.pr } : {}),
            ...(options.base !== undefined ? { base: options.base } : {}),
          },
          rt.ctx,
        );
        rt.emit(options.json, result, describeFinish);
      });
    });

  worktree
    .command('list')
    .description('worktrees on task and bug branches, with their item ids')
    .option('--json', 'print JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      await rt.withService(command, 'read', (service) => {
        rt.emit(options.json, listWorktrees(service), (entries) =>
          entries.length === 0 ? 'No item worktrees.' : table(['ID', 'Branch', 'Path'], entries.map((entry) => [entry.id, entry.branch, entry.path])),
        );
      });
    });
}

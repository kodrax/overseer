import type { Command } from 'commander';
import { checkoutDir, draftPullRequest, itemIssues, type PrDraft, PR_TYPES, pullRequestHost, readPrTemplate } from '../../core/pr-draft.js';
import { git } from '../../core/project.js';
import { openPullRequest, type PrOpenedResult } from '../../core/worktree.js';
import { oneOf } from '../options.js';
import type { CliRuntime } from '../runtime.js';

export function registerPrCommands(program: Command, rt: CliRuntime): void {
  const pr = program.command('pr').description('pull requests for board items');

  pr.command('draft')
    .description("draft a pull request title and body for a task or bug from the repository's template")
    .argument('<id>', 'task or bug id')
    .option('--type <type>', `Conventional Commit type: ${PR_TYPES.join(' | ')} (default: from the branch, else fix for bugs and feat for tasks)`)
    .option('--json', 'print JSON')
    .action(async (id: string, options: { type?: string; json?: boolean }, command: Command) => {
      await rt.withService(command, 'read', (service) => {
        const type = options.type !== undefined ? oneOf(PR_TYPES, options.type, 'type') : undefined;
        const detail = service.getItem(id);
        const dir = checkoutDir(service.root, rt.cwd);
        const branch = git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        const issues = itemIssues(service.db, detail.item);
        const host = pullRequestHost(dir, branch ?? null, service.connections.list());
        const draft = draftPullRequest(detail, readPrTemplate(dir), { ...(type ? { type } : {}), ...(branch ? { branch } : {}), issues, ...(host ? { host } : {}) });
        rt.emit(options.json, draft, (value: PrDraft) => `${value.title}\n\n${value.body}`);
      });
    });

  pr.command('opened')
    .description('record an opened pull request: the item becomes review with delivered_in and the changed files as code_refs')
    .argument('[id]', 'task or bug id (default: read from the current branch with branch_pattern)')
    .requiredOption('--url <url>', 'pull request URL for delivered_in')
    .option('--json', 'print JSON')
    .action(async (id: string | undefined, options: { url: string; json?: boolean }, command: Command) => {
      await rt.withService(command, 'write', async (service) => {
        const result = await openPullRequest(service, { ...(id !== undefined ? { id } : {}), url: options.url, cwd: rt.cwd }, rt.ctx);
        rt.emit(options.json, result, (value: PrOpenedResult) =>
          [`${value.id} is ${value.status} (${value.delivered_in})`, `branch ${value.branch} (base ${value.base})`, `code_refs: ${value.code_refs.join(', ') || '(none)'}`].join('\n'),
        );
      });
    });
}

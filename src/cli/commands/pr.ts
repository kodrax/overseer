import type { Command } from 'commander';
import { checkoutDir, draftPullRequest, type PrDraft, PR_TYPES, readPrTemplate } from '../../core/pr-draft.js';
import { git } from '../../core/project.js';
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
        const draft = draftPullRequest(detail, readPrTemplate(dir), { ...(type ? { type } : {}), ...(branch ? { branch } : {}) });
        rt.emit(options.json, draft, (value: PrDraft) => `${value.title}\n\n${value.body}`);
      });
    });
}

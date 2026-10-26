import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { databaseFile } from '../../core/db.js';
import { OverseerError } from '../../core/errors.js';
import { type ImportResult, importRequestFor } from '../../core/import.js';
import { assertWritableRoot, dataDir } from '../../core/project.js';
import { EXPORT_PARTS, IMPORT_SOURCES } from '../../core/schema.js';
import { CONFIG_KEYS } from '../../core/service.js';
import { type ProjectSwitch, setProjectEnabled } from '../../core/user-config.js';
import { table } from '../format.js';
import { parseJsonInput, readInput } from '../input.js';
import { collectList, oneOf } from '../options.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

function formatImport(result: ImportResult): string {
  const lines = [
    `created: ${result.created.length}${result.created.length > 0 ? `  ${result.created.join(', ')}` : ''}`,
    `updated: ${result.updated.length}${result.updated.length > 0 ? `  ${result.updated.join(', ')}` : ''}`,
    `unchanged: ${result.unchanged.length}`,
    ...(result.deleted.length > 0 ? [`deleted: ${result.deleted.length}  ${result.deleted.join(', ')}`] : []),
    ...result.warnings.map((warning) => `warning: ${warning}`),
  ];
  for (const duplicate of result.possible_duplicates) {
    lines.push(`possible duplicate: ${duplicate.id} ~ ${duplicate.similar_to.map((match) => `${match.id} (${match.similarity.toFixed(2)})`).join(', ')}`);
  }
  return lines.join('\n');
}

/** `dataFolder`: the project's existing `.overseer/` (kept when turning overseer off, used again when turning it on). */
function formatSwitch(result: ProjectSwitch, dataFolder: string | undefined): string {
  const through = result.through ? ` (through ${result.through})` : '';
  if (!result.changed) return `overseer is already ${result.enabled ? 'on' : 'off'} for ${result.root}${through}.`;
  if (result.enabled) {
    return [
      `overseer is now on for ${result.root}${through} and every folder below it.`,
      dataFolder ? `It uses the existing data in ${dataFolder}.` : `Its data goes to ${dataDir(result.root)}, created on the first write and ignored by git.`,
      `Saved in ${result.config_file}; "overseer disable" turns it off again.`,
    ].join('\n');
  }
  return [
    `overseer is now off for ${result.root}${through} and every folder below it: its MCP tools and CLI commands refuse to work there.`,
    ...(dataFolder ? [`Existing data in ${dataFolder} is kept; delete that folder to remove it.`] : []),
    `Saved in ${result.config_file}; "overseer enable" turns it back on.`,
  ].join('\n');
}

/** `overseer enable` / `overseer disable` for the resolved project; writes only the user config, never the project. */
function switchProject(rt: CliRuntime, command: Command, enabled: boolean): void {
  const options = command.optsWithGlobals<GlobalOptions>();
  const root = rt.projectRoot(options.project);
  assertWritableRoot(root);
  const result = setProjectEnabled(root, enabled, rt.env);
  const dataFolder = existsSync(dataDir(root)) ? dataDir(root) : undefined;
  rt.emit(options.json, result, (value) => formatSwitch(value, dataFolder));
}

export function registerProjectCommands(program: Command, rt: CliRuntime): void {
  program
    .command('init')
    .description('turn overseer on for this project and create its .overseer/ data folder')
    .option('--name <name>', 'project name')
    .option('--asked-by <name>', 'default requester recorded on new items')
    .option('--json', 'print JSON')
    .action(async (options: { name?: string; askedBy?: string; json?: boolean }, command: Command) => {
      const root = rt.projectRoot(command.optsWithGlobals<GlobalOptions>().project);
      assertWritableRoot(root);
      const existed = existsSync(databaseFile(root));
      const turnedOn = setProjectEnabled(root, true, rt.env).changed;
      await rt.withService(command, 'write', (service) => {
        if (options.name !== undefined) service.setConfig('project_name', options.name);
        if (options.askedBy !== undefined) service.setConfig('default_asked_by', options.askedBy);
        rt.emit(options.json, service.info(), (info) =>
          [
            `${existed ? 'Already initialized' : 'Initialized'} overseer in ${dataDir(info.root)} (project "${info.project_name}").`,
            ...(turnedOn ? [`overseer is now on for ${info.root}; "overseer disable" turns it off again.`] : []),
          ].join('\n'),
        );
      });
    });

  program
    .command('export')
    .description('write Markdown/JSON reports into the project (default docs/overseer)')
    .option('--out <dir>', 'output directory, relative to the project root')
    .option('--only <part>', `parts to write (repeatable or comma list): ${EXPORT_PARTS.join(', ')}`, collectList)
    .option('--since <date>', 'history since this ISO date')
    .option('--json', 'print JSON')
    .action(async (options: { out?: string; only?: string[]; since?: string; json?: boolean }, command: Command) => {
      await rt.withService(command, 'read', (service) => {
        const result = service.exportReports({
          ...(options.out !== undefined ? { outDir: options.out } : {}),
          ...(options.only ? { only: options.only.map((part) => oneOf(EXPORT_PARTS, part, 'export part')) } : {}),
          ...(options.since !== undefined ? { since: options.since } : {}),
        });
        rt.emit(options.json, result, () => [`Wrote ${result.files.length} files to ${result.out_dir}:`, ...result.files.map((file) => `  ${file}`)].join('\n'));
      });
    });

  program
    .command('import')
    .description(
      'import GitHub/GitLab issues from a file or stdin (-): a JSON array of ImportItem, or a raw GitHub list_issues / GitLab list_issues, list_work_items or get_work_item MCP response; an object form may add "deleted": [external_id, ...] to delete the items of removed issues',
    )
    .argument('<file>', 'JSON file, or - for stdin')
    .requiredOption('--source <source>', `issue source: ${IMPORT_SOURCES.join(' | ')}`)
    .requiredOption('--repo <repo>', 'owner/repo or group/project')
    .option('--json', 'print JSON')
    .action(async (file: string, options: { source: string; repo: string; json?: boolean }, command: Command) => {
      const request = importRequestFor(parseJsonInput(await readInput(rt, file, 'Import'), 'Import'), options.source, options.repo);
      await rt.withService(command, 'write', async (service) => {
        rt.emit(options.json, await service.importItems(request, rt.ctx), formatImport);
      });
    });

  program
    .command('reindex')
    .description('rebuild the keyword index and re-embed every item')
    .option('--json', 'print JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      await rt.withService(command, 'read', async (service) => {
        const result = await service.reindex();
        rt.emit(options.json, result, () =>
          [`Reindexed ${result.items} items (semantic: ${result.semantic ? 'yes' : 'no'}).`, ...(result.warning ? [`warning: ${result.warning}`] : [])].join('\n'),
        );
      });
    });

  const config = program.command('config').description(`read or change project settings (${CONFIG_KEYS.join(', ')})`);
  config
    .command('get')
    .description('print one setting, or all of them')
    .argument('[key]', `setting: ${CONFIG_KEYS.join(' | ')}`)
    .option('--stored', 'only settings stored in this project, without defaults')
    .option('--json', 'print JSON')
    .action(async (key: string | undefined, options: { json?: boolean; stored?: boolean }, command: Command) => {
      await rt.withService(command, 'read', (service) => {
        if (key === undefined) {
          const values: Partial<Record<string, string>> = options.stored ? service.storedConfig() : service.getConfig();
          rt.emit(options.json, values, (shown) =>
            table(['Key', 'Value'], CONFIG_KEYS.flatMap((name) => (shown[name] === undefined ? [] : [[name, shown[name]]]))),
          );
          return;
        }
        const name = oneOf(CONFIG_KEYS, key, 'config key');
        const value = options.stored ? service.getMeta(name) : service.configValue(name);
        if (value === undefined) {
          throw new OverseerError('NOT_FOUND', `${name} is not stored in this project; "overseer config get ${name}" prints the value in effect.`);
        }
        rt.emit(options.json, { [name]: value }, () => value);
      });
    });
  config
    .command('set')
    .description('change a setting')
    .argument('<key>', `setting: ${CONFIG_KEYS.join(' | ')}`)
    .argument('<value>', 'new value')
    .option('--json', 'print JSON')
    .action(async (key: string, value: string, options: { json?: boolean }, command: Command) => {
      await rt.withService(command, 'write', (service) => {
        const result = service.setConfig(key, value);
        rt.emit(options.json, result, () => `${key} = ${result[oneOf(CONFIG_KEYS, key, 'config key')]}`);
      });
    });

  program
    .command('enable')
    .description('turn overseer on for this project and every folder below it (projects are off by default)')
    .option('--json', 'print JSON')
    .action((_options: unknown, command: Command) => switchProject(rt, command, true));

  program
    .command('disable')
    .description('turn overseer off for this project and every folder below it (nothing is written into the project; data is kept)')
    .option('--json', 'print JSON')
    .action((_options: unknown, command: Command) => switchProject(rt, command, false));
}

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { databaseFile } from '../../core/db.js';
import { OverseerError } from '../../core/errors.js';
import type { ImportResult } from '../../core/import.js';
import { assertWritableRoot, dataDir } from '../../core/project.js';
import { EXPORT_PARTS, IMPORT_SOURCES } from '../../core/schema.js';
import { CONFIG_KEYS } from '../../core/service.js';
import { type ProjectSwitch, setProjectEnabled } from '../../core/user-config.js';
import { table } from '../format.js';
import { collectList, oneOf } from '../options.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

async function readInput(rt: CliRuntime, file: string): Promise<string> {
  if (file !== '-') {
    const path = resolve(rt.cwd, file);
    if (!existsSync(path)) throw new OverseerError('INVALID_INPUT', `Import file not found: ${path}`);
    return readFileSync(path, 'utf8');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of rt.io.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

/** Import payload: a JSON array of ImportItem, or an object with `items`. */
function importItemsOf(text: string): unknown {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new OverseerError('INVALID_INPUT', `Import input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && 'items' in data) return data.items;
  throw new OverseerError('INVALID_INPUT', 'Import input must be a JSON array of items or an object with "items".');
}

function formatImport(result: ImportResult): string {
  const lines = [
    `created: ${result.created.length}${result.created.length > 0 ? `  ${result.created.join(', ')}` : ''}`,
    `updated: ${result.updated.length}${result.updated.length > 0 ? `  ${result.updated.join(', ')}` : ''}`,
    `unchanged: ${result.unchanged.length}`,
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
    .description('import GitHub/GitLab issues (JSON array of ImportItem) from a file or stdin (-)')
    .argument('<file>', 'JSON file, or - for stdin')
    .requiredOption('--source <source>', `issue source: ${IMPORT_SOURCES.join(' | ')}`)
    .requiredOption('--repo <repo>', 'owner/repo or group/project')
    .option('--json', 'print JSON')
    .action(async (file: string, options: { source: string; repo: string; json?: boolean }, command: Command) => {
      const items = importItemsOf(await readInput(rt, file));
      await rt.withService(command, 'write', async (service) => {
        rt.emit(options.json, await service.importItems({ source: options.source, repo: options.repo, items }, rt.ctx), formatImport);
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
    .option('--json', 'print JSON')
    .action(async (key: string | undefined, options: { json?: boolean }, command: Command) => {
      await rt.withService(command, 'read', (service) => {
        const all = service.getConfig();
        if (key === undefined) {
          rt.emit(options.json, all, (values) => table(['Key', 'Value'], CONFIG_KEYS.map((name) => [name, values[name]])));
          return;
        }
        const name = oneOf(CONFIG_KEYS, key, 'config key');
        rt.emit(options.json, { [name]: all[name] }, () => all[name]);
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

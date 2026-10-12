import { homedir } from 'node:os';
import type { Command } from 'commander';
import { OverseerError } from '../../core/errors.js';
import { cliScriptPath, templatesDir } from '../../core/paths.js';
import { assertWritableRoot } from '../../core/project.js';
import { setProjectEnabled, userConfigFile } from '../../core/user-config.js';
import {
  formatInstallReport,
  harnessStatus,
  type InstallContext,
  type InstallReport,
  install,
  type Scope,
  TARGET_IDS,
  type TargetId,
  uninstall,
} from '../../install/index.js';
import { collectList, oneOf } from '../options.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';
import { promptTargets } from '../select-targets.js';
import { type ModelPull, pullModel, reportModelPull } from './models.js';

interface InstallOptions extends GlobalOptions {
  targets?: string[];
  scope: string;
  dryRun?: boolean;
  force?: boolean;
  skipModel?: boolean;
}

/** Production installer context; HOME/env come from the runtime so tests can redirect them. */
export function installContext(
  rt: CliRuntime,
  scope: Scope,
  projectRoot: string | undefined,
  flags: { dryRun: boolean; force: boolean },
): InstallContext {
  return {
    scope,
    home: rt.env.HOME ?? homedir(),
    env: rt.env,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    nodePath: process.execPath,
    cliPath: cliScriptPath(),
    templatesDir: templatesDir(),
    dryRun: flags.dryRun,
    force: flags.force,
  };
}

function contextFromOptions(rt: CliRuntime, options: InstallOptions): InstallContext {
  const scope = oneOf(['user', 'project'] as const, options.scope, 'scope');
  let projectRoot: string | undefined;
  if (scope === 'project') {
    projectRoot = rt.projectRoot(options.project);
    assertWritableRoot(projectRoot);
  }
  return installContext(rt, scope, projectRoot, { dryRun: options.dryRun === true, force: options.force === true });
}

function targetsOf(options: InstallOptions): TargetId[] | undefined {
  if (options.targets === undefined) return undefined;
  if (options.targets.length === 0) throw new OverseerError('INVALID_INPUT', `--targets needs at least one of ${TARGET_IDS.join(', ')}.`);
  return options.targets.map((target) => oneOf(TARGET_IDS, target, 'target'));
}

/**
 * `--targets` when given; otherwise the detected harnesses plus those overseer is already installed for,
 * confirmed (or changed) by the user when running in a terminal.
 */
async function chooseTargets(rt: CliRuntime, ctx: InstallContext, options: InstallOptions): Promise<TargetId[]> {
  const explicit = targetsOf(options);
  if (explicit) return explicit;
  const statuses = harnessStatus(ctx);
  const defaults = statuses.filter((status) => status.detected || status.installed).map((status) => status.target);
  const chosen = rt.interactive && !options.json ? await promptTargets(rt, statuses, defaults, ctx.scope) : defaults;
  if (chosen.length === 0) {
    throw new OverseerError('INVALID_INPUT', `No harness selected or detected; pass --targets <list> (${TARGET_IDS.join(',')}).`);
  }
  return chosen;
}

function addScopeOptions(command: Command, targetsHelp: string): Command {
  return command
    .option('--targets <list>', `comma list of harnesses: ${TARGET_IDS.join(',')} (default: ${targetsHelp})`, collectList)
    .option('--scope <scope>', 'user | project', 'user')
    .option('--dry-run', 'print planned writes and commands without changing anything')
    .option('--force', 'overwrite files not managed by overseer')
    .option('--json', 'print JSON');
}

export function registerInstallCommands(program: Command, rt: CliRuntime): void {
  addScopeOptions(
    program.command('install').description('install the overseer agent, skills and MCP server into the coding harnesses you choose'),
    'asks in a terminal, preselecting detected harnesses; otherwise the detected ones',
  )
    .option('--skip-model', 'do not download the embedding model')
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<InstallOptions>();
      const ctx = contextFromOptions(rt, options);
      const report = install(ctx, await chooseTargets(rt, ctx, options));
      const failed = report.actions.some((action) => action.status === 'failed');
      // Projects are off by default; installing overseer into one is the user turning it on there.
      const project = ctx.projectRoot !== undefined && !ctx.dryRun ? setProjectEnabled(ctx.projectRoot, true, rt.env) : undefined;
      const pull: ModelPull | undefined = options.dryRun || options.skipModel ? undefined : await pullModel();
      if (options.json) {
        rt.out(JSON.stringify({ ...report, ...(project ? { project } : {}), ...(pull ? { model: pull } : {}) }, null, 2));
        if (pull && !pull.ready) rt.exitCode = 1;
      } else {
        rt.out(formatInstallReport(report));
        if (project) rt.out(`overseer is ${project.changed ? 'now' : 'already'} on for ${project.root}; teammates who clone it run "overseer enable" there once.`);
        else if (ctx.projectRoot !== undefined) rt.out(`would turn overseer on for ${ctx.projectRoot} (${userConfigFile(rt.env)})`);
        if (pull) reportModelPull(rt, pull);
      }
      if (failed) rt.exitCode = 1;
    });

  addScopeOptions(
    program.command('uninstall').description('remove the overseer agent, skills and MCP registrations'),
    'the harnesses overseer is installed for',
  ).action((_options: unknown, command: Command) => {
    const options = command.optsWithGlobals<InstallOptions>();
    const report: InstallReport = uninstall(contextFromOptions(rt, options), targetsOf(options));
    rt.emit(options.json, report, formatInstallReport);
    if (report.actions.some((action) => action.status === 'failed')) rt.exitCode = 1;
  });
}

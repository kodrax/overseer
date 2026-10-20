import { DatabaseSync } from 'node:sqlite';
import type { Command } from 'commander';
import { loadVec } from '../../core/db.js';
import { DEFAULT_MODEL, isModelCached, modelCacheDir, TransformersEmbedder } from '../../core/embeddings.js';
import { errorMessage } from '../../core/errors.js';
import { isGuardedRoot } from '../../core/project.js';
import { KINDS } from '../../core/schema.js';
import { OverseerService } from '../../core/service.js';
import { type ProjectState, projectState } from '../../core/user-config.js';
import { type CheckLine, checkInstall, harnessStatus, TARGET_IDS } from '../../install/index.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';
import { installContext } from './install.js';

const MIN_NODE = [22, 18] as const;

function nodeCheck(): CheckLine {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return { status: ok ? 'OK' : 'FAIL', label: 'node', detail: `${process.versions.node}${ok ? '' : ` (need >= ${MIN_NODE.join('.')})`}` };
}

function sqliteCheck(): CheckLine {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(':memory:', { allowExtension: true });
  } catch (error) {
    return { status: 'FAIL', label: 'sqlite', detail: `node:sqlite unavailable: ${errorMessage(error)}` };
  }
  try {
    if (!loadVec(db)) return { status: 'WARN', label: 'sqlite', detail: 'sqlite-vec failed to load; keyword search only' };
    db.exec('CREATE VIRTUAL TABLE probe USING vec0(embedding FLOAT[4] distance_metric=cosine)');
    const version = db.prepare('SELECT sqlite_version() AS sqlite, vec_version() AS vec').get();
    return { status: 'OK', label: 'sqlite', detail: `node:sqlite ${String(version?.sqlite)} + sqlite-vec ${String(version?.vec)}` };
  } catch (error) {
    return { status: 'WARN', label: 'sqlite', detail: `sqlite-vec unusable (${errorMessage(error)}); keyword search only` };
  } finally {
    db.close();
  }
}

async function modelChecks(rt: CliRuntime, deep: boolean): Promise<CheckLine[]> {
  const dir = modelCacheDir(rt.env);
  const lines: CheckLine[] = [
    isModelCached(DEFAULT_MODEL, dir)
      ? { status: 'OK', label: 'model', detail: `${DEFAULT_MODEL} cached in ${dir}` }
      : { status: 'WARN', label: 'model', detail: `${DEFAULT_MODEL} not downloaded (run overseer models pull)` },
  ];
  if (deep) {
    try {
      const [vector] = await new TransformersEmbedder().embed(['overseer doctor']);
      lines.push({ status: 'OK', label: 'model load', detail: `embedded a test string (dims ${vector?.length ?? 0})` });
    } catch (error) {
      lines.push({ status: 'FAIL', label: 'model load', detail: errorMessage(error) });
    }
  }
  return lines;
}

/** Project check plus the resolved root when it is a usable (non-guarded) project directory. */
function projectCheck(rt: CliRuntime, explicit: string | undefined): { line: CheckLine; root?: string } {
  let root: string;
  try {
    root = rt.projectRoot(explicit);
  } catch (error) {
    return { line: { status: 'FAIL', label: 'project', detail: errorMessage(error) } };
  }
  if (isGuardedRoot(root)) {
    return { line: { status: 'WARN', label: 'project', detail: `No project detected (resolved to ${root}); run inside a project folder or pass --project` } };
  }
  let state: ProjectState;
  try {
    state = projectState(root, rt.env);
  } catch (error) {
    return { line: { status: 'FAIL', label: 'project', detail: errorMessage(error) }, root };
  }
  if (!state.enabled) {
    const why = state.rule === undefined ? 'off by default' : state.rule === root ? 'turned off' : `turned off through ${state.rule}`;
    return { line: { status: 'OK', label: 'project', detail: `${root} (overseer is ${why}; overseer enable turns it on)` }, root };
  }
  let service: OverseerService | undefined;
  try {
    service = OverseerService.open({ root, create: false, embedder: null });
  } catch (error) {
    return { line: { status: 'FAIL', label: 'project', detail: `${root}: ${errorMessage(error)}` }, root };
  }
  if (!service) return { line: { status: 'WARN', label: 'project', detail: `${root} (not initialized; run overseer init)` }, root };
  try {
    const info = service.info();
    const counts = KINDS.map((kind) => [kind, Object.values(info.counts[kind] ?? {}).reduce((sum, count) => sum + count, 0)] as const);
    const total = counts.reduce((sum, [, count]) => sum + count, 0);
    const breakdown = counts.filter(([, count]) => count > 0).map(([kind, count]) => `${count} ${kind}`);
    return {
      line: {
        status: 'OK',
        label: 'project',
        detail: `${root} (schema ${info.schema_version}; ${total} items${breakdown.length > 0 ? `: ${breakdown.join(', ')}` : ''}; semantic ${info.vec_available ? 'on' : 'off'})`,
      },
      root,
    };
  } finally {
    service.close();
  }
}

/**
 * One summary line naming every harness overseer is installed for (user scope, or project scope of the current
 * project, marked "(project)"), then full checks only for those installs (not installing it for a detected harness
 * is the user's choice, not a problem).
 */
function targetChecks(rt: CliRuntime, root: string | undefined): CheckLine[] {
  const user = installContext(rt, 'user', undefined, { dryRun: true, force: false });
  const statuses = harnessStatus(user);
  const installed = statuses.filter((status) => status.installed).map((status) => status.target);
  const projectChecks: CheckLine[] = [];
  const inProject = new Set<string>();
  if (root !== undefined) {
    const project = installContext(rt, 'project', root, { dryRun: true, force: false });
    const projectLines = checkInstall(project, [...TARGET_IDS]);
    for (const target of TARGET_IDS) {
      const prefix = `${target} (project) `;
      const own = projectLines.filter((line) => line.label.startsWith(prefix));
      const present = own.some(
        (line) => !line.label.endsWith(' schema') && (line.status !== 'WARN' || !/^(not installed|missing or unmanaged|no )|not registered|cannot verify/.test(line.detail)),
      );
      if (present) {
        inProject.add(target);
        projectChecks.push(...own);
      }
    }
  }
  const named = statuses
    .filter((status) => status.installed || inProject.has(status.target))
    .map((status) => (inProject.has(status.target) ? `${status.target} (project)` : status.target));
  const available = statuses.filter((status) => status.detected && !status.installed && !inProject.has(status.target)).map((status) => status.target);
  const summary: CheckLine =
    named.length === 0
      ? {
          status: 'WARN',
          label: 'harnesses',
          detail: `overseer is not installed for any harness${available.length > 0 ? ` (detected: ${available.join(', ')})` : ''}; run overseer install`,
        }
      : {
          status: 'OK',
          label: 'harnesses',
          detail: `overseer installed for ${named.join(', ')}${available.length > 0 ? `; also detected: ${available.join(', ')} (add with overseer install --targets <ids>)` : ''}`,
        };
  return [summary, ...checkInstall(user, installed), ...projectChecks];
}

export function registerDoctorCommand(program: Command, rt: CliRuntime): void {
  program
    .command('doctor')
    .description('check the runtime, model, project and harness installations')
    .option('--deep', 'also load the model and embed a test string')
    .option('--json', 'print JSON')
    .action(async (options: { deep?: boolean; json?: boolean }, command: Command) => {
      const { project: explicit } = command.optsWithGlobals<GlobalOptions>();
      const { line, root } = projectCheck(rt, explicit);
      const checks: CheckLine[] = [nodeCheck(), sqliteCheck(), ...(await modelChecks(rt, options.deep === true)), line, ...targetChecks(rt, root)];
      rt.emit(options.json, { checks }, () => checks.map((check) => `${check.status.padEnd(4)}  ${check.label}: ${check.detail}`).join('\n'));
      if (checks.some((check) => check.status === 'FAIL')) rt.exitCode = 1;
    });
}

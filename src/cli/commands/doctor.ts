import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Command } from 'commander';
import type { Connection, ConnectionHost } from '../../core/connections.js';
import { loadVec } from '../../core/db.js';
import { DEFAULT_MODEL, isModelCached, modelCacheDir, TransformersEmbedder } from '../../core/embeddings.js';
import { errorMessage } from '../../core/errors.js';
import { templatesDir } from '../../core/paths.js';
import { isGuardedRoot } from '../../core/project.js';
import { KINDS } from '../../core/schema.js';
import { OverseerService } from '../../core/service.js';
import { type ProjectState, projectState } from '../../core/user-config.js';
import {
  type CheckLine,
  checkInstall,
  harnessMcpServers,
  harnessStatus,
  type InstallContext,
  type McpServerEntry,
  TARGET_IDS,
  type TargetId,
} from '../../install/index.js';
import { TARGETS } from '../../install/targets.js';
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
  const cached = isModelCached(DEFAULT_MODEL, dir);
  const lines: CheckLine[] = [
    cached
      ? { status: 'OK', label: 'model', detail: `${DEFAULT_MODEL} cached in ${dir}` }
      : { status: 'WARN', label: 'model', detail: `${DEFAULT_MODEL} not downloaded (run overseer models pull)` },
  ];
  if (deep && !cached) {
    lines.push({ status: 'WARN', label: 'model load', detail: 'skipped: the model is not downloaded (run overseer models pull)' });
  } else if (deep) {
    try {
      const [vector] = await new TransformersEmbedder(DEFAULT_MODEL, { cacheDir: dir }).embed(['overseer doctor']);
      lines.push({ status: 'OK', label: 'model load', detail: `embedded a test string (dims ${vector?.length ?? 0})` });
    } catch (error) {
      lines.push({ status: 'FAIL', label: 'model load', detail: errorMessage(error) });
    }
  }
  return lines;
}

/** Project check, the resolved root when it is a usable (non-guarded) project directory, and its connections. */
function projectCheck(rt: CliRuntime, explicit: string | undefined): { line: CheckLine; root?: string; connections?: Connection[] } {
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
      connections: service.connections.list(),
    };
  } finally {
    service.close();
  }
}

/** A harness overseer is installed in, with the install context of that scope. */
interface HarnessInstall {
  ctx: InstallContext;
  target: TargetId;
}

/**
 * One summary line naming every harness overseer is installed for (user scope, or project scope of the current
 * project, marked "(project)"), then full checks only for those installs (not installing it for a detected harness
 * is the user's choice, not a problem). `installs` lists those installs, user scope first.
 */
function targetChecks(rt: CliRuntime, root: string | undefined): { lines: CheckLine[]; installs: HarnessInstall[] } {
  const user = installContext(rt, 'user', undefined, { dryRun: true, force: false });
  const statuses = harnessStatus(user);
  const installed = statuses.filter((status) => status.installed).map((status) => status.target);
  const projectChecks: CheckLine[] = [];
  const inProject = new Set<string>();
  const project = root === undefined ? undefined : installContext(rt, 'project', root, { dryRun: true, force: false });
  if (project !== undefined) {
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
  const installs: HarnessInstall[] = [
    ...installed.map((target) => ({ ctx: user, target })),
    ...(project === undefined ? [] : TARGET_IDS.filter((target) => inProject.has(target)).map((target) => ({ ctx: project, target }))),
  ];
  return { lines: [summary, ...checkInstall(user, installed), ...projectChecks], installs };
}

/** What identifies each host's usual MCP server in a URL or command, for connections that name no server. */
const HOST_SERVERS: Record<ConnectionHost, { label: string; patterns: string[] }> = {
  github: { label: 'GitHub', patterns: ['api.githubcopilot.com/mcp', 'github-mcp-server'] },
  gitlab: { label: 'GitLab', patterns: ['@zereight/mcp-gitlab', '/api/v4/mcp'] },
};

/**
 * One line per repository connection: OK naming the MCP server that reaches the repository and the harnesses whose
 * config has it (by the connection's `mcp_server` name, else by the host's usual URL or command), WARN naming the
 * harnesses checked and the setup guide when none has it. Only local configs are read (Claude Code's user scope
 * through `claude mcp get <name>` or `claude mcp list`); nothing is read when there is no connection.
 */
function connectionChecks(connections: Connection[], installs: HarnessInstall[]): CheckLine[] {
  if (connections.length === 0) return [];
  const guideFile = join('overseer-import', 'references', 'integrations.md');
  const guide =
    installs.map(({ ctx, target }) => join(TARGETS[target].layout(ctx).skillsDir, guideFile)).find((path) => existsSync(path)) ??
    join(templatesDir(), 'skills', guideFile);
  // One read per harness and server name, shared by connections to the same host or server.
  const reads = new Map<string, McpServerEntry[] | Error>();
  const servers = (index: number, name: string | undefined): McpServerEntry[] => {
    const key = `${index}:${name ?? ''}`;
    let result = reads.get(key);
    if (result === undefined) {
      try {
        result = harnessMcpServers(installs[index]!.ctx, installs[index]!.target, name);
      } catch (error) {
        result = new Error(errorMessage(error));
      }
      reads.set(key, result);
    }
    if (result instanceof Error) throw result;
    return result;
  };
  return connections.map((connection): CheckLine => {
    const label = `connection ${connection.id}`;
    const subject = `${connection.host} ${connection.repository}`;
    const name = connection.mcp_server ?? undefined;
    const { label: hostLabel, patterns } = HOST_SERVERS[connection.host];
    const found = new Map<string, string[]>();
    const missing: string[] = [];
    const failed: string[] = [];
    installs.forEach(({ ctx, target }, index) => {
      const harness = `${target} (${ctx.scope})`;
      try {
        const match = servers(index, name).find((server) => name !== undefined || patterns.some((pattern) => server.target.includes(pattern)));
        if (!match) {
          missing.push(harness);
          return;
        }
        const server = match.target === '' ? `"${match.name}"` : `"${match.name}" (${match.target})`;
        found.set(server, [...(found.get(server) ?? []), harness]);
      } catch (error) {
        failed.push(`${harness}: ${errorMessage(error)}`);
      }
    });
    const cannot = failed.length > 0 ? `cannot check ${failed.join('; ')}` : '';
    if (found.size > 0) {
      const where = [...found].map(([server, harnesses]) => `${server} in ${harnesses.join(', ')}`).join('; ');
      const rest = [missing.length > 0 ? `not in ${missing.join(', ')}` : '', cannot].filter((part) => part !== '');
      return { status: 'OK', label, detail: `${subject}: MCP server ${where}${rest.map((part) => `; ${part}`).join('')}` };
    }
    const wanted = name !== undefined ? `MCP server "${name}"` : `${hostLabel} MCP server (${patterns.join(' or ')})`;
    const checked = installs.map(({ ctx, target }) => `${target} (${ctx.scope})`);
    const searched = checked.length === 0 ? `overseer is installed for no harness, so none was checked for ${wanted}` : `no ${wanted} in ${checked.join(', ')}`;
    return { status: 'WARN', label, detail: `${subject}: ${searched}${cannot === '' ? '' : ` (${cannot})`}; set one up as ${guide} shows` };
  });
}

export function registerDoctorCommand(program: Command, rt: CliRuntime): void {
  program
    .command('doctor')
    .description('check the runtime, model, project and harness installations')
    .option('--deep', 'also load the model and embed a test string')
    .option('--json', 'print JSON')
    .action(async (options: { deep?: boolean; json?: boolean }, command: Command) => {
      const { project: explicit } = command.optsWithGlobals<GlobalOptions>();
      const { line, root, connections = [] } = projectCheck(rt, explicit);
      const targets = targetChecks(rt, root);
      const checks: CheckLine[] = [
        nodeCheck(),
        sqliteCheck(),
        ...(await modelChecks(rt, options.deep === true)),
        line,
        ...targets.lines,
        ...connectionChecks(connections, targets.installs),
      ];
      rt.emit(options.json, { checks }, () => checks.map((check) => `${check.status.padEnd(4)}  ${check.label}: ${check.detail}`).join('\n'));
      if (checks.some((check) => check.status === 'FAIL')) rt.exitCode = 1;
    });
}

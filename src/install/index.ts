import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isOverseerError, OverseerError } from '../core/errors.js';
import { CLAUDE_REMOVE_ARGS, claudeAddArgs, claudeMcpGet, claudeMcpList, claudeRegistrationMatches } from './claude-cli.js';
import { findExecutable } from './exec.js';
import type { Op } from './fs-ops.js';
import { isManaged, listFiles, readIfExists, Run } from './fs-ops.js';
import { getJsonValue, removeJsonValues, setJsonValue } from './json-config.js';
import { opencodeSchema } from './opencode-version.js';
import type { Detection, McpSpec, TargetLayout } from './targets.js';
import { readsSharedSkills, TARGETS } from './targets.js';
import { readTomlServers, removeTomlBlock, renderMcpBlock, upsertTomlBlock } from './toml-block.js';
import type { CheckLine, InstallAction, InstallContext, InstallReport, TargetId } from './types.js';
import { BACKUP_SUFFIX, SKILL_NAMES, TARGET_IDS } from './types.js';

export type { ActionStatus, CheckLine, InstallAction, InstallContext, InstallReport, Scope, TargetId } from './types.js';
export { TARGET_IDS } from './types.js';

function assertContext(ctx: InstallContext): void {
  if (ctx.scope === 'project' && !ctx.projectRoot) {
    throw new OverseerError('INVALID_INPUT', 'Project scope requires a project directory (--project).');
  }
}

export interface HarnessStatus extends Detection {
  target: TargetId;
  label: string;
  /** overseer's managed agent file exists in `ctx.scope`. */
  installed: boolean;
}

/** Every supported harness with detection evidence and whether overseer is installed for it in `ctx.scope`. */
export function harnessStatus(ctx: InstallContext): HarnessStatus[] {
  return TARGET_IDS.map((target) => ({
    target,
    label: TARGETS[target].label,
    ...TARGETS[target].detect(ctx),
    installed: managedAgentExists(ctx, target),
  }));
}

/** Harnesses installed on this machine: CLI on `ctx.env.PATH` (Cursor: CLI or `~/.cursor`). */
export function detectTargets(ctx: InstallContext): TargetId[] {
  return TARGET_IDS.filter((id) => TARGETS[id].detect(ctx).detected);
}

/** Targets whose managed agent file exists in `ctx.scope`. */
export function installedTargets(ctx: InstallContext): TargetId[] {
  return TARGET_IDS.filter((id) => managedAgentExists(ctx, id));
}

function managedAgentExists(ctx: InstallContext, id: TargetId): boolean {
  return isManaged(readIfExists(TARGETS[id].layout(ctx).agentPath));
}

function failTarget(run: Run, target: TargetId, error: unknown): void {
  const message = isOverseerError(error) ? `${error.code}: ${error.message}` : (error as Error).message;
  run.actions.push({ target, kind: 'file', status: 'failed', message });
  run.warn(`${target}: ${message}`);
}

// ───────────────────────────── install ─────────────────────────────

/**
 * Warning for `--force` over `subject`, naming where each replaced file's previous content is: a new
 * `<file>.overseer-backup`, or nowhere when an older backup already existed (it is never overwritten).
 */
function forceWarning(subject: string, replaced: string[]): string {
  const backups = replaced.map((path) => path + BACKUP_SUFFIX);
  const made = backups.filter((path) => !existsSync(path));
  const kept = backups.filter((path) => existsSync(path));
  let message = `${subject} was not managed by overseer-cli; overwritten (--force)`;
  if (made.length > 0) message += `, previous content in ${made.join(', ')}`;
  if (kept.length === 1) message += `; ${kept[0]} already existed and was kept: it holds older content, not the content just overwritten`;
  if (kept.length > 1) message += `; ${kept.join(', ')} already existed and were kept: they hold older content, not the content just overwritten`;
  return `${message}.`;
}

function planSkillsInstall(run: Run, target: TargetId, layout: TargetLayout): Op[] {
  if (run.skillRoots.has(layout.skillsDir)) return [];
  const label = layout.sharedSkills ? 'shared' : target;
  const ops: Op[] = [];
  for (const name of SKILL_NAMES) {
    const source = join(run.ctx.templatesDir, 'skills', name);
    if (!existsSync(join(source, 'SKILL.md'))) throw new OverseerError('NOT_FOUND', `Skill template missing: ${join(source, 'SKILL.md')}`);
    const dir = join(layout.skillsDir, name);
    const skillMd = readIfExists(join(dir, 'SKILL.md'));
    const unmanaged = skillMd !== undefined && !isManaged(skillMd);
    if (unmanaged && !run.ctx.force) {
      ops.push({ kind: 'note', action: { target: label, kind: 'dir', path: dir, status: 'skipped', message: 'NOT_MANAGED' } });
      run.warn(`NOT_MANAGED: ${dir} exists and is not managed by overseer-cli; skipped (use --force to overwrite).`);
      continue;
    }
    const files = listFiles(source)
      .map((rel) => ({ path: join(dir, rel), content: readIfExists(join(source, rel))! }))
      .filter((file) => readIfExists(file.path) !== file.content);
    // Per-file backups inside the folder, never a copied folder: the harness would load it as a second skill.
    if (unmanaged) run.warn(forceWarning(dir, files.map((file) => file.path).filter((path) => existsSync(path))));
    ops.push(
      files.length === 0
        ? { kind: 'note', action: { target: label, kind: 'dir', path: dir, status: 'unchanged' } }
        : { kind: 'skill', target: label, dir, files, existed: existsSync(dir), backup: unmanaged },
    );
  }
  return ops;
}

function planAgentInstall(run: Run, target: TargetId, layout: TargetLayout, template: string): Op[] {
  const path = layout.agentPath;
  const content = layout.renderAgent(template);
  const existing = readIfExists(path);
  if (existing === content) return [{ kind: 'note', action: { target, kind: 'file', path, status: 'unchanged' } }];
  if (existing !== undefined && !isManaged(existing)) {
    if (!run.ctx.force) {
      run.warn(`NOT_MANAGED: ${path} exists and is not managed by overseer-cli; skipped (use --force to overwrite).`);
      return [{ kind: 'note', action: { target, kind: 'file', path, status: 'skipped', message: 'NOT_MANAGED' } }];
    }
    run.warn(forceWarning(path, [path]));
  }
  return [{ kind: 'write', target, path, content, existed: existing !== undefined, backup: existing !== undefined && !isManaged(existing) }];
}

function planMcpInstall(run: Run, target: TargetId, mcp: McpSpec): Op[] {
  const { ctx } = run;
  switch (mcp.type) {
    case 'json': {
      const text = readIfExists(mcp.path);
      const next = setJsonValue(text, mcp.keyPath, mcp.value, mcp.path, mcp.schema);
      if (next === text) return [{ kind: 'note', action: { target, kind: 'file', path: mcp.path, status: 'unchanged' } }];
      return [{ kind: 'write', target, path: mcp.path, content: next, existed: text !== undefined, backup: true }];
    }
    case 'toml': {
      const text = readIfExists(mcp.path);
      const result = upsertTomlBlock(text, renderMcpBlock(mcp.command, mcp.args), mcp.path);
      if (!result.ok) {
        run.warn(`${mcp.path}: [mcp_servers.overseer] is already defined outside the overseer managed block; left untouched.`);
        return [{ kind: 'note', action: { target, kind: 'file', path: mcp.path, status: 'skipped', message: 'mcp_servers.overseer defined by user' } }];
      }
      if (result.text === text) return [{ kind: 'note', action: { target, kind: 'file', path: mcp.path, status: 'unchanged' } }];
      return [{ kind: 'write', target, path: mcp.path, content: result.text, existed: text !== undefined, backup: true }];
    }
    case 'claude-cli': {
      const addArgs = claudeAddArgs(ctx);
      const bin = findExecutable(ctx, 'claude');
      if (!bin) {
        run.warn('claude is not on PATH; register the MCP server manually with the command shown.');
        return [{ kind: 'note', action: { target, kind: 'command', command: ['claude', ...addArgs], status: 'manual', message: 'manual step' } }];
      }
      // Claude Code writes ~/.claude.json (and backups) even for `claude mcp get`, so a dry run must not spawn it;
      // it plans the remove + add pair without checking the current registration.
      const info = ctx.dryRun ? undefined : claudeMcpGet(ctx, bin);
      if (info && claudeRegistrationMatches(info, ctx)) {
        return [{ kind: 'note', action: { target, kind: 'command', command: ['claude', ...addArgs], status: 'unchanged' } }];
      }
      return [
        {
          kind: 'command',
          target,
          bin,
          program: 'claude',
          steps: [
            { args: CLAUDE_REMOVE_ARGS, ignoreFailure: true },
            { args: addArgs, ignoreFailure: false },
          ],
          success: info?.exists ? 'updated' : 'created',
        },
      ];
    }
  }
}

/** Installs skills, subagent definition and MCP registration for each target (default: detected targets). */
export function install(ctx: InstallContext, targets: TargetId[] = detectTargets(ctx)): InstallReport {
  assertContext(ctx);
  const run = new Run(ctx);
  let template: string | undefined;
  for (const target of targets) {
    try {
      template ??= readIfExists(join(ctx.templatesDir, 'agent-prompt.md'));
      if (template === undefined) throw new OverseerError('NOT_FOUND', `Agent prompt template missing: ${join(ctx.templatesDir, 'agent-prompt.md')}`);
      const layout = TARGETS[target].layout(ctx);
      // Plan everything first: a CONFIG_PARSE (or any) error aborts the whole target before any write.
      const ops = [
        ...planSkillsInstall(run, target, layout),
        ...planAgentInstall(run, target, layout, template),
        ...planMcpInstall(run, target, layout.mcp),
      ];
      run.applyOps(ops);
      run.skillRoots.add(layout.skillsDir);
    } catch (error) {
      failTarget(run, target, error);
    }
  }
  return { scope: ctx.scope, targets, actions: run.actions, warnings: run.warnings };
}

// ──────────────────────────── uninstall ────────────────────────────

function planSkillsRemoval(run: Run, label: TargetId | 'shared', skillsDir: string): Op[] {
  const ops: Op[] = [];
  for (const name of SKILL_NAMES) {
    const dir = join(skillsDir, name);
    const skillMd = readIfExists(join(dir, 'SKILL.md'));
    if (skillMd === undefined) continue;
    if (!isManaged(skillMd)) {
      run.warn(`NOT_MANAGED: ${dir} is not managed by overseer-cli; left in place.`);
      ops.push({ kind: 'note', action: { target: label, kind: 'dir', path: dir, status: 'skipped', message: 'NOT_MANAGED' } });
      continue;
    }
    const files = listFiles(dir);
    const backups = files.filter((rel) => rel.endsWith(BACKUP_SUFFIX));
    if (backups.length === 0) {
      ops.push({ kind: 'remove-dir', target: label, path: dir });
      continue;
    }
    // `install --force` took over this folder: remove overseer's files only; the backups and unmanaged files stay.
    for (const rel of files) {
      const path = join(dir, rel);
      if (!rel.endsWith(BACKUP_SUFFIX) && isManaged(readIfExists(path))) ops.push({ kind: 'remove-file', target: label, path, backup: false });
    }
    run.warn(`${dir} keeps the backups install --force made: ${backups.join(', ')}.`);
  }
  return ops;
}

function planMcpRemoval(run: Run, target: TargetId, mcp: McpSpec): Op[] {
  const { ctx } = run;
  switch (mcp.type) {
    case 'json': {
      const text = readIfExists(mcp.path);
      if (text === undefined) return [];
      const result = removeJsonValues(text, mcp.removePaths, mcp.path);
      if (!result.changed) return [];
      // A file left with nothing but `$schema` holds no user content: delete it without a backup.
      if (result.empty) return [{ kind: 'remove-file', target, path: mcp.path, backup: false }];
      // Uninstall never creates or changes a backup: the one kept holds the pre-overseer original.
      return [{ kind: 'write', target, path: mcp.path, content: result.text, existed: true, backup: false }];
    }
    case 'toml': {
      const text = readIfExists(mcp.path);
      if (text === undefined) return [];
      const result = removeTomlBlock(text, mcp.path);
      if (!result.changed) return [];
      if (result.text.trim() === '') return [{ kind: 'remove-file', target, path: mcp.path, backup: false }];
      return [{ kind: 'write', target, path: mcp.path, content: result.text, existed: true, backup: false }];
    }
    case 'claude-cli': {
      const bin = findExecutable(ctx, 'claude');
      if (!bin) {
        return [{ kind: 'note', action: { target, kind: 'command', command: ['claude', ...CLAUDE_REMOVE_ARGS], status: 'manual', message: 'manual step' } }];
      }
      return [
        {
          kind: 'command',
          target,
          bin,
          program: 'claude',
          steps: [{ args: CLAUDE_REMOVE_ARGS, ignoreFailure: true }],
          success: 'removed',
          failureStatus: 'unchanged',
        },
      ];
    }
  }
}

/**
 * Removes managed files and registrations (default: targets with a managed agent file in `ctx.scope`).
 * Shared `.agents/skills` dirs go only when no remaining reader target keeps its managed agent file.
 */
export function uninstall(ctx: InstallContext, targets?: TargetId[]): InstallReport {
  assertContext(ctx);
  const chosen = targets ?? installedTargets(ctx);
  const run = new Run(ctx);
  const removed = new Set<TargetId>();
  const sharedRoots = new Set<string>();
  for (const target of chosen) {
    try {
      const layout = TARGETS[target].layout(ctx);
      const ops: Op[] = [];
      const agent = readIfExists(layout.agentPath);
      if (agent !== undefined && isManaged(agent)) {
        ops.push({ kind: 'remove-file', target, path: layout.agentPath, backup: false });
      } else if (agent !== undefined) {
        run.warn(`NOT_MANAGED: ${layout.agentPath} is not managed by overseer-cli; left in place.`);
        ops.push({ kind: 'note', action: { target, kind: 'file', path: layout.agentPath, status: 'skipped', message: 'NOT_MANAGED' } });
      }
      if (!layout.sharedSkills) ops.push(...planSkillsRemoval(run, target, layout.skillsDir));
      ops.push(...planMcpRemoval(run, target, layout.mcp));
      run.applyOps(ops);
      removed.add(target);
      if (layout.sharedSkills) sharedRoots.add(layout.skillsDir);
    } catch (error) {
      failTarget(run, target, error);
    }
  }
  for (const skillsDir of sharedRoots) {
    const remaining = TARGET_IDS.filter((id) => readsSharedSkills(id, ctx.scope) && !removed.has(id) && managedAgentExists(ctx, id));
    if (remaining.length > 0) {
      run.applyOps([
        { kind: 'note', action: { target: 'shared', kind: 'dir', path: skillsDir, status: 'skipped', message: `still used by ${remaining.join(', ')}` } },
      ]);
      continue;
    }
    run.applyOps(planSkillsRemoval(run, 'shared', skillsDir));
  }
  return { scope: ctx.scope, targets: chosen, actions: run.actions, warnings: run.warnings };
}

// ────────────────────────────── doctor ─────────────────────────────

/** Problem with a registration's command / script paths (user scope: both must exist; project: command on PATH), else undefined. */
function checkCommandPaths(command: unknown, args: unknown, ctx: InstallContext): string | undefined {
  if (ctx.scope === 'project') {
    return findExecutable(ctx, String(command)) ? undefined : `'${String(command)}' is not on PATH`;
  }
  const script = Array.isArray(args) ? args.find((arg) => typeof arg === 'string' && isAbsolute(arg)) : undefined;
  const missing = [command, script].filter((path) => typeof path !== 'string' || !existsSync(path));
  return missing.length > 0 ? `missing: ${missing.map(String).join(', ')}` : undefined;
}

function checkMcp(ctx: InstallContext, target: TargetId, mcp: McpSpec, installed: boolean): CheckLine {
  const label = `${target} (${ctx.scope}) mcp`;
  const absent = (detail: string): CheckLine => ({ status: installed ? 'FAIL' : 'WARN', label, detail });
  try {
    switch (mcp.type) {
      case 'claude-cli': {
        const bin = findExecutable(ctx, 'claude');
        if (!bin) return { status: 'WARN', label, detail: 'claude not on PATH; cannot verify (claude mcp get overseer)' };
        const info = claudeMcpGet(ctx, bin);
        if (!info.exists) return absent('claude mcp get overseer: not registered');
        const problem = info.command ? checkCommandPaths(info.command, info.args?.split(' '), ctx) : undefined;
        return problem ? { status: 'FAIL', label, detail: problem } : { status: 'OK', label, detail: `claude mcp get overseer: ${info.command ?? 'registered'}` };
      }
      case 'json': {
        const entry = getJsonValue(readIfExists(mcp.path), mcp.keyPath, mcp.path) as Record<string, unknown> | undefined;
        if (!entry) return absent(`no ${mcp.keyPath.join('.')} in ${mcp.path}`);
        // OpenCode stores the command as one array.
        const [command, ...args] = Array.isArray(entry.command) ? (entry.command as unknown[]) : [entry.command, ...((entry.args as unknown[]) ?? [])];
        const problem = checkCommandPaths(command, args, ctx);
        return { status: problem ? (ctx.scope === 'user' ? 'FAIL' : 'WARN') : 'OK', label, detail: problem ? `${mcp.path}: ${problem}` : mcp.path };
      }
      case 'toml': {
        const text = readIfExists(mcp.path);
        const entry = text === undefined ? undefined : readTomlServers(text, mcp.path).overseer;
        if (!entry) return absent(`no [mcp_servers.overseer] in ${mcp.path}`);
        const problem = checkCommandPaths(entry.command, entry.args, ctx);
        return { status: problem ? (ctx.scope === 'user' ? 'FAIL' : 'WARN') : 'OK', label, detail: problem ? `${mcp.path}: ${problem}` : mcp.path };
      }
    }
  } catch (error) {
    return { status: 'FAIL', label, detail: (error as Error).message };
  }
}

/** Doctor lines per target (default: detected targets) in `ctx.scope`: agent file, skills, MCP entry. */
export function checkInstall(ctx: InstallContext, targets: TargetId[] = detectTargets(ctx)): CheckLine[] {
  assertContext(ctx);
  const lines: CheckLine[] = [];
  for (const target of targets) {
    const layout = TARGETS[target].layout(ctx);
    const prefix = `${target} (${ctx.scope})`;
    const agent = readIfExists(layout.agentPath);
    const installed = isManaged(agent);
    lines.push(
      agent === undefined
        ? { status: 'WARN', label: `${prefix} agent`, detail: `not installed (${layout.agentPath}); run: overseer install --targets ${target}${ctx.scope === 'project' ? ' --scope project' : ''}` }
        : installed
          ? { status: 'OK', label: `${prefix} agent`, detail: layout.agentPath }
          : { status: 'WARN', label: `${prefix} agent`, detail: `${layout.agentPath} exists but is not managed by overseer-cli` },
    );
    const missing = SKILL_NAMES.filter((name) => !isManaged(readIfExists(join(layout.skillsDir, name, 'SKILL.md'))));
    lines.push(
      missing.length === 0
        ? { status: 'OK', label: `${prefix} skills`, detail: layout.skillsDir }
        : { status: installed ? 'FAIL' : 'WARN', label: `${prefix} skills`, detail: `missing or unmanaged in ${layout.skillsDir}: ${missing.join(', ')}` },
    );
    lines.push(checkMcp(ctx, target, layout.mcp, installed));
    if (target === 'opencode') lines.push({ status: 'OK', label: `${prefix} schema`, detail: `opencode config ${opencodeSchema(ctx)}` });
  }
  return lines;
}

/** One MCP server in a harness config: its name, and its URL or its command and arguments joined by spaces. */
export interface McpServerEntry {
  name: string;
  target: string;
}

function serverTarget(entry: Record<string, unknown>): string {
  const url = [entry.url, entry.httpUrl, entry.serverUrl].find((value) => typeof value === 'string');
  if (typeof url === 'string') return url;
  // OpenCode keeps the command and its arguments in one array.
  const command: unknown[] = Array.isArray(entry.command) ? entry.command : [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
  return command.filter((part) => typeof part === 'string').join(' ');
}

/**
 * MCP servers in `target`'s config for `ctx.scope`, read where overseer's own entry lives: the JSON/JSONC server
 * containers, Codex's `[mcp_servers.*]` tables, and for Claude Code's user scope `claude mcp get <name>` (with `name`)
 * or `claude mcp list`. With `name`, only the server of that name. Throws CONFIG_PARSE on a malformed config and
 * NOT_FOUND when claude is not on PATH.
 */
export function harnessMcpServers(ctx: InstallContext, target: TargetId, name?: string): McpServerEntry[] {
  assertContext(ctx);
  const mcp = TARGETS[target].layout(ctx).mcp;
  const servers: McpServerEntry[] = [];
  switch (mcp.type) {
    case 'claude-cli': {
      const bin = findExecutable(ctx, 'claude');
      if (!bin) throw new OverseerError('NOT_FOUND', 'claude is not on PATH');
      if (name !== undefined) {
        const info = claudeMcpGet(ctx, bin, name);
        return info.exists ? [{ name, target: info.url ?? [info.command, info.args].filter(Boolean).join(' ') }] : [];
      }
      const listed = claudeMcpList(ctx, bin);
      if (!listed) throw new Error('claude mcp list failed');
      servers.push(...listed);
      break;
    }
    case 'json': {
      const text = readIfExists(mcp.path);
      // OpenCode has two containers (`mcp` in v1, `mcp.servers` in v2): the v2 container is not a v1 server.
      const containers = [...new Map(mcp.removePaths.map((path) => [path.slice(0, -1).join('.'), path.slice(0, -1)])).values()];
      const keys = new Set(containers.map((path) => path.join('.')));
      for (const container of containers) {
        const value = getJsonValue(text, container, mcp.path);
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          if (entry && typeof entry === 'object' && !keys.has([...container, key].join('.'))) {
            servers.push({ name: key, target: serverTarget(entry as Record<string, unknown>) });
          }
        }
      }
      break;
    }
    case 'toml': {
      const text = readIfExists(mcp.path);
      const tables = text === undefined ? {} : readTomlServers(text, mcp.path);
      servers.push(...Object.entries(tables).map(([key, entry]) => ({ name: key, target: serverTarget(entry) })));
      break;
    }
  }
  return name === undefined ? servers : servers.filter((server) => server.name === name);
}

// ────────────────────────────── output ─────────────────────────────

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

/** Human-readable lines: `<status> <target> <path|command> (<message>)`, then warnings. */
export function formatInstallReport(report: InstallReport): string {
  const lines = [`scope: ${report.scope}; targets: ${report.targets.length > 0 ? report.targets.join(', ') : '(none)'}`];
  for (const action of report.actions) {
    const subject = action.command ? action.command.map(shellQuote).join(' ') : (action.path ?? '');
    const message = action.message ? `  (${action.message})` : '';
    lines.push(`  ${action.status.padEnd(9)} ${action.target.padEnd(8)} ${subject}${message}`);
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join('\n')}\n`;
}

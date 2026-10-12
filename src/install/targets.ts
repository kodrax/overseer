import { existsSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { stringify as stringifyToml } from 'smol-toml';
import { stringify as stringifyYaml } from 'yaml';
import { OverseerError } from '../core/errors.js';
import { findExecutable } from './exec.js';
import { opencodeSchema } from './opencode-version.js';
import type { InstallContext, TargetId } from './types.js';
import { MD_MARKER, SERVER_NAME, TOML_MARKER } from './types.js';

export const AGENT_DESCRIPTION =
  "Keeper of this project's requirements and Agile board (overseer). Use it to record requirements, user stories, tasks or bugs the user mentions; to check whether something is already covered, tracked or delivered; to plan or groom the backlog; to bootstrap requirements from an existing codebase; to import GitHub/GitLab issues; and to produce reports or exports. Returns item IDs and statuses.";

/** How the MCP server gets registered for a target in a scope. */
export type McpSpec =
  | {
      type: 'json';
      path: string;
      /** Key path of the overseer entry. */
      keyPath: string[];
      value: Record<string, unknown>;
      /** `$schema` written only when the file is created. */
      schema?: string;
      /** Every key path uninstall removes (covers both OpenCode schemas). */
      removePaths: string[][];
    }
  | { type: 'toml'; path: string; command: string; args: string[] }
  | { type: 'claude-cli' };

export interface TargetLayout {
  skillsDir: string;
  /** Skills dir shared with other harnesses (`~/.agents/skills`, `.agents/skills`). */
  sharedSkills: boolean;
  agentPath: string;
  mcp: McpSpec;
  /** Full agent file content for the given `templates/agent-prompt.md` text. */
  renderAgent(promptTemplate: string): string;
}

/** Whether a harness looks installed on this machine, with the evidence shown to the user. */
export interface Detection {
  /** CLI on PATH (Cursor: CLI or its app config dir). Only detected harnesses are selected by default. */
  detected: boolean;
  /** e.g. `claude on PATH (/usr/bin/claude)`, `~/.codex exists, but codex is not on PATH`, `not found`. */
  evidence: string;
}

export interface TargetSpec {
  id: TargetId;
  /** Display name, e.g. "Claude Code". */
  label: string;
  /** Harness present on this machine (independent of scope). */
  detect(ctx: InstallContext): Detection;
  layout(ctx: InstallContext): TargetLayout;
}

/** Targets that read the shared `.agents/skills` dir in the given scope. */
export function readsSharedSkills(id: TargetId, scope: InstallContext['scope']): boolean {
  return id === 'codex' || id === 'gemini' || id === 'copilot' || id === 'cursor' || (id === 'opencode' && scope === 'project');
}

const TOOL_PREFIX: Record<TargetId, string> = {
  claude: 'mcp__overseer__',
  omp: 'mcp__overseer_',
  codex: 'mcp__overseer__',
  gemini: 'mcp_overseer_',
  copilot: 'overseer-',
  cursor: '(harness-specific)',
  opencode: 'overseer_',
};

function scopeBase(ctx: InstallContext): string {
  if (ctx.scope === 'user') return ctx.home;
  if (!ctx.projectRoot) throw new OverseerError('INVALID_INPUT', 'Project scope requires a project directory.');
  return ctx.projectRoot;
}

const claudeDir = (ctx: InstallContext) => ctx.env.CLAUDE_CONFIG_DIR || join(ctx.home, '.claude');
const ompRoot = (ctx: InstallContext) => join(ctx.home, ctx.env.PI_CONFIG_DIR || '.omp');
const ompAgentDir = (ctx: InstallContext) => ctx.env.PI_CODING_AGENT_DIR || join(ompRoot(ctx), 'agent');
const codexHome = (ctx: InstallContext) => ctx.env.CODEX_HOME || join(ctx.home, '.codex');
const copilotHome = (ctx: InstallContext) => ctx.env.COPILOT_HOME || join(ctx.home, '.copilot');
const opencodeConfigDir = (ctx: InstallContext) => join(ctx.env.XDG_CONFIG_HOME || join(ctx.home, '.config'), 'opencode');

function mcpCommand(ctx: InstallContext): { command: string; args: string[] } {
  return ctx.scope === 'user'
    ? { command: ctx.nodePath, args: [ctx.cliPath, 'mcp'] }
    : { command: 'overseer', args: ['mcp'] };
}

/** Absolute (user scope) or project-relative POSIX (project scope) path of the main SKILL.md. */
function skillPath(ctx: InstallContext, skillsDir: string): string {
  const file = join(skillsDir, 'overseer', 'SKILL.md');
  return ctx.scope === 'user' ? file : relative(scopeBase(ctx), file).split(sep).join('/');
}

function renderBody(template: string, id: TargetId, skill: string, preface?: string): string {
  const body = template.replaceAll('{{SKILL_PATH}}', skill).replaceAll('{{TOOL_PREFIX}}', TOOL_PREFIX[id]).trim();
  return preface ? `${preface}\n\n${body}` : body;
}

function markdownAgent(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 })}---\n\n${body}\n\n${MD_MARKER}\n`;
}

/** `opencode.jsonc` when only that exists, else `opencode.json`. */
function opencodeConfigFile(dir: string): string {
  const jsonc = join(dir, 'opencode.jsonc');
  return !existsSync(join(dir, 'opencode.json')) && existsSync(jsonc) ? jsonc : join(dir, 'opencode.json');
}

function tildePath(ctx: InstallContext, path: string): string {
  return path === ctx.home || path.startsWith(ctx.home + sep) ? `~${path.slice(ctx.home.length)}` : path;
}

/** CLI harnesses count as installed only when their executable is on PATH: a config dir alone may be a leftover. */
function detectCli(ctx: InstallContext, bin: string, configDir: string): Detection {
  const binary = findExecutable(ctx, bin);
  if (binary) return { detected: true, evidence: `${bin} on PATH (${binary})` };
  if (existsSync(configDir)) return { detected: false, evidence: `${tildePath(ctx, configDir)} exists, but ${bin} is not on PATH` };
  return { detected: false, evidence: 'not found' };
}

export const TARGETS: Record<TargetId, TargetSpec> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    detect: (ctx) => detectCli(ctx, 'claude', claudeDir(ctx)),
    layout(ctx) {
      const root = ctx.scope === 'user' ? claudeDir(ctx) : join(scopeBase(ctx), '.claude');
      const skillsDir = join(root, 'skills');
      return {
        skillsDir,
        sharedSkills: false,
        agentPath: join(root, 'agents', 'overseer.md'),
        mcp:
          ctx.scope === 'user'
            ? { type: 'claude-cli' }
            : {
                type: 'json',
                path: join(scopeBase(ctx), '.mcp.json'),
                keyPath: ['mcpServers', SERVER_NAME],
                value: { type: 'stdio', ...mcpCommand(ctx) },
                removePaths: [['mcpServers', SERVER_NAME]],
              },
        renderAgent: (template) =>
          markdownAgent(
            { name: 'overseer', description: AGENT_DESCRIPTION, disallowedTools: 'Edit, Write, NotebookEdit', skills: ['overseer'] },
            renderBody(template, 'claude', skillPath(ctx, skillsDir)),
          ),
      };
    },
  },
  omp: {
    id: 'omp',
    label: 'OMP',
    detect: (ctx) => detectCli(ctx, 'omp', ompRoot(ctx)),
    layout(ctx) {
      const root = ctx.scope === 'user' ? ompAgentDir(ctx) : join(scopeBase(ctx), '.omp');
      const skillsDir = join(root, 'skills');
      return {
        skillsDir,
        sharedSkills: false,
        agentPath: join(root, 'agents', 'overseer.md'),
        mcp: {
          type: 'json',
          path: join(root, 'mcp.json'),
          keyPath: ['mcpServers', SERVER_NAME],
          value: { type: 'stdio', ...mcpCommand(ctx) },
          removePaths: [['mcpServers', SERVER_NAME]],
        },
        renderAgent: (template) =>
          markdownAgent(
            { name: 'overseer', description: AGENT_DESCRIPTION, autoloadSkills: ['overseer'] },
            renderBody(template, 'omp', skillPath(ctx, skillsDir)),
          ),
      };
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    detect: (ctx) => detectCli(ctx, 'codex', codexHome(ctx)),
    layout(ctx) {
      const base = scopeBase(ctx);
      const root = ctx.scope === 'user' ? codexHome(ctx) : join(base, '.codex');
      const skillsDir = join(base, '.agents', 'skills');
      const { command, args } = mcpCommand(ctx);
      return {
        skillsDir,
        sharedSkills: true,
        agentPath: join(root, 'agents', 'overseer.toml'),
        mcp: { type: 'toml', path: join(root, 'config.toml'), command, args },
        renderAgent(template) {
          const skill = skillPath(ctx, skillsDir);
          const body = renderBody(template, 'codex', skill, `Before anything else, read the overseer skill at \`${skill}\` and follow it.`);
          if (body.includes("'''")) {
            throw new OverseerError('INVALID_INPUT', "templates/agent-prompt.md must not contain ''' (TOML literal string delimiter).");
          }
          const header = stringifyToml({ name: 'overseer', description: AGENT_DESCRIPTION }).trim();
          return `${TOML_MARKER}\n${header}\ndeveloper_instructions = '''\n${body}\n'''\n`;
        },
      };
    },
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    detect: (ctx) => detectCli(ctx, 'gemini', join(ctx.home, '.gemini')),
    layout(ctx) {
      const base = scopeBase(ctx);
      const root = join(base, '.gemini');
      const skillsDir = join(base, '.agents', 'skills');
      return {
        skillsDir,
        sharedSkills: true,
        agentPath: join(root, 'agents', 'overseer.md'),
        mcp: {
          type: 'json',
          path: join(root, 'settings.json'),
          keyPath: ['mcpServers', SERVER_NAME],
          value: { ...mcpCommand(ctx), timeout: 120_000 },
          removePaths: [['mcpServers', SERVER_NAME]],
        },
        renderAgent: (template) =>
          markdownAgent(
            { name: 'overseer', description: AGENT_DESCRIPTION, kind: 'local' },
            renderBody(
              template,
              'gemini',
              skillPath(ctx, skillsDir),
              'Call activate_skill for `overseer` first (and `overseer-bootstrap` or `overseer-import` when the task matches).',
            ),
          ),
      };
    },
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    detect: (ctx) => detectCli(ctx, 'copilot', copilotHome(ctx)),
    layout(ctx) {
      const base = scopeBase(ctx);
      const user = ctx.scope === 'user';
      const skillsDir = join(base, '.agents', 'skills');
      return {
        skillsDir,
        sharedSkills: true,
        agentPath: user ? join(copilotHome(ctx), 'agents', 'overseer.agent.md') : join(base, '.github', 'agents', 'overseer.agent.md'),
        mcp: {
          type: 'json',
          path: user ? join(copilotHome(ctx), 'mcp-config.json') : join(base, '.github', 'mcp.json'),
          keyPath: ['mcpServers', SERVER_NAME],
          value: { type: 'local', ...mcpCommand(ctx), tools: ['*'] },
          removePaths: [['mcpServers', SERVER_NAME]],
        },
        renderAgent: (template) =>
          markdownAgent({ name: 'overseer', description: AGENT_DESCRIPTION }, renderBody(template, 'copilot', skillPath(ctx, skillsDir))),
      };
    },
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    detect(ctx) {
      const binary = findExecutable(ctx, 'cursor-agent') ?? findExecutable(ctx, 'cursor');
      if (binary) return { detected: true, evidence: `${basename(binary)} on PATH (${binary})` };
      // Cursor is a desktop app that often installs no shell command; its config dir is the best signal.
      const dir = join(ctx.home, '.cursor');
      return existsSync(dir) ? { detected: true, evidence: `${tildePath(ctx, dir)} exists (Cursor app)` } : { detected: false, evidence: 'not found' };
    },
    layout(ctx) {
      const base = scopeBase(ctx);
      const root = join(base, '.cursor');
      const skillsDir = join(base, '.agents', 'skills');
      const command = ctx.scope === 'user' ? mcpCommand(ctx) : { command: 'overseer', args: ['mcp', '--project', '${workspaceFolder}'] };
      return {
        skillsDir,
        sharedSkills: true,
        agentPath: join(root, 'agents', 'overseer.md'),
        mcp: {
          type: 'json',
          path: join(root, 'mcp.json'),
          keyPath: ['mcpServers', SERVER_NAME],
          value: { type: 'stdio', ...command },
          removePaths: [['mcpServers', SERVER_NAME]],
        },
        renderAgent: (template) =>
          markdownAgent(
            { name: 'overseer', description: AGENT_DESCRIPTION, model: 'inherit' },
            renderBody(template, 'cursor', skillPath(ctx, skillsDir)),
          ),
      };
    },
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    detect: (ctx) => detectCli(ctx, 'opencode', opencodeConfigDir(ctx)),
    layout(ctx) {
      const user = ctx.scope === 'user';
      const base = scopeBase(ctx);
      const v2 = opencodeSchema(ctx) === 'v2';
      const skillsDir = user ? join(opencodeConfigDir(ctx), 'skills') : join(base, '.agents', 'skills');
      const { command, args } = mcpCommand(ctx);
      const permission = v2
        ? { permissions: [{ action: 'edit', resource: '*', effect: 'deny' }] }
        : { permission: { edit: 'deny' } };
      return {
        skillsDir,
        sharedSkills: !user,
        agentPath: user ? join(opencodeConfigDir(ctx), 'agents', 'overseer.md') : join(base, '.opencode', 'agents', 'overseer.md'),
        mcp: {
          type: 'json',
          path: opencodeConfigFile(user ? opencodeConfigDir(ctx) : base),
          keyPath: v2 ? ['mcp', 'servers', SERVER_NAME] : ['mcp', SERVER_NAME],
          value: v2
            ? { type: 'local', command: [command, ...args], codemode: false }
            : { type: 'local', command: [command, ...args], enabled: true },
          schema: v2 ? undefined : 'https://opencode.ai/config.json',
          removePaths: [
            ['mcp', SERVER_NAME],
            ['mcp', 'servers', SERVER_NAME],
          ],
        },
        renderAgent: (template) =>
          markdownAgent(
            { description: AGENT_DESCRIPTION, mode: 'subagent', ...permission },
            renderBody(template, 'opencode', skillPath(ctx, skillsDir)),
          ),
      };
    },
  },
};

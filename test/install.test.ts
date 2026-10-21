import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { InstallReport, Scope, TargetId } from '../src/install/index.js';
import { detectTargets, formatInstallReport, harnessStatus, install, TARGET_IDS } from '../src/install/index.js';
import { CLI_PATH, GOLDEN_DIR, mtimes, NODE_PATH, sandbox, snapshotTree } from './fixtures/install/harness.js';

const SKILL_FILES = [
  'overseer/SKILL.md',
  'overseer/references/fields.md',
  'overseer-bootstrap/SKILL.md',
  'overseer-import/SKILL.md',
  'overseer-ship/SKILL.md',
  'overseer-sync/SKILL.md',
];
const skills = (dir: string) => SKILL_FILES.map((file) => `${dir}/${file}`);

/** Files each target owns, relative to HOME (user) or the project root (project). */
const EXPECTED_FILES: Record<Scope, Record<TargetId, string[]>> = {
  user: {
    claude: ['.claude/agents/overseer.md', ...skills('.claude/skills')],
    omp: ['.omp/agent/agents/overseer.md', '.omp/agent/mcp.json', ...skills('.omp/agent/skills')],
    codex: ['.codex/agents/overseer.toml', '.codex/config.toml', ...skills('.agents/skills')],
    gemini: ['.gemini/agents/overseer.md', '.gemini/settings.json', ...skills('.agents/skills')],
    copilot: ['.copilot/agents/overseer.agent.md', '.copilot/mcp-config.json', ...skills('.agents/skills')],
    cursor: ['.cursor/agents/overseer.md', '.cursor/mcp.json', ...skills('.agents/skills')],
    opencode: ['.config/opencode/agents/overseer.md', '.config/opencode/opencode.json', ...skills('.config/opencode/skills')],
  },
  project: {
    claude: ['.claude/agents/overseer.md', '.mcp.json', ...skills('.claude/skills')],
    omp: ['.omp/agents/overseer.md', '.omp/mcp.json', ...skills('.omp/skills')],
    codex: ['.codex/agents/overseer.toml', '.codex/config.toml', ...skills('.agents/skills')],
    gemini: ['.gemini/agents/overseer.md', '.gemini/settings.json', ...skills('.agents/skills')],
    copilot: ['.github/agents/overseer.agent.md', '.github/mcp.json', ...skills('.agents/skills')],
    cursor: ['.cursor/agents/overseer.md', '.cursor/mcp.json', ...skills('.agents/skills')],
    opencode: ['.opencode/agents/overseer.md', 'opencode.json', ...skills('.agents/skills')],
  },
};

const ALL = [...TARGET_IDS];

/**
 * Golden trees live in test/fixtures/install/golden-<scope>.json with the sandbox dir replaced by {{BASE}}.
 * Regenerate with OVERSEER_UPDATE_GOLDEN=1 after an intended format change (review the diff).
 */
function expectGolden(scope: Scope, base: string): void {
  const file = join(GOLDEN_DIR, `golden-${scope}.json`);
  const actual = JSON.parse(JSON.stringify(snapshotTree(base)).replaceAll(base, '{{BASE}}')) as Record<string, string>;
  if (process.env.OVERSEER_UPDATE_GOLDEN === '1') writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
  const golden = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  expect(actual).toEqual(golden);
}

function statuses(report: InstallReport): string[] {
  return [...new Set(report.actions.map((action) => action.status))];
}

describe('install golden trees', () => {
  test('user scope, all targets: exact files and claude registration via CLI', () => {
    const box = sandbox({ shims: ['claude', 'opencode'] });
    const report = install(box.ctx('user'), ALL);
    expect(report.warnings).toEqual([]);
    expect(statuses(report)).toEqual(['created']);
    expectGolden('user', box.home);
    expect(box.claudeCalls()).toEqual([
      'mcp get overseer',
      'mcp remove --scope user overseer',
      `mcp add --scope user --transport stdio overseer -- ${NODE_PATH} ${CLI_PATH} mcp`,
    ]);
    // Second run: everything unchanged, nothing rewritten, claude only queried.
    const before = mtimes(box.home);
    const again = install(box.ctx('user'), ALL);
    expect(statuses(again)).toEqual(['unchanged']);
    expect(mtimes(box.home)).toEqual(before);
    expect(box.claudeCalls().slice(3)).toEqual(['mcp get overseer']);
  });

  test('project scope, all targets: exact files, second run unchanged', () => {
    const box = sandbox({ shims: ['claude', 'opencode'] });
    const report = install(box.ctx('project'), ALL);
    expect(report.warnings).toEqual([]);
    expect(statuses(report)).toEqual(['created']);
    expectGolden('project', box.project);
    expect(existsSync(join(box.home, '.claude'))).toBe(false);
    expect(box.claudeCalls()).toEqual([]);
    const before = mtimes(box.project);
    expect(statuses(install(box.ctx('project'), ALL))).toEqual(['unchanged']);
    expect(mtimes(box.project)).toEqual(before);
  });

  for (const scope of ['user', 'project'] as const) {
    for (const target of TARGET_IDS) {
      test(`${target} × ${scope} writes exactly its own files`, () => {
        const box = sandbox();
        const base = scope === 'user' ? box.home : box.project;
        const report = install(box.ctx(scope), [target]);
        expect(report.actions.filter((action) => action.status === 'failed')).toEqual([]);
        expect(Object.keys(snapshotTree(base)).sort()).toEqual([...EXPECTED_FILES[scope][target]].sort());
      });
    }
  }
});

describe('generated formats', () => {
  test('user-scope MCP entries use node + absolute cli.js', () => {
    const box = sandbox({ shims: ['opencode'] });
    install(box.ctx('user'), ALL);
    const json = (rel: string) => JSON.parse(readFileSync(join(box.home, rel), 'utf8'));
    const stdio = { command: NODE_PATH, args: [CLI_PATH, 'mcp'] };
    expect(json('.omp/agent/mcp.json').mcpServers.overseer).toEqual({ type: 'stdio', ...stdio });
    expect(json('.gemini/settings.json').mcpServers.overseer).toEqual({ ...stdio, timeout: 120000 });
    expect(json('.copilot/mcp-config.json').mcpServers.overseer).toEqual({ type: 'local', ...stdio, tools: ['*'] });
    expect(json('.cursor/mcp.json').mcpServers.overseer).toEqual({ type: 'stdio', ...stdio });
    expect(json('.config/opencode/opencode.json')).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: { overseer: { type: 'local', command: [NODE_PATH, CLI_PATH, 'mcp'], enabled: true } },
    });
    const toml = parseToml(readFileSync(join(box.home, '.codex/config.toml'), 'utf8')) as { mcp_servers: Record<string, unknown> };
    expect(toml.mcp_servers.overseer).toEqual({ ...stdio, startup_timeout_sec: 30, tool_timeout_sec: 120 });
  });

  test('project-scope MCP entries use the overseer binary; cursor passes ${workspaceFolder}', () => {
    const box = sandbox();
    install(box.ctx('project'), ALL);
    const json = (rel: string) => JSON.parse(readFileSync(join(box.project, rel), 'utf8'));
    expect(json('.mcp.json').mcpServers.overseer).toEqual({ type: 'stdio', command: 'overseer', args: ['mcp'] });
    expect(json('.cursor/mcp.json').mcpServers.overseer).toEqual({
      type: 'stdio',
      command: 'overseer',
      args: ['mcp', '--project', '${workspaceFolder}'],
    });
    expect(json('.github/mcp.json').mcpServers.overseer).toEqual({ type: 'local', command: 'overseer', args: ['mcp'], tools: ['*'] });
    expect(json('opencode.json').mcp.overseer.command).toEqual(['overseer', 'mcp']);
  });

  test('markdown agents: frontmatter on line 1, marker last; codex TOML agent parses', () => {
    const box = sandbox();
    install(box.ctx('project'), ALL);
    const agents: Record<string, Record<string, unknown>> = {
      '.claude/agents/overseer.md': { name: 'overseer', disallowedTools: 'Edit, Write, NotebookEdit', skills: ['overseer'] },
      '.omp/agents/overseer.md': { name: 'overseer', autoloadSkills: ['overseer'] },
      '.gemini/agents/overseer.md': { name: 'overseer', kind: 'local' },
      '.github/agents/overseer.agent.md': { name: 'overseer' },
      '.cursor/agents/overseer.md': { name: 'overseer', model: 'inherit' },
      '.opencode/agents/overseer.md': { mode: 'subagent', permission: { edit: 'deny' } },
    };
    for (const [rel, expected] of Object.entries(agents)) {
      const text = readFileSync(join(box.project, rel), 'utf8');
      expect(text.startsWith('---\n'), rel).toBe(true);
      expect(text.endsWith('\n<!-- managed-by: overseer-cli -->\n'), rel).toBe(true);
      const frontmatter = parseYaml(text.split('---\n')[1]!) as Record<string, unknown>;
      expect(frontmatter, rel).toMatchObject(expected);
      expect(String(frontmatter.description)).toMatch(/^Keeper of this project's requirements/);
      expect(text).not.toContain('{{');
    }
    const gemini = readFileSync(join(box.project, '.gemini/agents/overseer.md'), 'utf8');
    expect(gemini.split('---\n')[2]!.trimStart().startsWith('Call activate_skill for `overseer` first')).toBe(true);
    const codexText = readFileSync(join(box.project, '.codex/agents/overseer.toml'), 'utf8');
    expect(codexText.startsWith('# managed-by: overseer-cli\n')).toBe(true);
    const codex = parseToml(codexText) as Record<string, string>;
    expect(codex.name).toBe('overseer');
    expect(codex.developer_instructions).toContain('.agents/skills/overseer/SKILL.md');
    expect(codex.developer_instructions).toContain('mcp__overseer__find_similar');
  });

  test('tool prefixes and skill paths per harness', () => {
    const box = sandbox();
    install(box.ctx('user'), ALL);
    const body = (rel: string) => readFileSync(join(box.home, rel), 'utf8');
    expect(body('.claude/agents/overseer.md')).toContain(`${box.home}/.claude/skills/overseer/SKILL.md`);
    expect(body('.claude/agents/overseer.md')).toContain('mcp__overseer__find_similar');
    expect(body('.omp/agent/agents/overseer.md')).toContain('mcp__overseer_find_similar');
    expect(body('.gemini/agents/overseer.md')).toContain('mcp_overseer_find_similar');
    expect(body('.copilot/agents/overseer.agent.md')).toContain('overseer-find_similar');
    expect(body('.cursor/agents/overseer.md')).toContain('(harness-specific)find_similar');
    expect(body('.config/opencode/agents/overseer.md')).toContain('overseer_find_similar');
    expect(body('.config/opencode/agents/overseer.md')).toContain(`${box.home}/.config/opencode/skills/overseer/SKILL.md`);
  });
});

describe('context-driven paths', () => {
  test('env overrides move user-scope config dirs', () => {
    const box = sandbox({
      env: {
        CLAUDE_CONFIG_DIR: '/placeholder',
        PI_CODING_AGENT_DIR: '/placeholder',
        CODEX_HOME: '/placeholder',
        COPILOT_HOME: '/placeholder',
        XDG_CONFIG_HOME: '/placeholder',
      },
    });
    const dirs = {
      CLAUDE_CONFIG_DIR: join(box.root, 'claude-config'),
      PI_CODING_AGENT_DIR: join(box.root, 'omp-agent'),
      CODEX_HOME: join(box.root, 'codex-home'),
      COPILOT_HOME: join(box.root, 'copilot-home'),
      XDG_CONFIG_HOME: join(box.root, 'xdg'),
    };
    const ctx = box.ctx('user');
    ctx.env = { ...ctx.env, ...dirs };
    install(ctx, ALL);
    expect(existsSync(join(dirs.CLAUDE_CONFIG_DIR, 'agents/overseer.md'))).toBe(true);
    expect(existsSync(join(dirs.CLAUDE_CONFIG_DIR, 'skills/overseer/SKILL.md'))).toBe(true);
    expect(existsSync(join(dirs.PI_CODING_AGENT_DIR, 'mcp.json'))).toBe(true);
    expect(existsSync(join(dirs.CODEX_HOME, 'agents/overseer.toml'))).toBe(true);
    expect(existsSync(join(dirs.CODEX_HOME, 'config.toml'))).toBe(true);
    expect(existsSync(join(dirs.COPILOT_HOME, 'mcp-config.json'))).toBe(true);
    expect(existsSync(join(dirs.XDG_CONFIG_HOME, 'opencode/opencode.json'))).toBe(true);
    expect(Object.keys(snapshotTree(box.home)).every((rel) => /^\.(agents|gemini|cursor)\//.test(rel))).toBe(true);
  });

  test('detection: a CLI on PATH counts, a leftover config dir does not (except the Cursor app dir)', () => {
    const box = sandbox({ shims: ['claude', 'opencode'] });
    expect(detectTargets(box.ctx('user'))).toEqual(['claude', 'opencode']);
    for (const dir of ['.omp', '.codex', '.gemini', '.copilot', '.cursor']) mkdirSync(join(box.home, dir));
    expect(detectTargets(box.ctx('user'))).toEqual(['claude', 'cursor', 'opencode']);
    const evidence = Object.fromEntries(harnessStatus(box.ctx('user')).map((status) => [status.target, status.evidence]));
    expect(evidence).toMatchObject({
      claude: expect.stringMatching(/^claude on PATH \(.+\/claude\)$/),
      codex: '~/.codex exists, but codex is not on PATH',
      cursor: '~/.cursor exists (Cursor app)',
    });
    install(box.ctx('user'), ['codex']);
    expect(harnessStatus(box.ctx('user')).find((status) => status.target === 'codex')).toMatchObject({ detected: false, installed: true });
  });

  test('install defaults to detected targets', () => {
    const box = sandbox();
    mkdirSync(join(box.home, '.cursor'));
    const report = install(box.ctx('user'));
    expect(report.targets).toEqual(['cursor']);
  });

  test('project scope without projectRoot is rejected', () => {
    const box = sandbox();
    expect(() => install({ ...box.ctx('project'), projectRoot: undefined }, ['omp'])).toThrow(/Project scope requires/);
  });
});

describe('dry run', () => {
  test('reports every planned write and command, changes nothing', () => {
    const box = sandbox({ shims: ['claude', 'opencode'] });
    const report = install(box.ctx('user', { dryRun: true }), ALL);
    expect(snapshotTree(box.home)).toEqual({});
    expect(statuses(report)).toEqual(['planned']);
    const planned = report.actions.map((action) => action.path ?? action.command!.join(' '));
    expect(planned).toContain(join(box.home, '.codex/config.toml'));
    expect(planned).toContain('claude mcp remove --scope user overseer');
    expect(planned).toContain(`claude mcp add --scope user --transport stdio overseer -- ${NODE_PATH} ${CLI_PATH} mcp`);
    // Claude Code writes ~/.claude.json even for `mcp get`, so a dry run must not spawn it at all.
    expect(box.claudeCalls()).toEqual([]);
    const text = formatInstallReport(report);
    expect(text).toContain('planned');
    expect(text).toContain(join(box.home, '.agents/skills/overseer'));
  });
});

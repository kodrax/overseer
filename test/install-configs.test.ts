import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { checkInstall, formatInstallReport, install, TARGET_IDS, uninstall } from '../src/install/index.js';
import { CLI_PATH, listDirs, mtimes, NODE_PATH, readText, sandbox, snapshotTree, writeFile } from './fixtures/install/harness.js';

const ALL = [...TARGET_IDS];

describe('JSON configs', () => {
  const settings = `{
  // user comment: keep me
  "theme": "dark",
  "mcpServers": {
    /* another server */
    "other": { "command": "other-mcp" }
  }
}
`;

  test('existing JSONC keeps comments and keys; backup made once; uninstall restores the original text', () => {
    const box = sandbox();
    const file = join(box.home, '.gemini/settings.json');
    writeFile(file, settings);
    install(box.ctx('user'), ['gemini']);
    const edited = readFileSync(file, 'utf8');
    expect(edited).toContain('// user comment: keep me');
    expect(edited).toContain('/* another server */');
    expect(edited).toContain('"other": { "command": "other-mcp" }');
    expect(edited).toContain('"overseer"');
    expect(edited).not.toContain('$schema');
    expect(readFileSync(`${file}.overseer-backup`, 'utf8')).toBe(settings);

    const report = uninstall(box.ctx('user'), ['gemini']);
    expect(report.actions.find((action) => action.path === file)?.status).toBe('updated');
    expect(readFileSync(file, 'utf8')).toBe(settings);
  });

  test('malformed JSON aborts the target before any write', () => {
    const box = sandbox();
    const file = join(box.home, '.cursor/mcp.json');
    writeFile(file, '{ "mcpServers": { ');
    const report = install(box.ctx('user'), ['cursor', 'omp']);
    const failed = report.actions.filter((action) => action.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ target: 'cursor', message: expect.stringMatching(/^CONFIG_PARSE: /) });
    expect(readFileSync(file, 'utf8')).toBe('{ "mcpServers": { ');
    expect(existsSync(join(box.home, '.cursor/agents/overseer.md'))).toBe(false);
    expect(existsSync(join(box.home, '.agents/skills'))).toBe(false);
    expect(existsSync(join(box.home, '.omp/agent/mcp.json'))).toBe(true);
  });

  test('an outdated entry is updated in place', () => {
    const box = sandbox();
    install(box.ctx('user'), ['omp']);
    const report = install(box.ctx('user', { cliPath: '/new/dist/cli.js' }), ['omp']);
    const file = join(box.home, '.omp/agent/mcp.json');
    expect(report.actions.find((action) => action.path === file)?.status).toBe('updated');
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.overseer.args).toEqual(['/new/dist/cli.js', 'mcp']);
    expect(existsSync(`${file}.overseer-backup`)).toBe(true);
  });

  test('BUG-0003: uninstall and later installs keep the original backup', () => {
    const box = sandbox();
    const file = join(box.home, '.gemini/settings.json');
    const original = '{\n  "theme": "Dracula"\n}\n';
    writeFile(file, original);
    install(box.ctx('user'), ['gemini']);
    expect(readFileSync(`${file}.overseer-backup`, 'utf8')).toBe(original);
    uninstall(box.ctx('user'), ['gemini']);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readFileSync(`${file}.overseer-backup`, 'utf8')).toBe(original);
    // A later install that changes the file does not overwrite the existing backup.
    writeFile(file, '{\n  "theme": "Light"\n}\n');
    install(box.ctx('user'), ['gemini']);
    expect(readFileSync(`${file}.overseer-backup`, 'utf8')).toBe(original);
  });

  test('BUG-0003: uninstall never creates a backup', () => {
    const box = sandbox();
    const file = join(box.home, '.gemini/settings.json');
    writeFile(file, '{\n  "theme": "Dracula"\n}\n');
    install(box.ctx('user'), ['gemini']);
    rmSync(`${file}.overseer-backup`);
    uninstall(box.ctx('user'), ['gemini']);
    expect(existsSync(`${file}.overseer-backup`)).toBe(false);
  });
});

describe('TOML config (codex)', () => {
  const userToml = `model = "o4"

[projects."/work"]
trust_level = "trusted"
`;

  test('block appended to existing config, replaced on change, removed on uninstall', () => {
    const box = sandbox();
    const file = join(box.home, '.codex/config.toml');
    writeFile(file, userToml);
    install(box.ctx('user'), ['codex']);
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith(userToml)).toBe(true);
    expect(text.slice(userToml.length)).toBe(
      `\n# >>> overseer (managed by overseer-cli) >>>\n[mcp_servers.overseer]\ncommand = "${NODE_PATH}"\nargs = [ "${CLI_PATH}", "mcp" ]\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\n# <<< overseer <<<\n`,
    );
    install(box.ctx('user', { nodePath: '/usr/bin/node' }), ['codex']);
    const replaced = readFileSync(file, 'utf8');
    expect(replaced.match(/# >>> overseer/g)).toHaveLength(1);
    expect(replaced).toContain('command = "/usr/bin/node"');
    uninstall(box.ctx('user'), ['codex']);
    expect(readFileSync(file, 'utf8')).toBe(userToml);
  });

  test('malformed TOML aborts the codex target with the file untouched', () => {
    const box = sandbox();
    const file = join(box.home, '.codex/config.toml');
    const broken = 'model = "o4\n[broken\n';
    writeFile(file, broken);
    const report = install(box.ctx('user'), ['codex', 'gemini']);
    const failed = report.actions.filter((action) => action.status === 'failed');
    expect(failed).toEqual([expect.objectContaining({ target: 'codex', message: expect.stringMatching(/^CONFIG_PARSE: /) })]);
    expect(readFileSync(file, 'utf8')).toBe(broken);
    expect(existsSync(`${file}.overseer-backup`)).toBe(false);
    expect(existsSync(join(box.home, '.codex/agents/overseer.toml'))).toBe(false);
    // gemini still installs, including the shared skills codex would have written.
    expect(existsSync(join(box.home, '.gemini/agents/overseer.md'))).toBe(true);
    expect(existsSync(join(box.home, '.agents/skills/overseer/SKILL.md'))).toBe(true);
    expect(report.warnings.some((warning) => warning.startsWith('codex: CONFIG_PARSE'))).toBe(true);
  });

  test('user-defined [mcp_servers.overseer] outside the block is left alone with a warning', () => {
    const box = sandbox();
    const file = join(box.home, '.codex/config.toml');
    const own = '[mcp_servers.overseer]\ncommand = "my-overseer"\n';
    writeFile(file, own);
    const report = install(box.ctx('user'), ['codex']);
    expect(report.actions.find((action) => action.path === file)?.status).toBe('skipped');
    expect(report.warnings.join('\n')).toMatch(/already defined outside the overseer managed block/);
    expect(readFileSync(file, 'utf8')).toBe(own);
    expect(existsSync(join(box.home, '.codex/agents/overseer.toml'))).toBe(true);
  });
});

describe('ownership', () => {
  test('unmanaged agent file is skipped without force and overwritten (with backup) with force', () => {
    const box = sandbox();
    const file = join(box.home, '.cursor/agents/overseer.md');
    writeFile(file, '---\nname: overseer\n---\nmine\n');
    const skipped = install(box.ctx('user'), ['cursor']);
    expect(skipped.actions.find((action) => action.path === file)).toMatchObject({ status: 'skipped', message: 'NOT_MANAGED' });
    expect(skipped.warnings.join('\n')).toMatch(/NOT_MANAGED: .*overseer\.md exists and is not managed/);
    expect(readFileSync(file, 'utf8')).toBe('---\nname: overseer\n---\nmine\n');
    // the rest of the target still installs
    expect(existsSync(join(box.home, '.cursor/mcp.json'))).toBe(true);

    const forced = install(box.ctx('user', { force: true }), ['cursor']);
    expect(forced.actions.find((action) => action.path === file)?.status).toBe('updated');
    expect(readFileSync(file, 'utf8')).toContain('<!-- managed-by: overseer-cli -->');
    expect(readFileSync(`${file}.overseer-backup`, 'utf8')).toBe('---\nname: overseer\n---\nmine\n');
  });

  test('unmanaged skill dir is skipped without force and never removed by uninstall', () => {
    const box = sandbox();
    const skill = join(box.home, '.claude/skills/overseer/SKILL.md');
    writeFile(skill, '---\nname: overseer\ndescription: mine\n---\n');
    const report = install(box.ctx('user'), ['claude']);
    expect(report.actions.find((action) => action.path === join(box.home, '.claude/skills/overseer'))?.status).toBe('skipped');
    expect(readFileSync(skill, 'utf8')).toBe('---\nname: overseer\ndescription: mine\n---\n');
    uninstall(box.ctx('user'), ['claude']);
    expect(readFileSync(skill, 'utf8')).toBe('---\nname: overseer\ndescription: mine\n---\n');
    expect(existsSync(join(box.home, '.claude/skills/overseer-import'))).toBe(false);
  });
});

describe('uninstall', () => {
  test('leaves only pre-existing user content and backups (user scope, all targets)', () => {
    const box = sandbox({ shims: ['claude', 'opencode'] });
    writeFile(join(box.home, '.gemini/settings.json'), '{\n  // mine\n  "theme": "dark"\n}\n');
    writeFile(join(box.home, '.codex/config.toml'), 'model = "o4"\n');
    writeFile(join(box.home, '.agents/skills/other/SKILL.md'), '---\nname: other\n---\n');
    writeFile(join(box.home, '.claude/agents/reviewer.md'), '---\nname: reviewer\n---\n');
    writeFile(join(box.home, '.config/opencode/opencode.json'), '{\n  "theme": "x",\n  "mcp": {\n    "keep": { "type": "local", "command": ["k"] }\n  }\n}\n');
    const original = snapshotTree(box.home);
    const originalDirs = listDirs(box.home);

    install(box.ctx('user'), ALL);
    const report = uninstall(box.ctx('user'));
    expect(report.targets).toEqual(ALL);
    expect(report.actions.filter((action) => action.status === 'failed')).toEqual([]);

    const after = snapshotTree(box.home);
    const backups = Object.keys(after).filter((rel) => rel.endsWith('.overseer-backup'));
    expect(backups.sort()).toEqual(['.codex/config.toml.overseer-backup', '.config/opencode/opencode.json.overseer-backup', '.gemini/settings.json.overseer-backup']);
    for (const rel of backups) delete after[rel];
    expect(after).toEqual(original);
    // Directories install created (.omp, .cursor, .claude/skills, …) go too once they are empty.
    expect(listDirs(box.home)).toEqual(originalDirs);
    expect(box.claudeCalls().at(-1)).toBe('mcp remove --scope user overseer');
    expect(readText(box.claudeState)).toBe('');
  });

  test('project scope: removes everything it created', () => {
    const box = sandbox();
    install(box.ctx('project'), ALL);
    const report = uninstall(box.ctx('project'));
    expect(report.targets).toEqual(ALL);
    expect(readdirSync(box.project)).toEqual([]);
  });

  test('shared .agents/skills stay while another reader target keeps its agent file', () => {
    const box = sandbox();
    install(box.ctx('user'), ['codex', 'gemini']);
    const shared = join(box.home, '.agents/skills');
    const first = uninstall(box.ctx('user'), ['codex']);
    expect(first.actions.find((action) => action.target === 'shared')).toMatchObject({ status: 'skipped', message: 'still used by gemini' });
    expect(existsSync(join(shared, 'overseer/SKILL.md'))).toBe(true);
    expect(existsSync(join(box.home, '.codex/agents/overseer.toml'))).toBe(false);
    // default targets = those with a managed agent file → gemini only
    const second = uninstall(box.ctx('user'));
    expect(second.targets).toEqual(['gemini']);
    expect(existsSync(join(shared, 'overseer'))).toBe(false);
  });

  test('opencode user scope does not read the shared skills dir', () => {
    const box = sandbox();
    install(box.ctx('user'), ['cursor', 'opencode']);
    uninstall(box.ctx('user'), ['cursor']);
    expect(existsSync(join(box.home, '.agents/skills/overseer'))).toBe(false);
    expect(existsSync(join(box.home, '.config/opencode/skills/overseer/SKILL.md'))).toBe(true);
  });

  test('dry run reports removals and changes nothing', () => {
    const box = sandbox();
    install(box.ctx('project'), ALL);
    const before = snapshotTree(box.project);
    const stamps = mtimes(box.project);
    const report = uninstall(box.ctx('project', { dryRun: true }));
    expect(new Set(report.actions.map((action) => action.status))).toEqual(new Set(['planned']));
    expect(snapshotTree(box.project)).toEqual(before);
    expect(mtimes(box.project)).toEqual(stamps);
  });
});

describe('claude user scope', () => {
  test('without claude on PATH: manual step with the exact command', () => {
    const box = sandbox();
    const report = install(box.ctx('user'), ['claude']);
    const manual = report.actions.find((action) => action.kind === 'command');
    expect(manual).toMatchObject({
      status: 'manual',
      command: ['claude', 'mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'overseer', '--', NODE_PATH, CLI_PATH, 'mcp'],
    });
    expect(formatInstallReport(report)).toContain(`manual    claude   claude mcp add --scope user --transport stdio overseer -- ${NODE_PATH} ${CLI_PATH} mcp  (manual step)`);
  });

  test('a registration pointing elsewhere is replaced; uninstall of an absent server is tolerated', () => {
    const box = sandbox({ shims: ['claude'] });
    writeFileSync(
      box.claudeState,
      'overseer:\n  Scope: User config (available in all your projects)\n  Status: ✓ Connected\n  Type: stdio\n  Command: /old/node\n  Args: /old/cli.js mcp\n',
    );
    const report = install(box.ctx('user'), ['claude']);
    expect(report.actions.find((action) => action.kind === 'command')?.status).toBe('updated');
    expect(readText(box.claudeState)).toContain(`Command: ${NODE_PATH}`);
    uninstall(box.ctx('user'), ['claude']);
    const again = uninstall(box.ctx('user'), ['claude']);
    expect(again.actions.find((action) => action.kind === 'command')).toMatchObject({ status: 'unchanged', message: 'not registered' });
    expect(again.warnings).toEqual([]);
  });
});

describe('opencode schema selection', () => {
  test('opencode --version major ≥ 2 → V2 config and frontmatter', () => {
    const box = sandbox({ shims: ['opencode'], env: { OVS_OPENCODE_VERSION: '2.0.3' } });
    install(box.ctx('project'), ['opencode']);
    expect(JSON.parse(readFileSync(join(box.project, 'opencode.json'), 'utf8'))).toEqual({
      mcp: { servers: { overseer: { type: 'local', command: ['overseer', 'mcp'], codemode: false } } },
    });
    const agent = readFileSync(join(box.project, '.opencode/agents/overseer.md'), 'utf8');
    expect(parseYaml(agent.split('---\n')[1]!)).toMatchObject({
      mode: 'subagent',
      permissions: [{ action: 'edit', resource: '*', effect: 'deny' }],
    });
    expect(readText(box.opencodeLog)).toBe('--version\n');
    uninstall(box.ctx('project'), ['opencode']);
    expect(existsSync(join(box.project, 'opencode.json'))).toBe(false);
  });

  test('V1 when the binary reports 1.x or is missing', () => {
    for (const shims of [['opencode'] as 'opencode'[], []]) {
      const box = sandbox({ shims });
      install(box.ctx('project'), ['opencode']);
      const config = JSON.parse(readFileSync(join(box.project, 'opencode.json'), 'utf8'));
      expect(config.$schema).toBe('https://opencode.ai/config.json');
      expect(config.mcp.overseer).toEqual({ type: 'local', command: ['overseer', 'mcp'], enabled: true });
      expect(readFileSync(join(box.project, '.opencode/agents/overseer.md'), 'utf8')).toContain('permission:\n  edit: deny\n');
    }
  });

  test('an existing opencode.jsonc is edited instead of creating opencode.json', () => {
    const box = sandbox();
    writeFile(join(box.project, 'opencode.jsonc'), '{\n  // mine\n}\n');
    install(box.ctx('project'), ['opencode']);
    expect(existsSync(join(box.project, 'opencode.json'))).toBe(false);
    const text = readFileSync(join(box.project, 'opencode.jsonc'), 'utf8');
    expect(text).toContain('// mine');
    expect(text).toContain('"overseer"');
  });
});

describe('checkInstall', () => {
  test('OK after install when command paths exist; claude checked via mcp get', () => {
    const box = sandbox({ shims: ['claude'] });
    const nodePath = join(box.root, 'node');
    const cliPath = join(box.root, 'dist/cli.js');
    writeFile(nodePath, '');
    writeFile(cliPath, '');
    const ctx = box.ctx('user', { nodePath, cliPath });
    install(ctx, ALL);
    const lines = checkInstall(ctx, ALL);
    expect(lines.filter((line) => line.status !== 'OK')).toEqual([]);
    expect(lines.map((line) => line.label)).toContain('claude (user) mcp');
    expect(lines).toHaveLength(ALL.length * 3 + 1); // + opencode schema line
  });

  test('FAIL when a user-scope command path is missing or a skill was deleted; WARN when not installed', () => {
    const box = sandbox();
    const ctx = box.ctx('user');
    expect(checkInstall(ctx, ['omp']).map((line) => line.status)).toEqual(['WARN', 'WARN', 'WARN']);
    install(ctx, ['omp']);
    rmSync(join(box.home, '.omp/agent/skills/overseer-import'), { recursive: true });
    const lines = checkInstall(ctx, ['omp']);
    expect(lines.map((line) => line.status)).toEqual(['OK', 'FAIL', 'FAIL']);
    expect(lines[1]!.detail).toContain('overseer-import');
    expect(lines[2]!.detail).toContain(`missing: ${NODE_PATH}, ${CLI_PATH}`);
  });

  test('project scope: WARN when overseer is not on PATH, OK when it is', () => {
    const box = sandbox();
    install(box.ctx('project'), ['cursor']);
    expect(checkInstall(box.ctx('project'), ['cursor'])[2]).toMatchObject({ status: 'WARN', detail: expect.stringContaining("'overseer' is not on PATH") });
    mkdirSync(box.bin, { recursive: true });
    writeFileSync(join(box.bin, 'overseer'), '#!/bin/sh\n', { mode: 0o755 });
    expect(checkInstall(box.ctx('project'), ['cursor'])[2]!.status).toBe('OK');
  });
});

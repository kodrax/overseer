import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import type { ExportResult } from '../src/core/export.js';
import type { ImportResult } from '../src/core/import.js';
import type { SimilarResult } from '../src/core/search.js';
import type { CreatedResult, ItemDetail, ListResult, UpdateResult } from '../src/core/service.js';
import type { CheckLine } from '../src/install/index.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { git, tempDir, tempRepo, tempUserConfig } from './helpers/tmp.js';

interface Run {
  code: number;
  out: string;
  err: string;
  json: <T = unknown>() => T;
}

interface ErrorEnvelope {
  error: { code: string; message: string };
}

async function cli(
  cwd: string,
  args: string[],
  options: { stdin?: string; tty?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<Run> {
  let out = '';
  let err = '';
  const stdin = Readable.from(options.stdin === undefined ? [] : [options.stdin]);
  const io = {
    stdout: { write: (chunk: string) => (out += chunk) },
    stderr: { write: (chunk: string) => (err += chunk) },
    stdin: options.tty ? Object.assign(stdin, { isTTY: true }) : stdin,
  };
  // Empty env plus a throwaway user config that turns overseer on for temp dirs (projects are off by default): keeps
  // the host's OVERSEER_PROJECT / CLAUDE_PROJECT_DIR and its enable/disable rules out of the tests.
  const env = { OVERSEER_CONFIG_DIR: tempUserConfig(), ...options.env };
  const code = await runCli(args, io, { embedder: new HashEmbedder(), env, cwd });
  return { code, out, err, json: <T,>(): T => JSON.parse(out) };
}

/** Dir of no-op executables, to stand in for installed harness CLIs on PATH. */
function binDir(...names: string[]): string {
  const dir = tempDir('ovs-bin-');
  for (const name of names) writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
}

const RESET = [
  'add',
  'requirement',
  '--title',
  'Password reset by email',
  '--description',
  'When a user requests a password reset, the system shall email a single-use link that expires after 30 minutes.',
  '--type',
  'functional',
  '--status',
  'approved',
];

describe('cli add', () => {
  it('creates items with human and JSON output', async () => {
    const repo = tempRepo();
    const human = await cli(repo, [...RESET, '--ac', 'Given a user, when reset, then email', '--tag', 'auth', '--asked-by', 'Ignacio']);
    expect(human.code).toBe(0);
    expect(human.out).toMatch(/^Created REQ-0001 {2}Password reset by email/);
    expect(git(repo, 'status', '--porcelain')).toBe('');

    const json = await cli(repo, ['add', 'bug', '--title', 'Safari login broken', '--steps', 'open /login', '--steps', 'click Login', '--actual', 'nothing', '--severity', 'major', '--json']);
    expect(json.code).toBe(0);
    expect(json.json()).toMatchObject({
      created: true,
      item: { id: 'BUG-0001', severity: 'major', bug_details: { steps: ['open /login', 'click Login'], expected: '', actual: 'nothing' } },
    });

    const shown = (await cli(repo, ['show', 'REQ-0001', '--json'])).json<ItemDetail>();
    expect(shown.item).toMatchObject({ asked_by: 'Ignacio', tags: ['auth'], acceptance_criteria: ['Given a user, when reset, then email'], recorded_via: 'cli' });
  });

  it('refuses possible duplicates unless --allow-duplicate', async () => {
    const repo = tempRepo();
    await cli(repo, RESET);
    const refused = await cli(repo, [...RESET, '--json']);
    expect(refused.code).toBe(0);
    expect(refused.json()).toMatchObject({ created: false, reason: 'possible_duplicate', candidates: [{ id: 'REQ-0001', match: 'duplicate' }] });

    const human = await cli(repo, RESET);
    expect(human.out).toContain('possible duplicate');
    expect(human.out).toContain('--allow-duplicate');

    const forced = await cli(repo, [...RESET, '--allow-duplicate', '--json']);
    expect(forced.json()).toMatchObject({ created: true, item: { id: 'REQ-0002' } });
  });

  it('--implements links the story and puts the requirement in the backlog', async () => {
    const repo = tempRepo();
    await cli(repo, RESET);
    const story = await cli(repo, [
      'add',
      'story',
      '--title',
      'Reset forgotten password',
      '--description',
      'As a user I want to reset my password so that I can regain access',
      '--implements',
      'REQ-0001',
      '--json',
    ]);
    expect(story.json<CreatedResult>().item.id).toBe('US-0001');
    const req = (await cli(repo, ['show', 'REQ-0001', '--json'])).json<ItemDetail>();
    expect(req.item).toMatchObject({ in_backlog: true, coverage: 'tracked' });
    expect(req.links.incoming).toEqual([expect.objectContaining({ id: 'US-0001', rel: 'implements' })]);

    const human = await cli(repo, ['show', 'REQ-0001', '--history']);
    expect(human.out).toContain('REQ-0001  Password reset by email');
    expect(human.out).toContain('← implements');
    expect(human.out).toContain('History:');
  });
});

describe('cli queries', () => {
  it('similar finds the stored requirement', async () => {
    const repo = tempRepo();
    await cli(repo, RESET);
    const result = (await cli(repo, ['similar', 'password reset email link', '--json'])).json<SimilarResult>();
    expect(result.semantic).toBe(true);
    expect(result.matches[0]).toMatchObject({ id: 'REQ-0001', kind: 'requirement' });

    const human = await cli(repo, ['similar', 'password reset email link']);
    expect(human.out).toMatch(/^verdict: /);
    expect(human.out).toContain('REQ-0001');
  });

  it('list --json applies filters', async () => {
    const repo = tempRepo();
    await cli(repo, RESET);
    await cli(repo, ['add', 'requirement', '--title', 'Audit log', '--description', 'The system shall keep an audit log.', '--type', 'non_functional', '--tag', 'security']);
    await cli(repo, ['add', 'task', '--title', 'Write migration']);
    await cli(repo, ['add', 'task', '--title', 'Dropped idea', '--status', 'cancelled']);

    const requirements = (await cli(repo, ['list', '--kind', 'requirement', '--json'])).json<ListResult>();
    expect(requirements.total).toBe(2);
    expect(requirements.items.map((item) => item.id)).toEqual(['REQ-0001', 'REQ-0002']);

    expect((await cli(repo, ['list', '--type', 'non_functional', '--json'])).json<ListResult>().items.map((item) => item.id)).toEqual(['REQ-0002']);
    expect((await cli(repo, ['list', '--tag', 'security', '--json'])).json<ListResult>().total).toBe(1);
    expect((await cli(repo, ['list', '--status', 'approved', '--json'])).json<ListResult>().items[0]?.id).toBe('REQ-0001');
    expect((await cli(repo, ['list', '--kind', 'task', '--json'])).json<ListResult>().total).toBe(1);
    expect((await cli(repo, ['list', '--kind', 'task', '--all', '--json'])).json<ListResult>().total).toBe(2);
    expect((await cli(repo, ['list', '--coverage', 'untracked', '--limit', '1', '--json'])).json()).toMatchObject({ total: 2, items: [{ id: 'REQ-0001' }] });

    const human = await cli(repo, ['list']);
    expect(human.out.split('\n')[0]).toMatch(/^ID\s+Kind\s+Status\s+Priority\s+Coverage\s+Parent\s+Title$/);
    expect(human.out).toContain('3 of 3 items');
  });
});

describe('cli update', () => {
  it('changes status, clears fields and records comments', async () => {
    const repo = tempRepo();
    await cli(repo, [...RESET, '--rationale', 'Users forget passwords', '--tag', 'auth']);
    const updated = await cli(repo, ['update', 'REQ-0001', '--status', 'implemented', '--clear', 'rationale', '--clear', 'tags', '--comment', 'Shipped', '--json']);
    expect(updated.code).toBe(0);
    const result = updated.json<UpdateResult>();
    expect(result.item).toMatchObject({ status: 'implemented', rationale: null, tags: [] });
    expect(result.changed_fields.sort()).toEqual(['rationale', 'status', 'tags']);
    expect(result.item.delivered_at).not.toBeNull();

    const history = (await cli(repo, ['show', 'REQ-0001', '--history', '--json'])).json<ItemDetail>().history;
    expect(history).toContainEqual(expect.objectContaining({ action: 'comment', new_value: 'Shipped', via: 'cli' }));
    expect(history).toContainEqual(expect.objectContaining({ action: 'status', old_value: 'approved', new_value: 'implemented' }));

    const human = await cli(repo, ['update', 'REQ-0001', '--priority', 'must']);
    expect(human.out).toMatch(/^Updated REQ-0001: priority/);
  });

  it('merges partial bug flags into the stored details', async () => {
    const repo = tempRepo();
    await cli(repo, ['add', 'bug', '--title', 'Crash', '--steps', 'open app', '--expected', 'works', '--actual', 'crash']);
    const result = (await cli(repo, ['update', 'BUG-0001', '--environment', 'Safari 18', '--no-in-backlog', '--json'])).json<UpdateResult>();
    expect(result.item.bug_details).toEqual({ steps: ['open app'], expected: 'works', actual: 'crash', environment: 'Safari 18' });
  });

  it('rejects unknown --clear fields', async () => {
    const repo = tempRepo();
    await cli(repo, RESET);
    const result = await cli(repo, ['update', 'REQ-0001', '--clear', 'title', '--json']);
    expect(result.code).toBe(1);
    expect(result.json<ErrorEnvelope>().error.code).toBe('INVALID_INPUT');
  });
});

describe('cli export and import', () => {
  it('export writes the files under docs/overseer/', async () => {
    const repo = tempRepo();
    await cli(repo, RESET);
    const result = await cli(repo, ['export', '--json']);
    expect(result.code).toBe(0);
    expect(result.json<ExportResult>().files.sort()).toEqual(
      ['README.md', 'backlog.md', 'history.md', 'overseer.json', 'requirements.md'].map((file) => `docs/overseer/${file}`).sort(),
    );
    expect(readdirSync(join(repo, 'docs/overseer')).sort()).toEqual(['README.md', 'backlog.md', 'history.md', 'overseer.json', 'requirements.md']);
    expect(git(repo, 'status', '--porcelain')).toBe('?? docs/');

    const partial = await cli(repo, ['export', '--out', 'out', '--only', 'json']);
    expect(partial.out).toContain('Wrote 1 files to out');
    expect(existsSync(join(repo, 'out/overseer.json'))).toBe(true);
  });

  it('import - reads stdin; repeating it reports unchanged', async () => {
    const repo = tempRepo();
    const payload = JSON.stringify([
      { external_id: 'acme/demo#7', url: 'https://github.com/acme/demo/issues/7', title: 'Login fails on Safari', state: 'open', labels: ['bug'] },
    ]);
    const args = ['import', '-', '--source', 'github', '--repo', 'acme/demo', '--json'];
    const first = await cli(repo, args, { stdin: payload });
    expect(first.code).toBe(0);
    expect(first.json<ImportResult>()).toMatchObject({ created: ['BUG-0001'], unchanged: [] });
    const second = await cli(repo, args, { stdin: payload });
    expect(second.json()).toMatchObject({ created: [], unchanged: ['BUG-0001'] });

    const file = join(repo, 'issues.json');
    writeFileSync(file, JSON.stringify({ items: JSON.parse(payload) }));
    const human = await cli(repo, ['import', 'issues.json', '--source', 'github', '--repo', 'acme/demo']);
    expect(human.out).toContain('unchanged: 1');
  });
});

describe('cli errors and uninitialized projects', () => {
  it('prints the JSON error envelope with --json', async () => {
    const repo = tempRepo();
    await cli(repo, RESET);
    const result = await cli(repo, ['show', 'REQ-0099', '--json']);
    expect(result.code).toBe(1);
    expect(result.json()).toEqual({ error: { code: 'NOT_FOUND', message: expect.stringContaining('REQ-0099') } });
    expect(result.err).toBe('');
  });

  it('prints the human error line on stderr', async () => {
    const repo = tempRepo();
    await cli(repo, RESET);
    const result = await cli(repo, ['update', 'REQ-0001', '--status', 'done']);
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toMatch(/^error: INVALID_STATUS: /);
  });

  it('reads on an uninitialized repo report initialized: false without creating .overseer', async () => {
    const repo = tempRepo();
    const result = await cli(repo, ['list', '--json']);
    expect(result.code).toBe(0);
    expect(result.json()).toEqual({ initialized: false, root: repo });
    expect((await cli(repo, ['report', 'summary'])).out).toContain('not initialized');
    expect(existsSync(join(repo, '.overseer'))).toBe(false);
  });

  it('honours --project from another directory', async () => {
    const repo = tempRepo();
    const elsewhere = tempDir();
    const added = await cli(elsewhere, ['--project', repo, ...RESET, '--json']);
    expect(added.json<CreatedResult>().item.id).toBe('REQ-0001');
    expect((await cli(elsewhere, ['list', '--project', repo, '--json'])).json<ListResult>().total).toBe(1);
  });

  it('reports commander parse errors and --version', async () => {
    const repo = tempRepo();
    const version = await cli(repo, ['--version']);
    expect(version).toMatchObject({ code: 0, out: '0.1.0\n' });
    const unknown = await cli(repo, ['list', '--bogus']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("unknown option '--bogus'");
    const unknownJson = await cli(repo, ['list', '--bogus', '--json']);
    expect(unknownJson.json<ErrorEnvelope>().error.code).toBe('INVALID_INPUT');
  });
});

describe('cli init and config', () => {
  it('init sets name and requester; config get/set round trip', async () => {
    const repo = tempRepo();
    const init = await cli(repo, ['init', '--name', 'Demo', '--asked-by', 'Ignacio', '--json']);
    expect(init.json()).toMatchObject({ initialized: true, root: repo, project_name: 'Demo' });
    expect(existsSync(join(repo, '.overseer/overseer.db'))).toBe(true);

    expect((await cli(repo, ['config', 'set', 'board_port', '5000'])).out).toBe('board_port = 5000\n');
    expect((await cli(repo, ['config', 'get', 'board_port'])).out).toBe('5000\n');
    expect((await cli(repo, ['config', 'get', '--json'])).json()).toMatchObject({ project_name: 'Demo', default_asked_by: 'Ignacio', board_port: '5000' });
    const bad = await cli(repo, ['config', 'set', 'nope', 'x', '--json']);
    expect(bad.code).toBe(1);
    expect(bad.json<ErrorEnvelope>().error.code).toBe('INVALID_INPUT');
  });

  it('worktree settings default on read, follow the remote default branch and reject a pattern without {id}', async () => {
    const repo = tempRepo();
    await cli(repo, ['init', '--json']);
    expect((await cli(repo, ['config', 'get', '--json'])).json()).toMatchObject({
      worktree_root: `../${basename(repo)}.worktrees`,
      base_branch: 'main',
      branch_pattern: '{type}/{id}-{slug}',
    });

    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    expect((await cli(repo, ['config', 'get', 'base_branch', '--json'])).json()).toEqual({ base_branch: 'trunk' });

    expect((await cli(repo, ['config', 'set', 'worktree_root', '../wt'])).out).toBe('worktree_root = ../wt\n');
    expect((await cli(repo, ['config', 'set', 'base_branch', 'develop'])).out).toBe('base_branch = develop\n');
    expect((await cli(repo, ['config', 'get', 'worktree_root'])).out).toBe('../wt\n');
    expect((await cli(repo, ['config', 'get', 'base_branch'])).out).toBe('develop\n');

    const bad = await cli(repo, ['config', 'set', 'branch_pattern', '{type}/{slug}', '--json']);
    expect(bad.code).toBe(1);
    expect(bad.json<ErrorEnvelope>().error.code).toBe('INVALID_INPUT');
    expect((await cli(repo, ['config', 'set', 'branch_pattern', 'wip/{id}'])).out).toBe('branch_pattern = wip/{id}\n');
  });

  it('config get --stored prints only stored settings and reports an unset key as NOT_FOUND', async () => {
    const repo = tempRepo();
    await cli(repo, ['init', '--json']);
    const worktreeKeys = ['worktree_root', 'base_branch', 'branch_pattern', 'worktree_setup'];
    const fresh = (await cli(repo, ['config', 'get', '--stored', '--json'])).json<Record<string, string>>();
    for (const key of worktreeKeys) expect(fresh).not.toHaveProperty(key);
    expect(fresh).toMatchObject({ project_name: basename(repo), board_port: '4477' });
    expect(Object.keys((await cli(repo, ['config', 'get', '--json'])).json<object>())).toEqual(expect.arrayContaining(worktreeKeys));

    const unset = await cli(repo, ['config', 'get', 'base_branch', '--stored', '--json']);
    expect(unset.code).toBe(1);
    expect(unset.json<ErrorEnvelope>().error.code).toBe('NOT_FOUND');

    await cli(repo, ['config', 'set', 'base_branch', 'main']);
    const stored = (await cli(repo, ['config', 'get', '--stored', '--json'])).json<Record<string, string>>();
    expect(stored.base_branch).toBe('main');
    expect(stored).not.toHaveProperty('worktree_root');
    expect(stored).not.toHaveProperty('branch_pattern');
    expect((await cli(repo, ['config', 'get', 'base_branch', '--stored', '--json'])).json()).toEqual({ base_branch: 'main' });
    expect((await cli(repo, ['config', 'get', 'base_branch', '--stored'])).out).toBe('main\n');
  });
});

describe('cli install and doctor', () => {
  it('install --dry-run --scope project writes nothing', async () => {
    const repo = tempRepo();
    const home = tempDir('ovs-home-');
    const env = { HOME: home, PATH: process.env.PATH };
    const result = await cli(repo, ['install', '--dry-run', '--scope', 'project', '--targets', 'claude', '--json'], { env });
    expect(result.code).toBe(0);
    const report = result.json<{ scope: string; targets: string[]; actions: unknown[]; model?: unknown }>();
    expect(report).toMatchObject({ scope: 'project', targets: ['claude'] });
    expect(report.actions.length).toBeGreaterThan(0);
    expect(report.model).toBeUndefined();
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(readdirSync(home)).toEqual([]);

    const bad = await cli(repo, ['install', '--dry-run', '--targets', 'vim', '--json'], { env });
    expect(bad.code).toBe(1);
    expect(bad.json<ErrorEnvelope>().error.code).toBe('INVALID_INPUT');
  });

  it('doctor --json reports runtime and project checks', async () => {
    const repo = tempRepo();
    await cli(repo, RESET);
    const home = tempDir('ovs-home-');
    const result = await cli(repo, ['doctor', '--json'], { env: { HOME: home, PATH: '', XDG_CACHE_HOME: join(home, 'cache') } });
    const { checks } = result.json<{ checks: { status: string; label: string; detail: string }[] }>();
    expect(checks.find((check) => check.label === 'node')?.status).toBe('OK');
    expect(checks.find((check) => check.label === 'model')?.status).toBe('WARN');
    expect(checks.find((check) => check.label === 'project')).toMatchObject({ status: 'OK', detail: expect.stringContaining('1 requirement') });
    expect(result.code).toBe(checks.some((check) => check.status === 'FAIL') ? 1 : 0);
  });

  it('install without --targets uses only detected harnesses when not interactive', async () => {
    const home = tempDir('ovs-home-');
    mkdirSync(join(home, '.codex')); // leftover config dir, no codex CLI: not a detected harness
    const env = { HOME: home, PATH: binDir('omp') };
    const result = await cli(tempRepo(), ['install', '--dry-run', '--json'], { env });
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ scope: 'user', targets: ['omp'] });

    const none = await cli(tempRepo(), ['install', '--dry-run', '--json'], { env: { HOME: tempDir('ovs-home-'), PATH: binDir() } });
    expect(none.code).toBe(1);
    expect(none.json<ErrorEnvelope>().error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('--targets') });
  });

  it('install asks which harnesses to use when run in a terminal', async () => {
    const home = tempDir('ovs-home-');
    mkdirSync(join(home, '.codex'));
    const env = { HOME: home, PATH: binDir('claude', 'omp') };
    const picked = await cli(tempRepo(), ['install', '--dry-run'], { env, tty: true, stdin: 'vim\nomp\n' });
    expect(picked.code).toBe(0);
    expect(picked.out).toMatch(/1\. \[x\] claude +Claude Code +claude on PATH/);
    expect(picked.out).toMatch(/3\. \[ \] codex +Codex CLI +~\/\.codex exists, but codex is not on PATH/);
    expect(picked.out).toMatch(/5\. \[ \] copilot +GitHub Copilot CLI +not found/);
    expect(picked.err).toContain('Unknown choice "vim"');
    expect(picked.out).toContain('scope: user; targets: omp\n');

    const defaults = await cli(tempRepo(), ['install', '--dry-run'], { env, tty: true, stdin: '\n' });
    expect(defaults.out).toContain('scope: user; targets: claude, omp\n');
    const byNumber = await cli(tempRepo(), ['install', '--dry-run'], { env, tty: true, stdin: '1, 7\n' });
    expect(byNumber.out).toContain('scope: user; targets: claude, opencode\n');

    const cancelled = await cli(tempRepo(), ['install', '--dry-run'], { env, tty: true });
    expect(cancelled.code).toBe(1);
    expect(cancelled.err).toContain('Installation cancelled');
    expect(readdirSync(home)).toEqual(['.codex']);
  });

  it('doctor checks only the harnesses overseer is installed for', async () => {
    const home = tempDir('ovs-home-');
    const env = { HOME: home, PATH: binDir('claude', 'omp'), XDG_CACHE_HOME: join(home, 'cache') };
    const repo = tempRepo();
    expect((await cli(repo, ['install', '--targets', 'omp', '--skip-model'], { env })).code).toBe(0);
    const { checks } = (await cli(repo, ['doctor', '--json'], { env })).json<{ checks: CheckLine[] }>();
    expect(checks.find((check) => check.label === 'harnesses')).toEqual({
      status: 'OK',
      label: 'harnesses',
      detail: 'overseer installed for omp; also detected: claude (add with overseer install --targets <ids>)',
    });
    expect(checks.filter((check) => check.label.startsWith('omp (user)')).map((check) => check.label)).toEqual([
      'omp (user) agent',
      'omp (user) skills',
      'omp (user) mcp',
    ]);
    expect(checks.filter((check) => check.label.startsWith('claude'))).toEqual([]);
  });

  it('install --scope project turns the project on for the installing user', async () => {
    const env = { HOME: tempDir('ovs-home-'), PATH: binDir(), OVERSEER_CONFIG_DIR: tempDir('ovs-config-') };
    const repo = tempRepo();
    const dry = await cli(repo, ['install', '--scope', 'project', '--targets', 'omp', '--dry-run'], { env });
    expect(dry.out).toContain(`would turn overseer on for ${repo}`);
    expect((await cli(repo, ['list', '--json'], { env })).json<ErrorEnvelope>().error.code).toBe('DISABLED');

    const result = await cli(repo, ['install', '--scope', 'project', '--targets', 'omp', '--skip-model', '--json'], { env });
    expect(result.json()).toMatchObject({ scope: 'project', project: { root: repo, enabled: true, changed: true } });
    expect((await cli(repo, ['list', '--json'], { env })).code).toBe(0);
  });
});

describe('cli enable and disable', () => {
  const rules = (config: string): unknown => JSON.parse(readFileSync(join(config, 'config.json'), 'utf8'));

  it('projects are off until enabled; switching never writes into the project', async () => {
    const config = tempDir('ovs-config-');
    const env = { OVERSEER_CONFIG_DIR: config };
    const repo = tempRepo();
    mkdirSync(join(repo, 'src'));
    const add = await cli(join(repo, 'src'), [...RESET, '--json'], { env });
    expect(add.code).toBe(1);
    expect(add.json<ErrorEnvelope>().error).toEqual({
      code: 'DISABLED',
      message: `overseer is off for ${repo} (overseer is off by default and works only in projects the user turned on). Do not use overseer in this project; to turn it on, the user runs: overseer enable --project ${repo}`,
    });
    expect((await cli(repo, ['list', '--json'], { env })).json<ErrorEnvelope>().error.code).toBe('DISABLED');
    expect(readdirSync(repo).sort()).toEqual(['.git', 'src']);

    const home = tempDir('ovs-home-');
    const doctor = await cli(repo, ['doctor', '--json'], { env: { ...env, HOME: home, PATH: '', XDG_CACHE_HOME: join(home, 'cache') } });
    expect(doctor.json<{ checks: CheckLine[] }>().checks.find((check) => check.label === 'project')).toEqual({
      status: 'OK',
      label: 'project',
      detail: `${repo} (overseer is off by default; overseer enable turns it on)`,
    });

    expect((await cli(repo, ['enable'], { env })).out).toContain(`overseer is now on for ${repo} and every folder below it.`);
    expect(rules(config)).toEqual({ enabled_projects: [repo], disabled_projects: [] });
    expect(readdirSync(repo).sort()).toEqual(['.git', 'src']);
    expect((await cli(join(repo, 'src'), RESET, { env })).code).toBe(0);
    expect((await cli(repo, ['enable'], { env })).out).toBe(`overseer is already on for ${repo}.\n`);

    const off = await cli(repo, ['disable'], { env });
    expect(off.out).toContain(`Existing data in ${join(repo, '.overseer')} is kept`);
    // Back to the default: no rule is left for the project.
    expect(rules(config)).toEqual({ enabled_projects: [], disabled_projects: [] });
    expect((await cli(repo, ['list', '--json'], { env })).json<ErrorEnvelope>().error.code).toBe('DISABLED');
    expect((await cli(repo, ['disable'], { env })).out).toBe(`overseer is already off for ${repo}.\n`);
  });

  it('the closest enabled or disabled folder decides', async () => {
    const config = tempDir('ovs-config-');
    const env = { OVERSEER_CONFIG_DIR: config };
    const work = tempDir('ovs-work-');
    const [app, client] = [join(work, 'app'), join(work, 'client')];
    for (const dir of [app, client]) mkdirSync(dir);
    expect((await cli(work, ['enable'], { env })).code).toBe(0);
    expect((await cli(app, ['enable'], { env })).out).toBe(`overseer is already on for ${app} (through ${work}).\n`);

    expect((await cli(client, ['disable'], { env })).out).toContain(`overseer is now off for ${client} and every folder below it`);
    expect(rules(config)).toEqual({ enabled_projects: [work], disabled_projects: [client] });
    expect((await cli(client, ['add', 'task', '--title', 'Anything', '--json'], { env })).json<ErrorEnvelope>().error).toEqual({
      code: 'DISABLED',
      message: `overseer is off for ${client}. Do not use overseer in this project; to turn it on, the user runs: overseer enable --project ${client}`,
    });
    expect((await cli(app, ['add', 'task', '--title', 'Anything'], { env })).code).toBe(0);

    // Enabling the exception again only drops it: the enabled parent decides once more.
    expect((await cli(client, ['enable'], { env })).out).toContain(`overseer is now on for ${client} (through ${work})`);
    expect(rules(config)).toEqual({ enabled_projects: [work], disabled_projects: [] });
  });

  it('init turns the project on', async () => {
    const env = { OVERSEER_CONFIG_DIR: tempDir('ovs-config-') };
    const repo = tempRepo();
    const init = await cli(repo, ['init'], { env });
    expect(init.code).toBe(0);
    expect(init.out).toContain(`overseer is now on for ${repo}`);
    expect((await cli(repo, RESET, { env })).code).toBe(0);
  });

  it('a broken user config fails loudly instead of changing which projects are on', async () => {
    const config = tempUserConfig();
    writeFileSync(join(config, 'config.json'), '{ "enabled_projects": [');
    const result = await cli(tempRepo(), ['list', '--json'], { env: { OVERSEER_CONFIG_DIR: config } });
    expect(result.code).toBe(1);
    expect(result.json<ErrorEnvelope>().error).toMatchObject({ code: 'CONFIG_PARSE', message: expect.stringContaining(join(config, 'config.json')) });
  });
});

describe('cli pr draft', () => {
  const TASK = ['add', 'task', '--title', 'Adds the reset email sender', '--description', 'Users locked out cannot get back in.', '--ac', 'A reset link is emailed'];

  it("uses the linked worktree's branch and template; --type wins over the branch", async () => {
    const repo = tempRepo();
    await cli(repo, TASK);
    const worktree = join(tempDir(), 'wt');
    git(repo, 'worktree', 'add', '-q', worktree, '-b', 'docs/TASK-0001-reset-email');
    mkdirSync(join(worktree, '.github'));
    writeFileSync(join(worktree, '.github', 'pull_request_template.md'), '## Item\n\nItem: TASK-0000\n\n## Notes\n\n<!-- notes -->\n');

    const draft = await cli(worktree, ['pr', 'draft', 'TASK-0001', '--json']);
    expect(draft.code).toBe(0);
    const { title, body } = draft.json<{ title: string; body: string }>();
    expect(title).toBe('docs: add the reset email sender (TASK-0001)');
    expect(body).toContain('## Item\n\nItem: TASK-0001\n\n## Why\n\nUsers locked out cannot get back in.\n\n## Acceptance criteria\n\n- [ ] A reset link is emailed\n\n## Notes\n\n<!-- notes -->\n');

    // The main checkout is on main and has no template: feat for a task, overseer's default template.
    const main = (await cli(repo, ['pr', 'draft', 'TASK-0001', '--json'])).json<{ title: string; body: string }>();
    expect(main.title).toBe('feat: add the reset email sender (TASK-0001)');
    expect(main.body).toContain('## Acceptance criteria\n\n- [ ] A reset link is emailed\n\n## What changed\n\n<!--');

    const typed = await cli(worktree, ['pr', 'draft', 'TASK-0001', '--type', 'refactor']);
    expect(typed.out.split('\n')[0]).toBe('refactor: add the reset email sender (TASK-0001)');
    expect((await cli(worktree, ['pr', 'draft', 'TASK-0001', '--type', 'style', '--json'])).json<ErrorEnvelope>().error.code).toBe('INVALID_INPUT');
  });

  it('falls back to the GitLab default template and fix for bugs', async () => {
    const repo = tempRepo();
    await cli(repo, ['add', 'bug', '--title', 'Login crashes on Safari']);
    mkdirSync(join(repo, '.gitlab', 'merge_request_templates'), { recursive: true });
    writeFileSync(join(repo, '.gitlab', 'merge_request_templates', 'Default.md'), '## Why\n\n<!-- why -->\n');
    const { title, body } = (await cli(repo, ['pr', 'draft', 'BUG-0001', '--json'])).json<{ title: string; body: string }>();
    expect(title).toBe('fix: login crashes on Safari (BUG-0001)');
    expect(body).toBe('## Item\n\nItem: BUG-0001\n\n## Why\n\n<!-- why -->\n');
  });
});

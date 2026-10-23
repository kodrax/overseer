#!/usr/bin/env node
// Smoke test of the published package: packs this checkout, installs the tarball globally into an empty temp
// prefix and exercises the installed `overseer` the way a user would. Run after `npm run build`:
//   node scripts/smoke-pack.mjs
// Every step is logged; a failure names the step and exits 1. Everything runs from a temp dir outside the
// checkout with a temp HOME and XDG dirs (no user config is read or written) and the prefix's bin first on
// PATH. npm keeps using your existing package cache, so repeated runs do not re-download every dependency.
// No embedding model is downloaded: `overseer doctor` passes when no check FAILs (the model check is a WARN),
// and the MCP calls run in keyword-only mode. POSIX only (the global bin layout of Linux and macOS).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const TIMEOUT_MS = 120_000;
const SERVER_TIMEOUT_MS = 30_000;
/** Tools that must be in the MCP server's tools/list. */
const REQUIRED_TOOLS = ['find_similar', 'check_coverage', 'create_item', 'update_item', 'get_item', 'list_items', 'search', 'link_items', 'report'];

const children = new Set();
const work = realpathSync(mkdtempSync(join(tmpdir(), 'overseer-smoke-')));
const dirs = {
  pack: join(work, 'pack'),
  prefix: join(work, 'prefix'),
  home: join(work, 'home'),
  xdg: join(work, 'xdg'),
  project: join(work, 'project'),
};
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const prefixBin = join(dirs.prefix, 'bin');
const packageDir = join(dirs.prefix, 'lib', 'node_modules', ...pkg.name.split('/'));

const log = (message) => console.log(`smoke-pack: ${message}`);

class StepError extends Error {
  constructor(step, cause) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.step = step;
  }
}

async function step(name, body) {
  log(`▶ ${name}`);
  const started = Date.now();
  try {
    const result = await body();
    log(`✔ ${name} (${Date.now() - started} ms)`);
    return result;
  } catch (error) {
    throw new StepError(name, error);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Environment of every child: no npm/overseer/Claude variables from the caller, temp HOME and XDG dirs. */
function isolatedEnv(npmCache) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|OVERSEER_|CLAUDE_)/i.test(key) || key === 'INIT_CWD') continue;
    env[key] = value;
  }
  // The prefix's bin first; nothing from the checkout (node_modules/.bin added by `npm run`, a linked checkout).
  const path = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry !== '' && !isInside(resolve(entry), root) && !entry.endsWith(`${sep}node_modules${sep}.bin`));
  Object.assign(env, {
    PATH: [prefixBin, ...path].join(delimiter),
    HOME: dirs.home,
    XDG_CONFIG_HOME: join(dirs.xdg, 'config'),
    XDG_DATA_HOME: join(dirs.xdg, 'data'),
    XDG_CACHE_HOME: join(dirs.xdg, 'cache'),
    XDG_STATE_HOME: join(dirs.xdg, 'state'),
    npm_config_cache: npmCache,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  });
  return env;
}

function isInside(path, dir) {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}

/** Runs a command to completion; rejects on a non-zero exit (unless allowed) or after the timeout. */
function run(command, args, { cwd = work, env, allowFailure = false, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeout} ms`));
    }, timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      children.delete(child);
      reject(new Error(`${command} ${args.join(' ')}: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      if (code === 0 || allowFailure) return resolvePromise({ code, stdout, stderr });
      const output = `${stderr}${stdout}`.trim().split('\n').slice(-20).join('\n');
      reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal}${output ? `:\n${output}` : ''}`));
    });
  });
}

/** Starts a long-running child that the cleanup kills if the script fails. */
function start(command, args, { cwd, env }) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stderrText = () => stderr.trim();
  child.exited = new Promise((resolvePromise) =>
    child.on('close', (code, signal) => {
      children.delete(child);
      resolvePromise({ code, signal });
    }),
  );
  // A spawn failure (e.g. ENOENT) still emits `close`; its message joins stderr for the step's error.
  child.on('error', (error) => (stderr += `${error.message}\n`));
  child.stdin.on('error', () => {});
  return child;
}

/** Stops a child started with `start`: SIGTERM, then SIGKILL after a grace period. */
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exited;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const result = await child.exited;
  clearTimeout(timer);
  return result;
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms))),
  ]).finally(() => clearTimeout(timer));
}

/** Files under `dir`, as paths relative to it. */
function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** First `overseer` on PATH, the way the shell would find it. */
function whichOverseer(env) {
  for (const entry of env.PATH.split(delimiter)) {
    const candidate = join(entry, 'overseer');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

/** Newline-delimited JSON-RPC client over a child's stdio. */
function jsonRpc(child) {
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        for (const { reject } of pending.values()) reject(new Error(`non-JSON line on the MCP server's stdout: ${line}`));
        pending.clear();
        continue;
      }
      if (message.method !== undefined && message.id !== undefined) {
        // A request from the server (e.g. roots/list): this client offers no capabilities.
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      } else if (message.id !== undefined && pending.has(message.id)) {
        const { resolve: resolveRequest, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(`JSON-RPC error ${message.error.code}: ${message.error.message}`));
        else resolveRequest(message.result);
      }
    }
  });
  child.exited.then(({ code, signal }) => {
    const stderr = child.stderrText();
    for (const { reject } of pending.values()) {
      reject(new Error(`overseer mcp exited with ${code ?? signal}${stderr ? `:\n${stderr}` : ''}`));
    }
    pending.clear();
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return {
    request(method, params) {
      const id = nextId++;
      const result = new Promise((resolveRequest, reject) => pending.set(id, { resolve: resolveRequest, reject }));
      send({ jsonrpc: '2.0', id, method, params });
      return withTimeout(result, SERVER_TIMEOUT_MS, `MCP ${method}`);
    },
    notify(method, params) {
      send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    },
  };
}

/** Calls an MCP tool and returns its JSON payload; a tool error fails the step. */
async function callTool(client, name, args) {
  const result = await client.request('tools/call', { name, arguments: args });
  const text = result.content?.find((part) => part.type === 'text')?.text;
  assert(!result.isError, `${name} returned an error: ${text}`);
  assert(text !== undefined, `${name} returned no text content`);
  return JSON.parse(text);
}

async function main() {
  log(`${pkg.name}@${pkg.version} from ${root}; temp dir ${work}`);
  assert(existsSync(join(root, 'dist', 'cli.js')), `${join(root, 'dist', 'cli.js')} is missing; run npm run build first`);
  const npmCache = spawnSync('npm', ['config', 'get', 'cache'], { cwd: root, encoding: 'utf8' }).stdout?.trim() || join(dirs.home, '.npm');
  const env = isolatedEnv(npmCache);

  const tarball = await step('npm pack', async () => {
    const { stdout } = await run('npm', ['pack', root, '--json', '--pack-destination', dirs.pack], { env });
    // npm ≤ 11 prints an array of packages, npm 12 an object keyed by package name.
    const packed = JSON.parse(stdout);
    const info = Array.isArray(packed) ? packed[0] : packed[pkg.name];
    assert(info?.name === pkg.name && info.version === pkg.version, `packed ${info?.name}@${info?.version}, expected ${pkg.name}@${pkg.version}`);
    const files = new Set(info.files.map((file) => file.path));
    for (const required of ['package.json', pkg.bin.overseer.replace(/^\.\//, ''), 'dist/web/index.html', 'templates/skills/overseer/SKILL.md']) {
      assert(files.has(required), `the tarball has no ${required}`);
    }
    const path = join(dirs.pack, info.filename);
    assert(existsSync(path), `npm pack reported ${info.filename}, but ${path} does not exist`);
    log(`  ${info.filename}: ${info.entryCount} files, ${info.size} bytes packed`);
    return path;
  });

  await step('npm install -g <tarball> into an empty prefix', async () => {
    await run('npm', ['install', '--global', tarball, '--prefix', dirs.prefix, '--no-fund', '--no-audit'], { env, timeout: 600_000 });
    const installed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    assert(installed.version === pkg.version, `installed ${installed.version}, expected ${pkg.version}`);
    const found = whichOverseer(env);
    assert(found === join(prefixBin, 'overseer'), `overseer on PATH is ${found}, expected ${join(prefixBin, 'overseer')}`);
    const target = realpathSync(found);
    assert(target === realpathSync(join(packageDir, pkg.bin.overseer)), `${found} points at ${target}, not into ${packageDir}`);
    log(`  overseer → ${target}`);
  });

  await step('overseer --version', async () => {
    const { stdout } = await run('overseer', ['--version'], { env });
    assert(stdout.trim() === pkg.version, `printed ${JSON.stringify(stdout.trim())}, expected ${pkg.version}`);
    log(`  ${stdout.trim()}`);
  });

  await step('overseer install --targets claude --scope project --skip-model', async () => {
    await run('git', ['init', '--quiet', dirs.project], { env });
    const { stdout } = await run('overseer', ['install', '--targets', 'claude', '--scope', 'project', '--skip-model', '--json'], {
      cwd: dirs.project,
      env,
    });
    const report = JSON.parse(stdout);
    assert(report.targets?.join(',') === 'claude', `installed for ${report.targets}, expected claude`);
    assert(report.warnings.length === 0, `warnings: ${report.warnings.join('; ')}`);
    assert(report.actions.length > 0 && report.actions.every((action) => action.status === 'created'), `actions: ${JSON.stringify(report.actions)}`);
    assert(report.project?.enabled === true, 'the project was not turned on');
    assert(isInside(report.project.config_file, work), `user config written outside the temp dir: ${report.project.config_file}`);
    // Every skill file is a copy of the installed package's template, which carries the managed marker.
    const templates = join(packageDir, 'templates', 'skills');
    const skills = readdirSync(templates);
    assert(skills.length > 0, `no skills in ${templates}`);
    let copied = 0;
    for (const skill of skills) {
      for (const file of filesUnder(join(templates, skill))) {
        const written = join(dirs.project, '.claude', 'skills', skill, file);
        assert(existsSync(written), `${written} was not written`);
        assert(readFileSync(written).equals(readFileSync(join(templates, skill, file))), `${written} differs from ${join(templates, skill, file)}`);
        copied++;
      }
      const skillMd = readFileSync(join(dirs.project, '.claude', 'skills', skill, 'SKILL.md'), 'utf8');
      assert(skillMd.includes('<!-- managed-by: '), `${skill}/SKILL.md has no managed-by marker`);
    }
    const agent = readFileSync(join(dirs.project, '.claude', 'agents', 'overseer.md'), 'utf8');
    assert(agent.includes('<!-- managed-by: '), '.claude/agents/overseer.md has no managed-by marker');
    const mcp = JSON.parse(readFileSync(join(dirs.project, '.mcp.json'), 'utf8'));
    assert(mcp.mcpServers?.overseer?.command === 'overseer', `.mcp.json registers ${JSON.stringify(mcp.mcpServers?.overseer)}`);
    log(`  ${skills.length} skills (${copied} files) match ${templates}; agent and .mcp.json written`);
  });

  await step('overseer doctor', async () => {
    // Pass: exit 0 and no FAIL. WARN is expected for the model (not downloaded) and the project (no data yet).
    const { code, stdout } = await run('overseer', ['doctor', '--json'], { cwd: dirs.project, env, allowFailure: true });
    const { checks } = JSON.parse(stdout);
    for (const check of checks) log(`  ${check.status.padEnd(4)} ${check.label}: ${check.detail}`);
    const failed = checks.filter((check) => check.status === 'FAIL');
    assert(code === 0 && failed.length === 0, `exit ${code}; FAIL: ${failed.map((check) => check.label).join(', ') || 'none'}`);
    for (const label of ['node', 'sqlite', 'claude (project) agent', 'claude (project) skills', 'claude (project) mcp']) {
      assert(checks.some((check) => check.label === label && check.status === 'OK'), `${label} is not OK`);
    }
  });

  await step('overseer mcp (stdio JSON-RPC)', async () => {
    const child = start('overseer', ['mcp'], { cwd: dirs.project, env });
    try {
      const client = jsonRpc(child);
      const init = await client.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke-pack', version: pkg.version },
      });
      assert(init.capabilities?.tools !== undefined, `initialize: no tools capability in ${JSON.stringify(init)}`);
      log(`  initialize: ${init.serverInfo?.name} ${init.serverInfo?.version}, protocol ${init.protocolVersion}`);
      client.notify('notifications/initialized');
      const { tools } = await client.request('tools/list', {});
      const names = tools.map((tool) => tool.name);
      const missing = REQUIRED_TOOLS.filter((name) => !names.includes(name));
      assert(missing.length === 0, `tools/list lacks ${missing.join(', ')} (got ${names.join(', ')})`);
      assert(tools.every((tool) => tool.inputSchema?.type === 'object'), 'a tool has no object input schema');
      log(`  tools/list: ${names.length} tools (${names.join(', ')})`);
      const title = 'Check the packed tarball on a fresh install';
      const created = await callTool(client, 'create_item', { kind: 'task', title, project_dir: dirs.project });
      assert(typeof created.id === 'string' && created.id !== '', `create_item returned ${JSON.stringify(created)}`);
      const listed = await callTool(client, 'list_items', { project_dir: dirs.project });
      assert(listed.items?.some((item) => item.id === created.id && item.title === title), `list_items lacks ${created.id}: ${JSON.stringify(listed)}`);
      const found = await callTool(client, 'search', { query: 'packed tarball', project_dir: dirs.project });
      assert(found.results?.some((hit) => hit.id === created.id), `search lacks ${created.id}: ${JSON.stringify(found)}`);
      log(`  create_item → ${created.id}; list_items and search find it`);
    } finally {
      child.stdin.end();
      await withTimeout(child.exited, 5000, 'overseer mcp exit').catch(() => stop(child));
    }
  });

  await step('overseer board', async () => {
    const port = await freePort();
    const child = start('overseer', ['board', '--port', String(port), '--no-open'], { cwd: dirs.project, env });
    try {
      const url = await withTimeout(
        new Promise((resolvePromise, reject) => {
          let stdout = '';
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk) => {
            stdout += chunk;
            const match = /overseer board: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout);
            if (match) resolvePromise(match[1]);
          });
          child.exited.then(({ code, signal }) =>
            reject(new Error(`overseer board exited with ${code ?? signal}: ${child.stderrText() || stdout.trim()}`)),
          );
        }),
        SERVER_TIMEOUT_MS,
        'overseer board start',
      );
      const response = await fetch(url);
      const html = await response.text();
      assert(response.status === 200, `GET ${url}: ${response.status}`);
      assert(response.headers.get('content-type')?.startsWith('text/html'), `GET ${url}: content-type ${response.headers.get('content-type')}`);
      assert(html.includes('<div id="root"></div>'), `GET ${url}: no SPA root in ${html.slice(0, 500)}`);
      assert(html.includes('window.__OVERSEER__='), `GET ${url}: no boot script`);
      const shipped = readFileSync(join(packageDir, 'dist', 'web', 'index.html'), 'utf8');
      const script = /<script type="module"[^>]* src="([^"]+)"/.exec(shipped)?.[1];
      assert(script !== undefined && html.includes(`src="${script}"`), `GET ${url} is not ${join(packageDir, 'dist', 'web', 'index.html')}`);
      const asset = await fetch(new URL(script, url));
      assert(asset.status === 200, `GET ${script}: ${asset.status}`);
      await asset.arrayBuffer();
      log(`  GET ${url}: SPA root and ${script} from the installed package`);
    } finally {
      await stop(child);
    }
  });
}

function cleanup() {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  rmSync(work, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    log(`interrupted (${signal}); cleaning up`);
    cleanup();
    process.exit(1);
  });
}

try {
  await main();
  log('all steps passed');
} catch (error) {
  const where = error instanceof StepError ? `step "${error.step}"` : 'setup';
  console.error(`smoke-pack: FAILED at ${where}: ${error.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
}

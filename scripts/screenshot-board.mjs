#!/usr/bin/env node
// Screenshots the board for docs/board.md: docs/assets/board-terminal.png, 1280 px wide, Terminal theme, with only the
// docs' sample data (Ana's API latency requirement, password reset, the Safari login bug, the gift card checkout).
// Run after `npm run build`:
//   node scripts/screenshot-board.mjs
// It seeds a throwaway project in a temp dir with this checkout's dist/cli.js (temp HOME and OVERSEER_CONFIG_DIR, no
// model: keyword search only), serves the board and shoots it with headless Chrome (CHROME, default google-chrome)
// over the DevTools protocol, with prefers-color-scheme emulated as dark so the board's system theme is Terminal.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'cli.js');
const output = join(root, 'docs', 'assets', 'board-terminal.png');
const WIDTH = 1280;
const HEIGHT = 800;

const work = mkdtempSync(join(tmpdir(), 'overseer-board-shot-'));
const project = join(work, 'my-app');
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OVERSEER_|CLAUDE_|npm_)/i.test(key))),
  HOME: join(work, 'home'),
  OVERSEER_CONFIG_DIR: join(work, 'config'),
  OVERSEER_MODEL_DIR: join(work, 'models'),
};

/** Minimal DevTools protocol client over one page's WebSocket: `cdp(method, params)` resolves with the result. */
async function devtools(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', () => reject(new Error(`cannot connect to ${webSocketUrl}`)), { once: true });
  });
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
    else request.resolve(message.result);
  });
  return (method, params = {}) =>
    new Promise((resolveCall, reject) => {
      const id = nextId++;
      pending.set(id, { method, resolve: resolveCall, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
}

function overseer(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`overseer ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

let board;
let chrome;
try {
  mkdirSync(project, { recursive: true });
  spawnSync('git', ['init', '--quiet', project], { stdio: 'inherit' });
  overseer('enable');
  // The docs' sample data (getting-started.md: From your harness; cli.md: Examples, Batch create), nothing else.
  overseer('add', 'requirement', '--title', 'Password reset by email', '--type', 'functional', '--status', 'approved',
    '--description', 'When a user requests a password reset, the system shall email a single-use link that expires after 30 minutes.',
    '--ac', 'Given a registered email, when a reset is requested, then a link valid for 30 minutes is sent');
  overseer('add', 'requirement', '--title', 'Public API latency under load', '--type', 'non_functional', '--nfr-category', 'performance_efficiency',
    '--asked-by', 'Ana', '--description', 'The public API shall answer in under 300 ms at p95 with 100 requests per second.');
  overseer('add', 'epic', '--title', 'Checkout');
  overseer('add', 'story', '--title', 'Reset forgotten password', '--status', 'in_progress',
    '--description', 'As a user I want to reset my password so that I can regain access', '--implements', 'REQ-0001');
  overseer('add', 'bug', '--title', 'On Safari the login button does nothing', '--severity', 'major',
    '--expected', 'The dashboard opens', '--actual', 'Nothing happens', '--environment', 'Safari', '--link', 'affects:REQ-0001');
  const batch = join(work, 'batch.json');
  writeFileSync(batch, JSON.stringify([
    { key: 'r1', kind: 'requirement', req_type: 'functional', title: 'Redeem a gift card at checkout' },
    { key: 's1', kind: 'story', title: 'Pay with a gift card', parent_id: 'EPIC-0001', status: 'ready', links: [{ rel: 'implements', to: '@r1' }] },
    { kind: 'task', title: 'Add the gift card field to checkout', parent_id: '@s1' },
  ]));
  overseer('add', '--batch', batch);
  overseer('update', 'US-0001', '--status', 'review', '--delivered-in', 'PR #42');
  overseer('update', 'TASK-0001', '--status', 'in_progress');

  board = spawn(process.execPath, [cli, 'board', '--no-open'], { cwd: project, env, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((resolveUrl, reject) => {
    let stdout = '';
    board.stdout.setEncoding('utf8');
    board.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = /overseer board: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout);
      if (match) resolveUrl(match[1]);
    });
    board.on('close', (code) => reject(new Error(`overseer board exited with ${code}: ${stdout}`)));
  });

  chrome = spawn(
    process.env.CHROME ?? 'google-chrome',
    ['--headless', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${join(work, 'chrome')}`, '--remote-debugging-port=0', 'about:blank'],
    { cwd: work, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const browserUrl = await new Promise((resolveUrl, reject) => {
    let stderr = '';
    chrome.stderr.setEncoding('utf8');
    chrome.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match) resolveUrl(match[1]);
    });
    chrome.on('close', (code) => reject(new Error(`chrome exited with ${code}: ${stderr}`)));
  });
  const pages = await (await fetch(new URL('/json/list', browserUrl.replace(/^ws/, 'http')))).json();
  const cdp = await devtools(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await cdp('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.enable');
  await cdp('Page.navigate', { url });
  // Ready when the board shows the seeded cards and the web fonts have loaded.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { result } = await cdp('Runtime.evaluate', {
      expression: `document.fonts.status === 'loaded' && document.body.innerText.includes('On Safari the login button does nothing')`,
    });
    if (result.value === true) break;
    if (Date.now() > deadline) throw new Error(`the board at ${url} did not show the sample data within 30 s`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(output, Buffer.from(data, 'base64'));
  console.log(`screenshot-board: ${output} (${WIDTH} x ${HEIGHT})`);
} finally {
  board?.kill();
  chrome?.kill();
  // Chrome may still hold files in its profile for a moment after the kill.
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  rmSync(work, { recursive: true, force: true });
}

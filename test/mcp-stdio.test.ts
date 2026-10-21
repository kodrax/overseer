import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type CallToolResult, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { build } from 'tsdown';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { freePort, listening } from './helpers/net.js';
import { tempDir, tempRepo, tempUserConfig } from './helpers/tmp.js';

const REPO = join(import.meta.dirname, '..');
/** Offline: transformers.js binds globalThis.fetch at import, so any download attempt fails at once and is logged to stderr. */
const OFFLINE = `data:text/javascript,globalThis.fetch=()=>{process.stderr.write('fetch attempted (test)\\n');return Promise.reject(new Error('offline (test)'))}`;

let buildDir: string;
let cli: string;
const children: ChildProcessWithoutNullStreams[] = [];

// The real CLI, built with the project's tsdown config. Inside node_modules so its dependencies resolve; npm test runs before npm run build.
beforeAll(async () => {
  mkdirSync(join(REPO, 'node_modules', '.cache'), { recursive: true });
  buildDir = mkdtempSync(join(REPO, 'node_modules', '.cache', 'overseer-mcp-stdio-'));
  await build({ config: join(REPO, 'tsdown.config.ts'), cwd: REPO, outDir: buildDir, logLevel: 'silent' });
  cli = join(buildDir, 'cli.js');
});

afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});

interface McpProcess {
  child: ChildProcessWithoutNullStreams;
  client: Client;
  stdout: () => string;
  stderr: () => string;
}

/** Client transport over the child's pipes that keeps the raw stdout, so the test can check every byte the server wrote. */
function pipeTransport(child: ChildProcessWithoutNullStreams): Transport {
  let pending = '';
  const transport: Transport = {
    async start() {
      child.stdout.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          try {
            transport.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
          } catch (error) {
            transport.onerror?.(error as Error);
          }
        }
      });
      child.once('exit', () => transport.onclose?.());
    },
    async send(message) {
      child.stdin.write(serializeMessage(message));
    },
    async close() {
      child.stdin.end();
    },
  };
  return transport;
}

async function startMcp(cwd: string): Promise<McpProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tempDir('ovs-home-'),
    OVERSEER_CONFIG_DIR: tempUserConfig(),
    OVERSEER_MODEL_DIR: tempDir('ovs-models-'),
  };
  for (const key of ['OVERSEER_PROJECT', 'CLAUDE_PROJECT_DIR', 'OVERSEER_ACTOR']) delete env[key];
  const child = spawn(process.execPath, ['--import', OFFLINE, cli, 'mcp'], { cwd, env, stdio: 'pipe' });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await client.connect(pipeTransport(child));
  return { child, client, stdout: () => stdout, stderr: () => stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
}

async function exited(child: ChildProcessWithoutNullStreams, ms = 10_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  const timeout = AbortSignal.timeout(ms);
  const [code, signal] = (await once(child, 'exit', { signal: timeout }).catch(() => {
    throw new Error(`overseer mcp still running ${ms} ms after the client disconnected`);
  })) as [number | null, NodeJS.Signals | null];
  return { code, signal };
}

describe('overseer mcp over stdio', () => {
  it('writes only JSON-RPC to stdout and warnings to stderr', async () => {
    const repo = tempRepo();
    const mcp = await startMcp(repo);
    const { tools } = await mcp.client.listTools();
    expect(tools).toHaveLength(13);
    // Opens (and creates) the project; the model cache is empty, so search stays keyword-only, warns and downloads nothing.
    expect(await call(mcp.client, 'create_item', { kind: 'requirement', title: 'Password reset by email', req_type: 'functional' })).toMatchObject({
      created: true,
    });
    const similar = await call(mcp.client, 'find_similar', { text: 'Password reset by email' });
    expect(similar).toMatchObject({ semantic: false, verdict: 'unknown', warning: expect.stringContaining('run overseer models pull') });
    expect(existsSync(join(repo, '.overseer', 'overseer.db'))).toBe(true);

    await mcp.client.close();
    expect(await exited(mcp.child)).toEqual({ code: 0, signal: null });

    const stdout = mcp.stdout();
    expect(stdout.endsWith('\n')).toBe(true);
    const lines = stdout.slice(0, -1).split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(4); // initialize, tools/list and two tools/call responses
    for (const line of lines) expect(JSONRPCMessageSchema.safeParse(JSON.parse(line)).success, line).toBe(true);
    expect(mcp.stderr()).toContain('overseer: Semantic search unavailable (embedding model Xenova/multilingual-e5-small is not downloaded');
    expect(mcp.stderr()).not.toContain('fetch attempted');
  });

  it('stops the board and exits on its own when the client disconnects', async () => {
    const repo = tempRepo();
    const mcp = await startMcp(repo);
    await call(mcp.client, 'create_item', { kind: 'task', title: 'Close everything' });
    const board = await call(mcp.client, 'open_board', { port: await freePort(), open_browser: false });
    const port = Number(new URL(String(board.url)).port);
    expect(await listening(port)).toBe(true);

    await mcp.client.close();
    // A board left listening keeps the process alive: it exits by itself only when the session closed it.
    // The database is checked in-process (mcp.test.ts): process exit would close it anyway.
    expect(await exited(mcp.child)).toEqual({ code: 0, signal: null });
    expect(await listening(port)).toBe(false);
  });
});

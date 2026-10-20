import type * as ChildProcess from 'node:child_process';
import { once } from 'node:events';
import { type AddressInfo, createServer, Server } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as BoardModule from '../src/board/server.js';
import { startBoardServer, type BoardServer } from '../src/board/server.js';
import { createMcpServer } from '../src/mcp/server.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { freePort, listening } from './helpers/net.js';
import { openService } from './helpers/service.js';
import { tempRepo, tempUserConfig } from './helpers/tmp.js';

// The board opens the browser with child_process.spawn (xdg-open, open, cmd /c start); a stub keeps tests from launching one.
const spawn = vi.hoisted(() => vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })));
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof ChildProcess>()), spawn }));

// Wraps the real startBoardServer so tests can count how many boards the MCP server starts.
vi.mock('../src/board/server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BoardModule>();
  return { ...actual, startBoardServer: vi.fn(actual.startBoardServer) };
});

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  spawn.mockClear();
  vi.mocked(startBoardServer).mockClear();
});

/** A free port P on 127.0.0.1 whose successor P+1 is free too. */
async function freePortPair(): Promise<number> {
  for (;;) {
    const port = await freePort();
    if (port < 65535 && !(await listening(port + 1))) return port;
  }
}

/** Occupies 127.0.0.1:port until the end of the test. */
async function occupy(port: number): Promise<void> {
  const blocker = createServer();
  blocker.listen(port, '127.0.0.1');
  await once(blocker, 'listening');
  cleanups.push(async () => {
    blocker.close();
    await once(blocker, 'close');
  });
}

describe('startBoardServer', () => {
  it('listens on 127.0.0.1 at the next port when the requested one is taken', async () => {
    const port = await freePortPair();
    await occupy(port);
    const listen = vi.spyOn(Server.prototype, 'listen');
    const service = openService();
    cleanups.push(() => service.close());

    const board: BoardServer = await startBoardServer({ service, port, openBrowser: false });
    cleanups.push(() => board.close());

    expect(board.port).toBe(port + 1);
    expect(board.url).toBe(`http://127.0.0.1:${port + 1}/`);
    expect(await listening(port + 1)).toBe(true);
    // Loopback only: the bound address is 127.0.0.1, not a wildcard such as 0.0.0.0 or ::.
    // Same server for every attempt, so deduplicate the contexts.
    const bound = [...new Set(listen.mock.contexts)].map((server) => (server as Server).address()).filter((address) => address !== null);
    expect(bound).toEqual([{ address: '127.0.0.1', family: 'IPv4', port: port + 1 } satisfies AddressInfo]);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('open_board', () => {
  it('reuses the running board on a second call for the same project and opens the browser once', async () => {
    const root = tempRepo();
    const server = createMcpServer({ cwd: root, embedder: new HashEmbedder(), env: { OVERSEER_CONFIG_DIR: tempUserConfig() } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const port = await freePortPair();
    cleanups.push(async () => {
      // Closing the client closes the board without awaiting it; close it first so the port is free when the test ends.
      for (const { value } of vi.mocked(startBoardServer).mock.results) await (await value).close();
      await client.close();
    });
    const openBoard = async () => {
      const result = (await client.callTool({ name: 'open_board', arguments: { port } })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      return result.structuredContent as { url: string };
    };

    const first = await openBoard();
    expect(first.url).toBe(`http://127.0.0.1:${port}/`);
    expect(await listening(port)).toBe(true);
    const second = await openBoard();

    expect(second).toEqual(first);
    expect(startBoardServer).toHaveBeenCalledTimes(1);
    // A second server would have moved to port+1, since the first one holds port.
    expect(await listening(port + 1)).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]).toContainEqual(expect.arrayContaining([`${first.url}#/board`]));
  });
});

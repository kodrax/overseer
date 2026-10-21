import { once } from 'node:events';
import type { Command } from 'commander';
import { startBoardServer } from '../../board/server.js';
import { runStdio } from '../../mcp/server.js';
import { parseInteger } from '../options.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

export function registerServerCommands(program: Command, rt: CliRuntime): void {
  program
    .command('board')
    .description('serve the web board on 127.0.0.1 (creates the data folder if missing)')
    .option('--port <port>', 'port (default: config board_port, 4477)', parseInteger)
    .option('--no-open', 'do not open a browser')
    .action(async (options: { port?: number; open: boolean }, command: Command) => {
      await rt.withService(command, 'write', async (service) => {
        const port = options.port ?? (Number(service.configValue('board_port')) || undefined);
        const board = await startBoardServer({ service, ...(port !== undefined ? { port } : {}), openBrowser: options.open });
        rt.out(`overseer board: ${board.url} (Ctrl+C to stop)`);
        const stop = new AbortController();
        await Promise.race([once(process, 'SIGINT', { signal: stop.signal }), once(process, 'SIGTERM', { signal: stop.signal })]);
        stop.abort();
        await board.close();
      });
    });

  program
    .command('mcp')
    .description('run the MCP server over stdio')
    .action(async (_options: unknown, command: Command) => {
      const { project } = command.optsWithGlobals<GlobalOptions>();
      await runStdio({ env: rt.env, embedder: rt.embedder, ...(project !== undefined ? { projectOverride: project } : {}) });
    });
}

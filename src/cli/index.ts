import { Command, CommanderError } from 'commander';
import { packageVersion } from '../core/paths.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerInstallCommands } from './commands/install.js';
import { registerItemCommands } from './commands/items.js';
import { registerModelCommands } from './commands/models.js';
import { registerPrCommands } from './commands/pr.js';
import { registerProjectCommands } from './commands/project.js';
import { registerQueryCommands } from './commands/query.js';
import { registerServerCommands } from './commands/servers.js';
import { registerSyncCommands } from './commands/sync.js';
import { registerWorktreeCommands } from './commands/worktree.js';
import { type CliDeps, type CliIo, CliRuntime } from './runtime.js';

export type { CliDeps, CliIo, CliWriter } from './runtime.js';

/**
 * Runs the `overseer` CLI in-process and resolves with the exit code (nothing calls process.exit).
 * Errors: `error: <CODE>: <message>` on stderr, or with `--json` the envelope `{"error":{"code","message"}}` on stdout.
 */
export async function runCli(
  argv: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin },
  deps: CliDeps = {},
): Promise<number> {
  const rt = new CliRuntime(io, deps);
  const json = argv.includes('--json');
  const program = new Command('overseer')
    .description("Requirements registry and Agile board for this project (CLI, MCP server and web board).")
    .version(packageVersion(), '-V, --version', 'print the version')
    .option('--project <dir>', 'project directory (default: OVERSEER_PROJECT, CLAUDE_PROJECT_DIR or the current directory)')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text),
      outputError: (text, write) => {
        if (!json) write(text);
        else io.stdout.write(`${JSON.stringify({ error: { code: 'INVALID_INPUT', message: text.replace(/^error: /, '').trim() } })}\n`);
      },
    });

  registerProjectCommands(program, rt);
  registerItemCommands(program, rt);
  registerQueryCommands(program, rt);
  registerPrCommands(program, rt);
  registerWorktreeCommands(program, rt);
  registerSyncCommands(program, rt);
  registerServerCommands(program, rt);
  registerModelCommands(program, rt);
  registerInstallCommands(program, rt);
  registerDoctorCommand(program, rt);

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    // Commander already printed parse errors, help and the version through configureOutput.
    if (error instanceof CommanderError) return error.exitCode;
    rt.fail(error, json);
  }
  return rt.exitCode;
}

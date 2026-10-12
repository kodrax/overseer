import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles } from '../../../src/install/fs-ops.js';
import type { InstallContext, Scope } from '../../../src/install/index.js';

export const TEMPLATES_DIR = fileURLToPath(new URL('./templates/', import.meta.url));
export const GOLDEN_DIR = fileURLToPath(new URL('./', import.meta.url));
export const NODE_PATH = '/opt/node/bin/node';
export const CLI_PATH = '/opt/overseer/dist/cli.js';

/**
 * `claude` stand-in: appends argv to $OVS_CLAUDE_LOG and keeps one registration in $OVS_CLAUDE_STATE,
 * printing it in the `claude mcp get` format. Uses only sh builtins (PATH holds nothing but the shims).
 */
const CLAUDE_SHIM = `#!/bin/sh
printf '%s\\n' "$*" >> "$OVS_CLAUDE_LOG"
state="$OVS_CLAUDE_STATE"
case "$1 $2" in
  "mcp get")
    if [ -s "$state" ]; then
      while IFS= read -r line; do printf '%s\\n' "$line"; done < "$state"
      exit 0
    fi
    printf 'No MCP server named "overseer". Configured servers: other\\n' >&2
    exit 1;;
  "mcp add")
    while [ "$1" != "--" ]; do shift; done
    shift
    cmd="$1"
    shift
    printf 'overseer:\\n  Scope: User config (available in all your projects)\\n  Status: \\342\\234\\223 Connected\\n  Type: stdio\\n  Command: %s\\n  Args: %s\\n  Environment:\\n\\nTo remove this server, run: claude mcp remove "overseer" -s user\\n' "$cmd" "$*" > "$state"
    exit 0;;
  "mcp remove")
    if [ -s "$state" ]; then : > "$state"; exit 0; fi
    printf 'No MCP server found with name: "overseer"\\n' >&2
    exit 1;;
esac
exit 2
`;

const OPENCODE_SHIM = `#!/bin/sh
printf '%s\\n' "$*" >> "$OVS_OPENCODE_LOG"
printf '%s\\n' "\${OVS_OPENCODE_VERSION:-1.14.2}"
`;

export interface Sandbox {
  root: string;
  home: string;
  project: string;
  bin: string;
  claudeLog: string;
  claudeState: string;
  opencodeLog: string;
  ctx(scope: Scope, overrides?: Partial<InstallContext>): InstallContext;
  claudeCalls(): string[];
}

export function sandbox(options: { shims?: ('claude' | 'opencode')[]; env?: Record<string, string> } = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'overseer-install-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  for (const dir of [home, project, bin]) mkdirSync(dir, { recursive: true });
  const claudeLog = join(root, 'claude.log');
  const claudeState = join(root, 'claude.state');
  const opencodeLog = join(root, 'opencode.log');
  for (const shim of options.shims ?? []) {
    const file = join(bin, shim);
    writeFileSync(file, shim === 'claude' ? CLAUDE_SHIM : OPENCODE_SHIM);
    chmodSync(file, 0o755);
  }
  const env = {
    PATH: bin,
    OVS_CLAUDE_LOG: claudeLog,
    OVS_CLAUDE_STATE: claudeState,
    OVS_OPENCODE_LOG: opencodeLog,
    ...options.env,
  };
  return {
    root,
    home,
    project,
    bin,
    claudeLog,
    claudeState,
    opencodeLog,
    ctx: (scope, overrides = {}) => ({
      scope,
      home,
      env,
      projectRoot: scope === 'project' ? project : undefined,
      nodePath: NODE_PATH,
      cliPath: CLI_PATH,
      templatesDir: TEMPLATES_DIR,
      dryRun: false,
      force: false,
      ...overrides,
    }),
    claudeCalls: () => readText(claudeLog)?.split('\n').filter(Boolean) ?? [],
  };
}

export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Every file under `dir` as `{ relativePath: content }` (POSIX separators). */
export function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of listFiles(dir)) out[rel.split('\\').join('/')] = readFileSync(join(dir, rel), 'utf8');
  return out;
}

/** Every directory under `dir` (empty ones included) as sorted relative POSIX paths. */
export function listDirs(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .sort();
}

/** `{ relativePath: mtimeMs }` for change detection. */
export function mtimes(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rel of listFiles(dir)) out[rel] = statSync(join(dir, rel)).mtimeMs;
  return out;
}

export function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

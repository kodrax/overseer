# Troubleshooting

Start with `overseer doctor`: it checks the runtime, the model, the project and each [harness](concepts.md#coding-agent-and-harness)'s setup, and shows whether overseer is off for the current project. `overseer doctor --deep` also loads the model.

| What you see | Why | What to do |
|---|---|---|
| A tool or command answers `DISABLED` | overseer is off for this project, as it is everywhere by default | run `overseer enable` in the project ([Turning overseer on and off](getting-started.md#turning-overseer-on-and-off)) |
| `NO_PROJECT` | the project resolved to your home directory, one of its ancestors or the filesystem root, where overseer refuses to write | run the command inside the project, or pass `--project <dir>` ([MCP](concepts.md#mcp): `project_dir`); see [How overseer finds the project](configuration.md#how-overseer-finds-the-project) |
| `overseer doctor` reports `FAIL` for a harness's MCP registration | the package moved (for example a reinstall under another Node version) or that Node version was removed | run `overseer install` again ([Install](getting-started.md#install)) |
| Results carry `semantic: false` and a warning | the embedding model is not downloaded, or `sqlite-vec` has no prebuilt binary for your platform | run `overseer models pull`; on other platforms search stays keyword-only ([Semantic search and duplicates](concepts.md#semantic-search-and-duplicates)) |
| A harness cannot start overseer from a project-scope install | in that scope the MCP command is plain `overseer mcp`, which needs `overseer` on `PATH` | install the package globally on that machine ([Harness files, project scope](configuration.md#harness-files-project-scope-optional)) |
| A harness ignores the project-scope server or [subagent](concepts.md#subagent) | harnesses ask before using project-level servers and agents | approve them: Claude Code asks for `.mcp.json` servers, Codex loads `.codex/config.toml` only for trusted projects, Gemini asks you to acknowledge project agents, Copilot asks you to trust the folder |
| An OMP named profile (`omp --profile work`) has no overseer | named profiles read `~/.omp/profiles/<name>/agent/` | `PI_CODING_AGENT_DIR=~/.omp/profiles/work/agent overseer install --targets omp` |
| `install` leaves a file alone with a warning | the file has no `managed-by: overseer-cli` marker | pass `--force`; each replaced file is first copied to `<file>.overseer-backup` ([How install edits files](configuration.md#how-install-edits-files)) |
| overseer's tool descriptions still reach the model in a project that is off | the harness still starts the MCP server | turn the server off in the harness if it supports that per project; in Claude Code, toggle `overseer` off in `/mcp` |
| `overseer doctor` prints `WARN` on a `connection` line | no harness overseer is installed for has that connection's MCP server | set one up as [`integrations.md`](../templates/skills/overseer-import/references/integrations.md) shows ([Repository connections](sync.md#repository-connections)) |
| Changes stay in the outbox | the session lacks the host's MCP tools, you said not to sync, or a push failed | `overseer sync status` counts them in `pending_outbox`; ask your agent to sync again ([Sync pending](sync.md#sync-pending)) |
| `worktree start` gives `CONFLICT` listing dependencies | the item `depends_on` a task or bug that is not `done` or `cancelled` | wait for it, or stack on it with `--base <its branch>` ([Worktrees](cli.md#worktrees)) |
| `worktree start` exits with `SETUP_FAILED` | the setup command failed; the worktree is kept | fix the setup and run it in the worktree, or skip it with `--no-setup` or `overseer config set worktree_setup none` |
| `overseer board` is not on port 4477 | that port was taken, so it tried the next ones, up to 4496 | read the URL it prints, or pick one with `--port` or `overseer config set board_port <port>` |

## Status and limitations

- **Harness coverage**: tested end to end with Claude Code and OMP. The Codex, Gemini, Copilot, Cursor and OpenCode files follow those tools' documented formats and are covered by golden tests, but have not yet been run against the real CLIs.
- **OpenCode**: the installer picks the config format (1.x or 2.x) from `opencode --version`.
- **Imports are one-way**, and a database cannot be restored from `overseer.json`.

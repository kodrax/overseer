# Configuration

Project settings, environment variables, where overseer keeps its files, and how to remove it.

## Project settings

`overseer config get` and `overseer config set <key> <value>` read and change per-project settings:

| Key | Default |
|---|---|
| `project_name` | the project folder's name |
| `default_asked_by` | `git config user.name`, else your OS user name |
| `export_dir` | `docs/overseer` |
| `board_port` | `4477` |
| `worktree_root` | `../<project folder name>.worktrees`, relative to the project root |
| `base_branch` | the remote's default branch (`refs/remotes/origin/HEAD`), else `main` |
| `branch_pattern` | `{type}/{id}-{slug}`; must contain `{id}` |
| `worktree_setup` | from the lockfile: `npm ci` (`package-lock.json`), `pnpm install --frozen-lockfile` (`pnpm-lock.yaml`), `yarn install --immutable` (`yarn.lock`), else `none`; `none` turns the setup off |

The last four are worked out when read until you set them, so `overseer config get <key> --json` always prints the value in effect. Add `--stored` to see only what was set in this project: `overseer config get --stored --json` leaves out the settings that still fall back to a default, and `overseer config get <key> --stored` fails with `NOT_FOUND` when that key was never set. The ship [skill](concepts.md#skill) uses it to tell a first run from a later one.

## Environment variables

| Variable | Effect |
|---|---|
| `OVERSEER_PROJECT` | project directory when neither `--project` nor `project_dir` is given |
| `OVERSEER_ACTOR` | name recorded as the actor in the history |
| `OVERSEER_MODEL_DIR` | model cache folder |
| `OVERSEER_CONFIG_DIR` | user config folder (holds the on/off rules) |

## Where the files go

There are three kinds of files. The [harness](concepts.md#coding-agent-and-harness) files say how a harness reaches overseer. The project data is your registry. The exports are what you share through the repository.

### Harness files, user scope (default)

`overseer install` writes into your home directory once, and it then works in every project. Nothing is written into your projects.

| Harness | Skills | Subagent | [MCP](concepts.md#mcp) server |
|---|---|---|---|
| Claude Code | `~/.claude/skills/` | `~/.claude/agents/overseer.md` | `claude mcp add --scope user overseer …` |
| OMP | `~/.omp/agent/skills/` | `~/.omp/agent/agents/overseer.md` | `~/.omp/agent/mcp.json` |
| Codex CLI | `~/.agents/skills/` | `~/.codex/agents/overseer.toml` | `~/.codex/config.toml` |
| Gemini CLI | `~/.agents/skills/` | `~/.gemini/agents/overseer.md` | `~/.gemini/settings.json` |
| GitHub Copilot CLI | `~/.agents/skills/` | `~/.copilot/agents/overseer.agent.md` | `~/.copilot/mcp-config.json` |
| Cursor | `~/.agents/skills/` | `~/.cursor/agents/overseer.md` | `~/.cursor/mcp.json` |
| OpenCode | `~/.config/opencode/skills/` | `~/.config/opencode/agents/overseer.md` | `~/.config/opencode/opencode.json` |

- **Skills**: five folders, `overseer`, `overseer-bootstrap`, `overseer-import`, `overseer-ship` and `overseer-sync`.
- **Shared skills folder**: Codex, Gemini, Copilot and Cursor all read `~/.agents/skills/`, so overseer writes it once and removes it only when none of them still uses it.
- **Custom config folders**: the installer honours `CLAUDE_CONFIG_DIR`, `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR` (OMP), `CODEX_HOME`, `COPILOT_HOME` and `XDG_CONFIG_HOME`.
- **OMP named profiles** (`omp --profile work`) read `~/.omp/profiles/work/agent/` instead. Install there with `PI_CODING_AGENT_DIR=~/.omp/profiles/work/agent overseer install --targets omp`.

### Harness files, project scope (optional)

`overseer install --scope project` writes the same pieces into the repository. This is meant for teams: once you commit these files, everyone who clones the repo gets overseer in their harness.

| Harness | Skills | Subagent | MCP server |
|---|---|---|---|
| Claude Code | `.claude/skills/` | `.claude/agents/overseer.md` | `.mcp.json` |
| OMP | `.omp/skills/` | `.omp/agents/overseer.md` | `.omp/mcp.json` |
| Codex CLI | `.agents/skills/` | `.codex/agents/overseer.toml` | `.codex/config.toml` |
| Gemini CLI | `.agents/skills/` | `.gemini/agents/overseer.md` | `.gemini/settings.json` |
| GitHub Copilot CLI | `.agents/skills/` | `.github/agents/overseer.agent.md` | `.github/mcp.json` |
| Cursor | `.agents/skills/` | `.cursor/agents/overseer.md` | `.cursor/mcp.json` |
| OpenCode | `.agents/skills/` | `.opencode/agents/overseer.md` | `opencode.json` |

- **`overseer` must be on PATH**: in this scope the MCP command is plain `overseer mcp`, so every teammate needs `overseer` on their `PATH`.
- **Trust prompts**: harnesses ask before using project-level servers and agents. Claude Code asks each user to approve `.mcp.json` servers, Codex loads `.codex/config.toml` only for trusted projects, Gemini asks you to acknowledge project agents, and Copilot asks you to trust the folder.
- **Pick one scope per harness**: for personal use, the user scope is enough. If a harness has both, the two entries share the name `overseer`. In OMP the project entry takes precedence over the user one.
- **It turns the project on for you**, as `overseer enable` would. Each teammate's overseer stays off in their clone until they run `overseer enable` there once: a cloned repository can't turn itself on.

### How install edits files

- Every file overseer generates carries a `managed-by: overseer-cli` marker. An existing file without the marker, or a skill folder whose `SKILL.md` lacks it, is left alone with a warning, unless you pass `--force`.
- With `--force`, each existing file overseer replaces is first copied to `<file>.overseer-backup` next to it. In a skill folder, that means `SKILL.md.overseer-backup` and so on for each replaced file, never a copied folder, so the harness doesn't load a second skill. Files overseer doesn't ship stay as they are. An existing backup is never overwritten, and the warning says which backups hold what.
- In shared config files (`mcp.json`, `settings.json`, `config.toml`, `opencode.json`), only the `overseer` entry is added or removed, and comments and formatting are kept. Before the first change, the original is copied to `<file>.overseer-backup`. An existing backup is never overwritten, and uninstall never creates or changes one.
- Running `install` again reports `unchanged` and writes nothing.

### Project data

| Path | Contents | Commit it? |
|---|---|---|
| `.overseer/overseer.db` (with `-wal`, `-shm` while open) | the registry: items, links, history, search indexes | no |
| `.overseer/.gitignore` | `*`, so git ignores the whole folder. Your own `.gitignore` is never touched | no |
| `docs/overseer/` (only after an export) | `README.md`, `requirements.md`, `backlog.md`, `history.md`, `overseer.json` | yes, that is what it is for |

- **When `.overseer/` appears**: on the first write in a project you turned on, from an agent recording an item, `overseer add`, `overseer init` or `overseer board`. Read-only commands never create it.
- **One registry per repository**: `.overseer/` lives at the root of the main checkout, so all git worktrees of a repository share one registry. Every harness uses the same database.
- **Deleting `.overseer/` deletes the registry.** The exports are a readable snapshot, not a backup you can restore from.

Two things are kept once per machine, outside any project:

| OS | Model cache | User config (on/off rules) |
|---|---|---|
| Linux | `~/.cache/overseer/models` (honours `XDG_CACHE_HOME`) | `~/.config/overseer/config.json` (honours `XDG_CONFIG_HOME`) |
| macOS | `~/Library/Caches/overseer/models` | `~/Library/Application Support/overseer/config.json` |
| Windows | `%LOCALAPPDATA%\overseer\models` | `%APPDATA%\overseer\config.json` |

Set `OVERSEER_MODEL_DIR` or `OVERSEER_CONFIG_DIR` to use different folders.

### How overseer finds the project

With a user-scope install, one MCP server serves every project. It works out the project on each call, using the first of these that is set:

1. the `project_dir` tool argument (CLI: `--project <dir>`)
2. `OVERSEER_PROJECT`
3. `CLAUDE_PROJECT_DIR` (set by Claude Code)
4. the first workspace root the harness advertises over MCP (`roots/list`)
5. the current directory

The result is then mapped to the root of the git repository's main checkout. Outside git, overseer uses the nearest parent folder that has a `.overseer/`. If that lands on your home directory, one of its ancestors (such as `/home`) or the filesystem root, overseer refuses to write (`NO_PROJECT`) rather than creating a registry there; the skills tell the agent to retry with `project_dir`.

## Uninstall

```sh
overseer uninstall                    # every harness overseer is installed for (user scope)
overseer uninstall --targets codex    # only one harness
overseer uninstall --scope project    # the project-scope files of the current project
npm rm -g @kodrax/overseer            # remove the command itself
```

- **Removed**: the [subagent](concepts.md#subagent) files, skill folders and MCP entries overseer created, plus any folders that end up empty.
- **Kept**: `.overseer-backup` copies and any file without the managed marker. A skill folder holding backups from `install --force` stays, with the backups and your other files in it.
- **Never touched**: a project's `.overseer/` folder. Delete it yourself to drop that project's registry. The model cache and your user config also stay (see [Project data](#project-data)).

# Getting started

Install overseer, turn it on in a project and record your first items. New to coding agents? The [concepts](concepts.md) page explains the terms used here.

## Requirements

- Node.js ≥ 22.18 (uses the built-in `node:sqlite`). Developed and tested on Linux with Node 24.
- Semantic search needs a prebuilt `sqlite-vec` binary, available for Linux x64/arm64, macOS x64/arm64 and Windows x64. On other platforms, or while the model is not downloaded, overseer falls back to keyword search.
- About 120 MB of disk space and network access once, to download the embedding model. Only `overseer install` (without `--skip-model`) and `overseer models pull` download it; searches never do.

## Install

Install the package globally from npm:

```sh
npm install -g @kodrax/overseer

overseer install    # choose your harnesses, wire them up, download the model
overseer doctor     # check runtime, model, project and harness setup

cd ~/work/my-app
overseer enable     # turn overseer on for this project (it is off everywhere by default)
```

In a terminal, `overseer install` shows what it found and lets you choose. Harnesses that are installed on your machine, or that already have overseer, start out checked:

```
Install overseer for which harnesses (user scope)?
  1. [x] claude   Claude Code         claude on PATH (/home/me/.local/bin/claude)
  2. [x] omp      OMP                 omp on PATH (/home/me/.local/bin/omp)
  3. [ ] codex    Codex CLI           ~/.codex exists, but codex is not on PATH
  4. [ ] gemini   Gemini CLI          not found
  5. [ ] copilot  GitHub Copilot CLI  not found
  6. [ ] cursor   Cursor              not found
  7. [ ] opencode OpenCode            not found
Numbers or names (comma-separated), "all", or Enter for [claude, omp]:
```

A [harness](concepts.md#coding-agent-and-harness) counts as installed when its CLI is on `PATH`. A config folder alone does not count, because it may be left over from an uninstalled tool. The exception is Cursor: the desktop app often adds no shell command, so `~/.cursor` is enough.

- `--targets claude,omp` chooses without asking.
- Without `--targets`, outside a terminal (scripts, CI) or with `--json`, `install` never prompts: it uses the detected harnesses plus those overseer is already installed for. If there are none, it asks you to pass `--targets`.
- `--dry-run` prints every planned file write and command and changes nothing.
- `--skip-model` skips the model download; run `overseer models pull` later.

User-scope [MCP](concepts.md#mcp) registrations run your `node` binary and the installed package's `dist/cli.js` by absolute path. Harnesses launched from a desktop app often don't get your shell's `PATH`, so a plain `overseer` command might not be found; absolute paths avoid that. The catch: if the package moves (for example a reinstall under another Node version) or that Node version is removed, run `overseer install` again. `overseer doctor` reports `FAIL` when those paths are gone.

Where `install` writes its files, and the project-scope install for teams, are in [Configuration](configuration.md#where-the-files-go).

## Turning overseer on and off

overseer is off everywhere by default, even after `overseer install`. Turn it on where you want it:

```sh
cd ~/work/my-app
overseer enable     # on for this project and every folder below it
overseer disable    # off again; the data is kept
```

- **Nothing is written into the project.** The folder goes into your user config (`enabled_projects` or `disabled_projects`; see [Project data](configuration.md#project-data)). `.overseer/` appears only when something is first recorded. `disable` keeps it; delete it yourself to remove the data.
- **Off means off at every entry point.** In a project that is off, every overseer MCP tool and every project command of the CLI (including `board`) answers `DISABLED` and creates nothing. The switch is read on every call, so running sessions follow it too. The MCP instructions, the [skills](concepts.md#skill) and the [subagent](concepts.md#subagent) tell the agent to stop there, not to look for another way in, and not to run `overseer enable` itself unless you ask it to.
- **Folders cover what's below them, and the closest rule wins.** `overseer enable` in `~/work` turns on every project under it, and `overseer disable` in `~/work/client-x` then makes an exception. Running `overseer enable` in `~/work/client-x` again removes the exception.
- **Other ways to turn a project on**: `overseer init` and `overseer install --scope project` do it too.
- **Existing registries**: a project that already has a `.overseer/` folder is off too, until you run `overseer enable` there; its data is then used as before.
- **What being off doesn't hide.** The harness still lists the skills and the subagent, and still starts the MCP server. To keep overseer's tool descriptions out of the model's context in a project, also turn the server off in the harness if it supports that per project. In Claude Code, toggle `overseer` off in `/mcp`; Claude Code saves that per project in `~/.claude.json`. OMP's `disabledServers` list applies to every project, not only one.
- **Checking the state.** `overseer doctor` shows whether overseer is off for the current project.

## First run

This takes about five minutes in a git repository of yours. The output below comes from a fresh repository; your paths and similarity scores may differ.

1. Turn overseer on for the project. It is off everywhere until you do:

   ```console
   $ cd ~/work/my-app
   $ overseer enable
   overseer is now on for /home/me/work/my-app and every folder below it.
   Its data goes to /home/me/work/my-app/.overseer, created on the first write and ignored by git.
   Saved in /home/me/.config/overseer/config.json; "overseer disable" turns it off again.
   ```

2. Record a requirement. In your harness, say it in your own words: "Record this requirement: when a user requests a password reset, the system shall email a single-use link that expires after 30 minutes." The agent records it through the `create_item` tool and tells you its ID. The same from the CLI:

   ```console
   $ overseer add requirement --title "Password reset by email" --type functional --status approved \
     --description "When a user requests a password reset, the system shall email a single-use link that expires after 30 minutes." \
     --ac "Given a registered email, when a reset is requested, then a link valid for 30 minutes is sent"
   Created REQ-0001  Password reset by email
   ```

3. Plan the work: a story that [implements](concepts.md#data-model) the requirement.

   ```console
   $ overseer add story --title "Reset forgotten password" \
     --description "As a user I want to reset my password so that I can regain access" --implements REQ-0001
   Created US-0001  Reset forgotten password
   ```

4. Ask whether something is covered: "Is password reset already covered?", or:

   ```console
   $ overseer coverage "password reset"
   verdict: covered
   ID        Status    Coverage  Similarity  Implemented by     Title
   --------  --------  --------  ----------  -----------------  -----------------------
   REQ-0001  approved  tracked   0.72        US-0001 (backlog)  Password reset by email
   ```

   `tracked` means work is planned. [Coverage](concepts.md#coverage) follows the linked work, so it moves on when the story does. The warning is [lint](concepts.md#lint): it never blocks a write.

   ```console
   $ overseer update US-0001 --status in_progress
   Updated US-0001: status
   warning: [missing_acceptance_criteria] No acceptance criteria while status is "in_progress": add Given/When/Then criteria.
   $ overseer coverage "password reset"
   verdict: covered
   ID        Status    Coverage     Similarity  Implemented by         Title
   --------  --------  -----------  ----------  ---------------------  -----------------------
   REQ-0001  approved  in_progress  0.72        US-0001 (in_progress)  Password reset by email
   ```

5. Check for duplicates, in any language. Every new item gets this check before it is written:

   ```console
   $ overseer similar "Restablecer la contraseña por correo"
   verdict: related
   ID        Kind         Status       Match    Similarity  Coverage     Title
   --------  -----------  -----------  -------  ----------  -----------  ------------------------
   REQ-0001  requirement  approved     related  0.39        in_progress  Password reset by email
   US-0001   story        in_progress  related  0.36        -            Reset forgotten password
   ```

6. Open the [web board](board.md) to see the story on the kanban and the requirement with its coverage:

   ```console
   $ overseer board
   overseer board: http://127.0.0.1:4477/ (Ctrl+C to stop)
   ```

## From your harness

In a project you turned on, talk to your agent as usual. The main agent calls the MCP tools directly for quick lookups and edits, and hands bulk work to the `overseer` subagent. Text is recorded in the language you use. In a project that is off, the agent tells you so when you ask for overseer, and does nothing else with it.

- "Record this requirement, asked by Ana: the public API must answer in under 300 ms at p95 with 100 requests per second."
- "Is password reset by email already covered?"
- "Add a bug: on Safari the login button does nothing. Expected the dashboard, got nothing. It affects REQ-0001."
- "Plan an epic for checkout with stories and tasks."
- "Connect this project to our GitHub repository."
- "Use the overseer agent to bootstrap requirements from this codebase."
- "Import our GitHub issues into the board."
- "Ship TASK-0012: branch, implement and open the pull request."
- "US-0003 is done, delivered in PR #42. Anything drifting?"
- "Export the overseer reports."

The CLI does everything the agent does; the [CLI reference](cli.md) lists every command.

---

Next: [Concepts](concepts.md), the terms behind requirements, coverage and the agent setup.

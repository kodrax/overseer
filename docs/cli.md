# CLI reference

Every command runs in the current project (or `--project <dir>`; see [how overseer finds the project](configuration.md#how-overseer-finds-the-project)). `overseer <command> --help` lists each command's options.

## Commands

| Command | Purpose |
|---|---|
| `enable` / `disable` | turn overseer on or off for this project and the folders below it (off by default) |
| `init [--name] [--asked-by]` | turn the project on and create `.overseer/` (optional: the first write creates it) |
| `add <kind> --title …` | record a requirement, epic, story, task or bug; refuses likely duplicates unless `--allow-duplicate` (`--json` prints a compact result, `--full` the whole item) |
| `add --batch <file\|->` | record up to 50 items from a JSON array in one transaction, all or nothing (see [Batch create](#batch-create)) |
| `update <id> …` | change fields or status, `--comment`, `--delivered-in`, `--clear <field>` (`--json` prints a compact result, `--full` the whole item) |
| `show <id>… [--context] [--history]` | items with links, children, [coverage](concepts.md#coverage) and history; several IDs (up to 50) print `{items:[…]}` with `--json`; `--context` adds the parent and the linked requirements with their acceptance criteria; an ID may be an issue reference such as `acme/demo#7` or an issue URL (see [Issue references](sync.md#issue-references)) |
| `list [--kind] [--status] [--type] [--coverage] [--tag] [--parent] [--all] [--limit] [--offset]` | list items (closed ones hidden unless `--all`); `--type` filters requirements by `functional` or `non_functional`, `--parent <id>` lists an item's children; pages of `--limit` items (default 50) starting at `--offset` |
| `search <query>` | hybrid keyword + semantic search |
| `similar <text>` | duplicate check |
| `coverage <text>` | is this already covered, tracked or delivered? |
| `link` / `unlink <src> <rel> <dst>` | relate items |
| `delete <id>` | delete an item without children, with its links; a tombstone keeps its ID, kind, title, external refs, time and actor (see [Data model](concepts.md#data-model)) |
| `report <kind>` | `summary`, `coverage`, `board`, `drift`, `lint`, `traceability` |
| `export [--out] [--only] [--since]` | write Markdown/JSON reports into the project |
| `import <file\|-> --source github\|gitlab --repo <repo>` | import issues from a JSON array of ImportItems or a raw GitHub/GitLab [MCP](concepts.md#mcp) response, optionally with `deleted` issues |
| `pr draft <id> [--type <type>]` | pull request title and body for a task or bug (see below) |
| `pr opened [<id>] --url <url>` | record an opened pull request: the item becomes review with `delivered_in` and `code_refs` (see below) |
| `worktree start <id> [--type] [--slug] [--base] [--no-setup]` | create or reuse the git worktree and branch of a task or bug and set a backlog or ready item in_progress (see [Worktrees](#worktrees)) |
| `worktree finish <id> --merged-head <sha> [--pr] [--base]` | after the merge: remove the worktree and branches, fast-forward the base, set the item done and roll its story up to done |
| `worktree list` | worktrees on task and bug branches, with their item IDs |
| `sync remotes` | GitHub, GitLab and other repositories named by the project's git remotes (see [Repository remotes](sync.md#repository-remotes)) |
| `sync status` | sync state: each connection with its MCP server, auto-sync flag, last sync cursor, sync start time, pending outbox entries and the fields its latest pull and confirm overwrote, and the source of truth (see [Sync status](sync.md#sync-status)) |
| `sync connections` | the project's repository connections, with their MCP server and auto-sync flag (see [Repository connections](sync.md#repository-connections)) |
| `sync connection add --host github\|gitlab --repo <repo> [--mcp-server <name>]` | connect a GitHub or GitLab repository to the project, with auto-sync on |
| `sync connection set <id> [--auto-sync on\|off] [--mcp-server <name>]` | change a connection's auto-sync flag or MCP server |
| `sync connection remove <id>` | delete a connection with its remote refs, mappings and pending outbox rows; a removed source of truth goes back to the board |
| `sync source-of-truth` | the source of truth and why: `board` until sync starts on a connection, then that connection with its host and repository (see [Source of truth](sync.md#source-of-truth)) |
| `sync inspect <file\|-> --source github\|gitlab` | labels, issue types, milestones, sub-issue support and boards of a repository, from a bundle of raw MCP responses (see [Tracking setup](sync.md#tracking-setup)) |
| `sync mapping <connection>` | a connection's kind, status and priority mapping, every local value listed and unmapped ones marked (see [Kind, status and priority mapping](sync.md#kind-status-and-priority-mapping)) |
| `sync mapping set <connection> --dimension kind\|status\|priority --local <value> --remote <value>` | map one local value to a label or state, replacing its earlier remote value |
| `sync mapping import <connection> <file\|->` | replace a connection's whole mapping with a JSON mapping, all or nothing |
| `sync outbox [<connection>]` | local item changes waiting to be pushed, per connection with auto-sync on (see [Outbox](sync.md#outbox)) |
| `sync outbox ack <seq...>` | remove outbox entries once their push is confirmed, all or nothing |
| `sync start <connection> <file\|->` | start syncing a connection, once: an empty repository is seeded from the board (a create queued for every item without an issue there), a repository with issues comes to the board as an import (nothing queued); records its sync start time (see [Sync start](sync.md#sync-start)) |
| `sync plan <connection> <file\|->` | the push and pull operations that would sync a connection, with conflicts resolved by the source of truth, from a raw MCP listing of its issues; writes nothing (see [Sync plan](sync.md#sync-plan)) |
| `sync pull <connection> <file\|->` | apply the pull operations of `sync plan`: create items for new issues and apply remote changes without a pending local change, or that win as source of truth (see [Sync pull](sync.md#sync-pull)) |
| `sync confirm <connection> <file\|->` | record the pushes run for a plan: remote ref, snapshot of the pushed values, outbox ack; all or nothing (see [Sync confirm](sync.md#sync-confirm)) |
| `board [--port] [--no-open]` | serve the web board |
| `mcp` | run the MCP server over stdio ([harnesses](concepts.md#coding-agent-and-harness) start it) |
| `models pull` | download the embedding model |
| `reindex` | rebuild the keyword index and re-embed every item |
| `config get [key] [--stored]` / `config set <key> <value>` | project settings (`--stored`: only the ones set in this project) |
| `install` / `uninstall` / `doctor` | harness wiring and health checks |

## Examples

```sh
overseer enable                             # once per project
overseer add requirement --title "Password reset by email" --type functional --status approved \
  --description "When a user requests a password reset, the system shall email a single-use link that expires after 30 minutes." \
  --ac "Given a registered email, when a reset is requested, then a link valid for 30 minutes is sent"
overseer add story --title "Reset forgotten password" \
  --description "As a user I want to reset my password so that I can regain access" --implements REQ-0001
overseer add --batch dictation.json         # up to 50 items in one call (see below)
overseer update US-0001 --status done --delivered-in "PR #42"
overseer coverage "password reset"          # covered / partially / not_found (unknown without the model)
overseer similar "Restablecer la contraseña por correo"
overseer report drift
overseer export                             # writes docs/overseer/
```

## JSON output and errors

Every command except `mcp`, `board` and `models pull` accepts `--json`. Errors go to stderr as `error: <CODE>: <message>` with exit code 1. With `--json`, they go to stdout as `{"error":{"code","message"}}`, plus `"details"` when the error carries them (a missing issue to import, the problems of a batch). MCP tools answer `<CODE>: <message>` with `isError: true`; details come as a second text block `{"details": …}` and as `structuredContent.error.details`.

`add --json` and `create_item` return a compact result for agents: `{"created": true, "id", "title", "status", "verdict", "candidates": [{"id", "title", "similarity", "match"}], "warnings"}`. `verdict` and `candidates` come from the duplicate check and use `find_similar`'s values (`duplicate`, `related`, `new`, or `unknown` when only keyword search is available). A likely duplicate gives `{"created": false, "reason": "possible_duplicate", "verdict": "duplicate", "candidates"}` and nothing is written. `update --json` and `update_item` return `{"id", "title", "status", "changed_fields", "warnings"}`. `--full` (`full: true` in MCP) returns the whole item instead: `{"created", "item", "warnings", "similar"}`, `{"created": false, "reason", "candidates"}` and `{"item", "changed_fields", "warnings"}`. The text output and the web board are not affected.

Write results also say when a change waits to be pushed: see [Sync pending](sync.md#sync-pending).

## Pull requests

`overseer pr draft TASK-0058 --json` prints `{"title", "body"}` for a pull request, ready for `gh pr create --title … --body …`:

- **Title**: `<type>: <summary> (<ID>)`, at most 100 characters. The type is `--type`, else the one in the current branch when it is named `<type>/<ID>-…`, else `fix` for bugs and `feat` for tasks. The summary is the item title in imperative form with a lowercase first letter (`Adds the sender` → `add the sender`).
- **Body**: the repository's `.github/pull_request_template.md`, else `.gitlab/merge_request_templates/Default.md`, else overseer's default template. Branch and template come from the checkout you run it in (linked worktrees included). The command fills the `Item:` line, the Why section (description plus linked requirements with their titles) and the acceptance criteria as a checklist, adding those sections when the template lacks them. Under `Item:` it closes the item's issue in each repository it is linked to (the imported issue and the issues of its sync connections): `Closes owner/repo#N` for every issue on the pull request's host, which is that of the branch's upstream remote, else `origin` (a self-hosted server takes the host of the connections to its repository). An issue on the other host, which the pull request cannot close, gets `Also tracked in GitLab: <issue URL>` (or `GitHub`) instead. Without a known host every issue gets `Closes`. Other sections keep their HTML comment for you to complete.

The same item, template, branch and remote always give the same draft. This command has no MCP tool.

`overseer pr opened --url <url> --json`, run inside an item's worktree after the pull request is created, prints `{"id", "status", "branch", "base", "delivered_in", "code_refs"}`:

- **Item**: read from the current branch with `branch_pattern`. A branch the pattern does not produce for a task or bug ID (or a detached HEAD) gives `INVALID_INPUT` naming the branch and the pattern. With an explicit ID (`overseer pr opened TASK-0058 --url <url>`) it works from any folder, using the local, else `origin`, branch that fills `branch_pattern` with the ID.
- **Status**: the item becomes `review` with `delivered_in` = the URL, `code_refs` = the files the branch changed since its merge-base with `origin/<base_branch>` (else the local base branch; the item's `code_refs` when nothing changed) and a comment with the URL. This command has no MCP tool.

## Batch create

`overseer add --batch <file|->` and `create_item` with `items` record up to 50 items in one call. The file is a JSON array (or `{"items": [...]}`); `create_item` takes `items` instead of the single-item fields, never both. Each entry takes the `create_item` fields plus an optional `key`: 1–64 letters, digits, `_`, `.` or `-`. `parent_id` and `links[].to` take an existing ID or `@<key>` of another entry in the same batch, in any order. Item IDs never start with `@`, so a reference is a batch key exactly when it does.

```json
[
  {"key": "r1", "kind": "requirement", "req_type": "functional", "title": "Redeem a gift card at checkout"},
  {"key": "s1", "kind": "story", "title": "Pay with a gift card", "parent_id": "EPIC-0002", "links": [{"rel": "implements", "to": "@r1"}]},
  {"kind": "task", "title": "Add the gift card field to checkout", "parent_id": "@s1"}
]
```

- **Validated as a whole first**: entry schemas and unknown fields, kind rules, statuses, duplicate keys, unknown keys and IDs, parent and link kind rules, and parent cycles. Any problem writes nothing; the `INVALID_INPUT` message lists every one as `items[<index>] (@<key>): …`.
- **Duplicate check per entry**: each entry is compared with the stored items and with the earlier entries of the same kind, as a single create does. If any entry is a likely duplicate and lacks its own `"allow_duplicate": true`, nothing is written and the result is `{"created": false, "reason": "possible_duplicate", "duplicates": [{"index", "key", "candidates"}]}`. A candidate from the batch carries `index` and `key` instead of an `id`.
- **One transaction**: IDs follow the batch order. On success, `--json` and `create_item` return `{"created": true, "items": [{"key", "id", "title", "status", "verdict", "candidates", "warnings"}]}`; `--full` (`full: true`) returns `{"created": true, "items": [{"key", "item", "warnings", "similar"}]}`.

## Worktrees

`overseer worktree start TASK-0038 --json` gives a task or bug its own branch and worktree and prints `{"path", "branch", "base", "reused", "status", "setup": {"command", "ran"}}`:

- **Branch**: `branch_pattern` filled with the type (`--type`, else `fix` for bugs and `feat` for tasks; bugs always use `fix`), the ID and the slug (`--slug`, else the first four words of the title without accents and filler words: `Create and reuse issue worktrees` → `create-reuse-issue-worktrees`).
- **Path**: `<worktree_root>/<ID>-<slug>`, with `worktree_root` taken relative to the main checkout, also when you run the command inside another worktree.
- **New branch**: overseer fetches `origin` and starts from `origin/<base>`, else from the local `<base>`. The base is `--base`, else `base_branch`.
- **Dependencies**: without `--base`, an item that `depends_on` a task or bug that is not `done` or `cancelled` gives `CONFLICT` and nothing is created. The message lists each one with its status and its branch (local or on `origin`) when it has one. Wait for it, or stack on it with `--base <its branch>` so the pull request targets that branch; any explicit `--base`, including the base branch, starts anyway. Requirements and other non-work targets are ignored, and a reused worktree is never blocked.
- **Reuse**: a worktree already on the branch is returned with `reused: true`. A branch without a worktree gets one, and no new branch is created. A path that exists but is not the branch's worktree gives `CONFLICT`, and nothing is changed.
- **Setup**: a new worktree runs `worktree_setup`, its output going to stderr. Without the setting, the command follows the lockfile: `npm ci`, `pnpm install --frozen-lockfile` or `yarn install --immutable`. `--no-setup` skips it. If the setup fails, the worktree is kept and the command exits with `SETUP_FAILED`, naming the command and the path.
- **Status**: once the worktree is created or reused, an item in `backlog` or `ready` becomes `in_progress` with a comment naming the branch; `status` is the item's status afterwards. Items already `in_progress`, `review` or later are left alone.

`overseer worktree finish TASK-0038 --merged-head <sha> --pr <url> --json` cleans up after the pull request is merged. `<sha>` is the pull request's head commit (`gh pr view <url> --json headRefOid`). It prints `{"id", "status", "branch", "path", "remote_branch", "base": {"branch", "head", "fast_forwarded", "reason"}, "delivered_in", "code_refs", "story_done"}`:

- **Branch**: the local or remote branch that fills `branch_pattern` with the ID (any type and slug). Its remote is the branch's upstream, else `origin`; overseer fetches it with `--prune` first. Two matching branches give `CONFLICT`.
- **Safety**: uncommitted or untracked changes in the worktree, or commits on the local or remote branch that the merged head lacks, give `CONFLICT` listing them, and nothing is removed. Ignored files (dependencies, build output) are removed with the worktree.
- **Cleanup**: deletes the remote branch when it is still there, removes the worktree and the local branch, and prunes the worktree list.
- **Base**: the local `--base` (else `base_branch`) is fast-forwarded to its remote, with `git merge --ff-only` where it is checked out. When it has local commits, or its checkout blocks the merge, it is left alone and `base.reason` says why.
- **Item**: set to `done`, with `delivered_in` = `--pr` (else the item's `delivered_in`; one of them is required) and `code_refs` = the files the branch changed against the base (else the item's `code_refs`).
- **Story**: when the item's parent is a story and every task and bug under it is now `done` or `cancelled`, with at least one `done`, the story becomes `done` with a comment and `story_done` is its ID (else `null`). Epics are never changed.

`overseer worktree list --json` prints `[{"id", "branch", "path"}]` for every worktree on a branch that fills `branch_pattern`, the main checkout excluded. These commands have no MCP tool.

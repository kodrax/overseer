# GitHub and GitLab sync

overseer can import issues from GitHub or GitLab once, or keep the board and one or more repositories in sync. overseer itself makes no network call and stores no token: the `overseer-import` and `overseer-sync` [skills](concepts.md#skill) reach GitHub and GitLab through the [MCP](concepts.md#mcp) server configured in your [harness](concepts.md#coding-agent-and-harness), then hand the raw answers to overseer. You ask your agent ("import our GitHub issues", "connect this project to GitHub"); the commands below are what the skills run.

| Step | Commands | Section |
|---|---|---|
| Import issues once, one-way | `overseer import`, `import_items` | [Importing issues](#importing-issues) |
| Find the item of an issue | `overseer show acme/demo#7`, `get_item` | [Issue references](#issue-references) |
| Connect a repository | ask your agent; `sync remotes`, `sync connection add` | [Connect](#connect), [Repository remotes](#repository-remotes), [Repository connections](#repository-connections) |
| Map kinds, statuses and priorities to labels | `sync inspect`, `sync mapping` | [Tracking setup](#tracking-setup), [Kind, status and priority mapping](#kind-status-and-priority-mapping) |
| Start syncing a connection, once | `sync start` | [Sync start](#sync-start) |
| Sync | `sync plan`, `sync pull`, `sync confirm` | [Sync plan](#sync-plan), [Sync pull](#sync-pull), [Sync confirm](#sync-confirm) |
| See what waits and who wins | `sync status`, `sync outbox`, `sync source-of-truth` | [Sync status](#sync-status), [Outbox](#outbox), [Sync pending](#sync-pending), [Source of truth](#source-of-truth) |

## Importing issues

The `overseer-import` skill reads issues through the GitHub or GitLab MCP server configured in your harness, so overseer itself stores no tokens. It fetches every page and passes each raw answer to `import_items` (`payload`) or `overseer import -`; overseer does the field mapping.

- **Re-running is safe**: re-imports update titles, descriptions, labels, the assignee, the milestone and the issue URL. An issue without `body` keeps its stored description; `"body": ""` clears it. Status changes only when the remote open/closed state changes, and local data (priority, links, acceptance criteria, comments) stays, except what a connected repository's mapped labels name (see **Mapped labels**).
- **Closed issues**: a closed issue makes the item `done` (requirements `implemented`); a GitHub issue closed as not planned or duplicate (`state_reason` / `stateReason`) makes it `cancelled`, as does a label the connection maps to `cancelled` (see **Mapped labels**).
- **Deleted issues**: `deleted: ["<external_id>", ...]` next to `items` or `payload` deletes the item of each listed issue as `overseer delete` does (tombstone kept, delete event via `import:<source>`) and lists the item IDs in `deleted`. An item with children is kept, and an issue without an item is skipped, each with a warning. `items` may be empty when `deleted` is given.
- **Connected repositories**: when `sync connections` holds a connection for the import's host and repository (case-insensitive), each imported item gets or refreshes its remote ref for that connection (issue ID, URL, state, sync time) and the snapshot `sync plan` compares against: the issue's `title`, `body`, `labels`, `state`, `assignee` and `milestone` (see [Sync plan](#sync-plan)). A listing without bodies (GitLab `list_work_items`) keeps the snapshot's earlier body. Without a connection, nothing else changes.
- **Mapped labels**: with such a connection, the labels are read through its mapping as [`sync pull`](#sync-pull) reads them (**Labels** there), on the first import and on every re-import: mapped labels set the kind (new items only), priority and status instead of becoming tags. Without a connection every label is a tag, as before.
- **Finding an issue's item**: with such a connection, an issue's item is the one linked to it through its remote ref on that connection, else the one whose `external_ref` names it; without a connection, only `external_ref` counts. So an item pushed to GitHub first and linked to its GitLab issue on push is updated (and deleted, through `deleted`) by an import of the GitLab repository, never duplicated. Such an item keeps its own `external_ref`, `external_url` and `external_state`: the import updates its title, description, tags, assignee, milestone, mapped priority and status, and the GitLab issue's URL, state and snapshot go to its remote ref on that connection. The changes are queued for the other connections only (GitHub here) as updates, never as a create.
- **One-way**: nothing is pushed back to GitHub or GitLab.
- **Setup**: [`templates/skills/overseer-import/references/integrations.md`](../templates/skills/overseer-import/references/integrations.md) is a per-harness guide (Claude Code, Codex, Gemini CLI, Copilot CLI, Cursor, OMP, OpenCode) with a source for each snippet. GitHub: the official server, read-only for import or with issue write access plus label and project reads. GitLab: [zereight/gitlab-mcp](https://github.com/zereight/gitlab-mcp) (`npx -y @zereight/mcp-gitlab`, read-only switch for import) or GitLab's built-in server.

`import_items` takes the issues in one of two fields, never both:

- `items`: ImportItems (`external_id`, `url`, `title`, `state`, optional `body`, `state_reason`, `labels`, `type_hint`, `assignees`, `milestone`, `created_at`, `updated_at`, `parent_external_id`).
- `payload`: a raw MCP response, as an object or as the tool's JSON text. overseer maps it:
  - GitHub `list_issues` (`{"issues": [...]}`, or an array of REST issues): `external_id` is `<repo>#<number>`; issue type Bug, Feature or Task becomes `bug`, `story` or `task`; `state_reason` (or GraphQL `stateReason`) is kept; pull requests are skipped and named in `warnings`.
  - GitLab `list_issues` (an array of REST issues: `iid`, `description`, `state` `opened`/`closed`, `labels`, `assignees`, `milestone`, `issue_type`, `web_url`, `references.full`), `get_issue` (one REST issue), `list_work_items` (`{"items": [...], "pageInfo": {...}}`), `get_work_item` (one work item) or an array of work items: `external_id` is `group/project#<iid>` (the project from `references.full`, else the URL); type (or REST `issue_type`) Epic, Task, Incident or Requirement becomes `epic`, `task`, `bug` or `requirement`; type Issue gets no type hint; state `opened`/`OPEN` becomes `open`; the description becomes the body (`null` as `""`); the hierarchy parent becomes `parent_external_id`. `list_work_items` results carry no description, so they leave stored descriptions alone; list with `list_issues` (or import `get_work_item`) for the bodies.
  - Any other shape fails with `INVALID_INPUT` naming the accepted formats, and nothing is imported.

The CLI accepts both and detects the format: a JSON array of ImportItems (or `{"items": [...]}`) as before, or a saved MCP response. An object adds `"deleted": [...]` next to `items` or `issues`, or holds it alone.

```sh
echo '[{"external_id":"acme/demo#7","url":"https://github.com/acme/demo/issues/7","title":"Login fails on Safari","state":"open","labels":["bug"]}]' \
  | overseer import - --source github --repo acme/demo
overseer import list_issues.json --source github --repo acme/demo
echo '{"deleted":["acme/demo#7"]}' | overseer import - --source github --repo acme/demo
```

## Issue references

`overseer show` and `get_item` (`id` and each of `ids`) take an issue reference wherever they take an item ID, and return the item imported or synced from that issue. IDs (`TASK-0012`) are looked up as before.

| Reference | Repository |
|---|---|
| `acme/demo#7` | `acme/demo` on GitHub or GitLab; deeper paths (`group/sub/project#3`) are GitLab only |
| `github:acme/demo#7`, `gitlab:group/sub/project#3` | that host |
| `https://github.com/acme/demo/issues/7` | GitHub |
| `https://gitlab.com/group/sub/project/-/issues/3`, `…/-/work_items/3` | GitLab, on any hostname |
| `#7` | the connected repository, when exactly one is connected (see [Repository connections](#repository-connections)); else `INVALID_INPUT` asking for `owner/repo#7` or the URL |

A reference matches an imported item's `external_ref` (`github:acme/demo#7`) or a connected repository's issue reference on an item; repository paths compare case-insensitively. When nothing matches:

- **Connected repository**: `NOT_FOUND` with `details` naming the issue to import, in `import_items` terms: `{"source": "github", "repo": "acme/demo", "external_id": "acme/demo#7", "url": "https://github.com/acme/demo/issues/7"}` (`url` is the given URL, else the github.com or gitlab.com one). The `overseer-ship` skill imports that one issue and continues.
- **Any other repository**: a plain `NOT_FOUND: No item for acme/demo#7.`

```sh
overseer show acme/demo#7 --context --json
overseer show https://gitlab.com/group/sub/project/-/work_items/3 '#7' TASK-0012 --json
```

## Connect

The `overseer-sync` skill connects the project to its GitHub or GitLab repositories, through the GitHub or GitLab MCP server configured in your harness. Ask your agent "connect this project to GitHub" and it:

1. Lists the repositories of the project's git remotes (`sync remotes`), asks which host an `unknown` one is, and offers them.
2. Checks that the session has the host's MCP tools; if not, it shows your harness's setup from [`overseer-import/references/integrations.md`](../templates/skills/overseer-import/references/integrations.md) and stops. Otherwise it asks which MCP server reaches the repository, offering the servers it finds in the session (by their tool-name prefix) or the host default, `github` or `gitlab`.
3. Connects only the repositories you confirm, storing that server (`sync connection add --mcp-server <name>`, auto-sync on; `sync connection set <id> --mcp-server <name>` for a repository already connected).
4. Fetches the repository's labels, issue types, milestones and boards through the MCP server, summarises them with `sync inspect` and proposes a kind, status and priority mapping from those existing names. For each value still unmapped it proposes a new label, named in the repository's label style (else `kind: task`, `status: in progress`, `priority: must`) with a colour; labels only, never issue types. After you confirm all of the proposal or a subset, it creates the confirmed labels through the MCP server (GitHub `label_write`, gitlab-mcp `create_label`; see "Creating labels" in [integrations.md](../templates/skills/overseer-import/references/integrations.md)) and only then stores the mapping with `sync mapping import`. Nothing is created without your confirmation. A server without a label-creation tool (GitLab's built-in server), or a failed creation, is reported and those values stay unmapped; the unmapped values are listed.
5. Starts sync on each connection, after its mapping so seeded issues get its labels: it fetches every page of the repository's issue listing through the MCP server and runs [`sync start`](#sync-start), then tells you which case applied. An empty repository (`from: "board"`) is seeded from the board: it reports the creates queued by kind and goes straight on to the [sync](#sync-plan) (plan, pushes through the MCP server, `sync confirm`), so every item becomes an issue (closed items' issues closed). A repository with issues (`from: "repository"`) brings them to the board: it reports the items created and linked, and the items already on the board are not pushed. A connection whose sync already started (`CONFLICT`) goes straight to the sync.
6. Tells you the [source of truth](#source-of-truth) is the board until sync starts on a connection, then that connection; it never asks you to choose one.
7. Ends with `sync status`.

Every GitHub or GitLab call of the skill, when connecting and when syncing, goes to the tools of the connection's stored MCP server (`mcp_server` in `sync connections --json`), named with your harness's prefix (for example `mcp__<server>__<tool>` in Claude Code and Codex, `mcp__<server>_<tool>` in OMP); a connection without one uses the host default, `github` or `gitlab`.

## Repository remotes

`overseer sync remotes --json` lists the repositories the project's git remotes point to, as candidates for connecting the project to GitHub or GitLab. It prints `[{"host", "hostname", "repository", "remotes": [{"name", "url"}]}]`; without `--json`, a table:

- **Remotes**: every remote, not only `origin`, with its fetch and push URLs as `git remote -v` shows them. SSH (`git@host:path`), `ssh://host:port/path`, `git://` and `http(s)://` URLs are read, with or without `.git` and a trailing slash. Local paths and `file://` URLs are skipped.
- **Repository**: `hostname` is lowercase without user or port; `repository` is the path without `.git` and slashes around it (`acme/demo`, `group/sub/project`).
- **Host**: `github` for `github.com`, `gitlab` for `gitlab.com` and any hostname containing `gitlab` (`gitlab.example.com`), else `unknown` (GitHub Enterprise, `git.example.com`) with the path kept, so the user says what it is.
- **One entry per repository**: remotes pointing to the same hostname and path (case-insensitive) share an entry listing all of them.
- **Credentials**: user and password are removed from `http(s)` URLs, so tokens are never printed.
- **No remotes**, or a folder outside git, print `[]` (`No git remotes.` without `--json`).

It reads only the local git config and makes no network calls. This command has no MCP tool.

## Repository connections

A connection is one GitHub or GitLab repository the project syncs with. `overseer sync connection add --host github --repo acme/demo --mcp-server github --json` stores it and prints `{"id", "host", "repository", "mcp_server", "auto_sync", "last_sync_cursor", "sync_started_at", "created_at"}`; without `--json`, one `key: value` line per field:

- **Repository**: `owner/repo` on GitHub; `group/project` on GitLab, with any number of subgroups (`group/sub/project`). Slashes around it and `.git` are dropped, as in `sync remotes`. Each part holds letters, digits, `.`, `_` and `-`. Another host, or another repository shape (a URL, `acme`, `acme/demo/extra` on GitHub), gives `INVALID_INPUT`.
- **One connection per repository**: the same host and repository again (case-insensitive) gives `CONFLICT` naming the existing connection's id.
- **MCP server**: the harness MCP server that reaches the repository (`--mcp-server`), else `null`.
- **Auto-sync**: on for a new connection; `last_sync_cursor` is `null` until the first pull, and `sync_started_at` until [`sync start`](#sync-start).

`overseer sync connections --json` lists every connection by id (`[]` when there is none; `No connections.` and a table without `--json`). `overseer sync connection set <id> --auto-sync on|off --mcp-server <name> --json` changes either field and prints the connection; give at least one. `overseer sync connection remove <id> --json` deletes the connection together with its issue references on items, its kind/status/priority mappings and its pending outbox rows, and prints `{"removed": <connection>, "remote_refs", "mappings", "outbox", "source_of_truth_reset"}` with the number of rows deleted from each. When the removed connection was the source of truth, the board becomes the source of truth in the same step, even when another connection has started sync: `source_of_truth_reset` is `true` and the text output adds `Source of truth reset to board.`. An unknown id gives `NOT_FOUND`.

These commands read and write only the project database: they make no GitHub or GitLab call and record nothing in item history. They have no MCP tool.

`overseer doctor` adds one `connection <id>` line per connection, after the harness checks. It looks for the connection's MCP server in each harness overseer is installed for, in user scope and in the current project's scope: in the config file overseer registers its own server in (Codex's `config.toml`, the JSON or JSONC file of the other harnesses), and for Claude Code in user scope through `claude mcp get <name>`, or `claude mcp list` when the connection names no server.

- **By name**: a connection with an MCP server counts a server with that name.
- **By host**: a connection without one counts a server whose URL or command contains the host's usual server: `api.githubcopilot.com/mcp` or `github-mcp-server` for GitHub, `@zereight/mcp-gitlab` or `/api/v4/mcp` for GitLab.
- **OK** names the server, with its URL or command, and the harnesses that have it, then the harnesses that don't: `OK    connection 1: github acme/demo: MCP server "github" (https://api.githubcopilot.com/mcp/) in omp (user); not in claude (user)`.
- **WARN** when no harness has it, naming the connection, the harnesses checked and the setup guide (`overseer-import/references/integrations.md` in the installed skills of a checked harness, else in this package's `templates/skills`): `WARN  connection 2: gitlab group/app: no GitLab MCP server (@zereight/mcp-gitlab or /api/v4/mcp) in claude (user), omp (user); set one up as /home/me/.claude/skills/overseer-import/references/integrations.md shows`. A harness config that cannot be read, or `claude` missing from `PATH`, is listed as `cannot check <harness>: <reason>`.

A project without connections gets no `connection` lines, and doctor reads no harness MCP config and runs no harness command for them. doctor itself makes no network call; Claude Code's CLI may check its servers' health when it lists them.

## Source of truth

The source of truth is where synced item fields come from when the board and a connected repository disagree: the board, or one connection. Nobody chooses it; it follows from [`sync start`](#sync-start):

- **Board** until sync starts on a connection.
- **Connection**: the first connection whose sync starts while the board is the source of truth becomes it, in the same transaction as the start. Starting sync on other connections later leaves it unchanged.
- **Back to the board** when that connection is [removed](#repository-connections), even if another connection has started sync; the next connection whose sync starts then becomes it.
- **Upgrade**: a choice stored by `sync source-of-truth set` (removed) is dropped when the database is upgraded; a connection whose sync already started becomes the source of truth, the earliest start first, else the board.

`overseer sync source-of-truth --json` prints `{"source_of_truth": "board", "host": null, "repository": null, "reason"}` or `{"source_of_truth": <connection id>, "host", "repository", "reason"}`, where `reason` says why (`Sync of connection 1 (github acme/demo) started at <time> while the board was the source of truth.`); without `--json`, one `key: value` line per field that is set.

It reads only the project database: no GitHub or GitLab call, nothing in item history. It has no MCP tool.

## Sync status

`overseer sync status --json` prints `{"connections": [...], "source_of_truth": "board"}`: every connection as in `sync connections` (`id`, `host`, `repository`, `mcp_server`, `auto_sync`, `last_sync_cursor`, `sync_started_at`, `created_at`) plus `pending_outbox`, the number of its rows waiting in the outbox, and `overwritten`. `last_sync_cursor` is `null` until the first sync, `sync_started_at` until [`sync start`](#sync-start). A connection as source of truth shows as `{"id", "host", "repository"}`. With no connection it prints `{"connections": [], "source_of_truth": "board"}`. Without `--json`, a table (`No connections.` when there is none; `never` for a connection not synced or started yet), a `Source of truth:` line with the connection's host and repository, then an `Overwritten by the latest pull and confirm of connection <id> (<host> <repository>):` table for each connection that has overwritten fields.

- **Overwritten**: the fields the connection's latest [`sync pull`](#sync-pull) that applied changes and latest [`sync confirm`](#sync-confirm) overwrote, `[{"step", "item_id", "external_ref", "field", "winner", "value", "overwritten", "at"}]`, as `sync plan` lists them plus `step` (`pull`, winner `remote`: the issue's value replaced a local edit; `confirm`, winner `local`: the pushed value replaced an issue edit) and `at`, when that pull or confirm ran. Pull entries come first, then by item ID and synced field order; `[]` when none (nothing is shown without `--json`).
- **Stored per connection**: each pull that applies changes replaces the connection's pull entries, each confirm its confirm entries, and `sync connection remove` deletes them. They are kept per connection rather than read back from history because history events name the host (`sync:github`), not the connection or the pull or confirm they belong to; the item's history keeps every overwrite.

It reads only the project database: no GitHub or GitLab call. It has no MCP tool.

## Tracking setup

`overseer sync inspect <file|-> --source github|gitlab --json` summarises a repository's tracking setup from MCP responses the agent already fetched, for mapping overseer's kinds, statuses and priorities onto it. It prints `{"labels", "issue_types", "milestones", "sub_issues", "boards", "warnings"}`; without `--json`, one `key: value` line per part and a `warning:` line per warning.

The bundle is one JSON object keyed by MCP tool name. Each value is the tool's raw answer: the JSON, or its text as a string. An array of answers holds several calls (pages, several issues or work item types):

```json
{
  "list_label": [{"labels": [{"name": "bug", "color": "d73a4a", "description": ""}], "totalCount": 1, "pageInfo": {"hasNextPage": false, "hasPreviousPage": false}}],
  "list_issue_types": "[{\"id\": 1, \"name\": \"Bug\", \"is_enabled\": true}]",
  "projects_list": {"projects": [{"number": 1, "title": "Roadmap"}], "pageInfo": {"hasNextPage": false, "hasPreviousPage": false}}
}
```

| Part | GitHub ([github-mcp-server](https://github.com/github/github-mcp-server)) | GitLab ([zereight/gitlab-mcp](https://github.com/zereight/gitlab-mcp)) |
|---|---|---|
| `labels` | `list_label`, `get_label` | `list_labels`, `get_label` |
| `issue_types` | `list_issue_types` (disabled types left out) | `list_work_item_statuses`: each answer's work item type and the types it converts to |
| `milestones` | `ui_get` with `method: milestones` | `list_milestones`, `list_group_milestones`, `get_milestone` |
| `sub_issues` | `issue_read`: a `get_sub_issues` or `get_parent` answer, or a `get` answer with `has_parent` / `has_children` | `list_work_item_statuses`: `true` when a type has allowed child or parent types, `false` when none has |
| `boards` | `projects_list` with `method: list_projects`, `projects_get` with `method: get_project` | `gitlab_api_request` `GET projects/<id>/boards` (gitlab-mcp has no board tool) |

- **Names**: label, type, milestone and board names are trimmed, without duplicates, and sorted case-insensitively (then by character code), so the same answers in any order print the same bytes.
- **Unknown parts**: a part that no tool in the bundle answers is `null`, never `[]`, with a warning naming the tool to add (`milestones: unknown, the bundle has no ui_get (method milestones) response.`). An answer without names, such as a repository without labels, gives `[]`.
- **Server setup**: the overseer-import skill's `references/integrations.md` enables these tools. Two parts stay unknown even so: GitHub milestones, because `ui_get` is only callable by MCP Apps views, not by agents; and GitLab boards unless you add gitlab-mcp's `api` toolset, which gitlab-mcp marks as dangerous.
- **Errors**: a key the source does not accept, an answer of the wrong shape, or a bundle that is not a JSON object or is empty give `INVALID_INPUT` listing the accepted tools and the parts each answers.

`overseer sync inspect --help` lists the accepted tools. It reads only the bundle and makes no network calls. This command has no MCP tool.

## Kind, status and priority mapping

Each connection maps overseer's kinds, statuses and priorities onto the repository's labels (statuses also onto the states `open` and `closed`), so import and push can translate them. Push sends every mapped value as a label and never sets an issue type, so issue types listed by `sync inspect` are information only, never mapping targets. Each local value has at most one remote value per connection; two local values may share one (`done` and `cancelled` → `closed`). The local values are:

| Dimension | Local values |
|---|---|
| `kind` | `requirement`, `epic`, `story`, `task`, `bug` |
| `status` | every kind's statuses: `proposed`, `approved`, `implemented`, `verified`, `deferred`, `rejected`, `obsolete`, `open`, `in_progress`, `done`, `cancelled`, `backlog`, `ready`, `review` |
| `priority` | `must`, `should`, `could`, `wont` |

`overseer sync mapping set <connection> --dimension kind --local task --remote "type: task" --json` stores one pair and prints `{"connection_id", "dimension", "local_value", "remote_value", "previous_value"}`; `previous_value` is the remote value it replaced, else `null`. The remote value is trimmed. A dimension or local value not in the table (`--local feature`, `--local Task`) gives `INVALID_INPUT` listing the valid values; a remote value that is blank or longer than 255 characters gives `INVALID_INPUT` too.

`overseer sync mapping <connection> --json` prints `{"connection_id", "mapping": {"kind": {…}, "status": {…}, "priority": {…}}}` with every local value in the table's order; an unmapped one is `null`. Without `--json`, a table with one row per dimension and local value, `(unmapped)` for those without a remote value.

`overseer sync mapping import <connection> <file|-> --json` replaces the connection's whole mapping with a JSON file or stdin (`-`) and prints the new mapping. The format is the `mapping` object above: one object per dimension from local value to remote value, built from the names `sync inspect` lists. A missing dimension, a missing local value or `null` leaves the value unmapped, so `{}` clears the mapping:

```json
{
  "kind": {"story": "Feature", "task": "Task", "bug": "Bug"},
  "status": {"in_progress": "status: in progress", "done": "closed", "cancelled": "closed"},
  "priority": {"must": "priority: high", "should": "priority: medium"}
}
```

The whole file is checked before anything is written: an unknown dimension or local value, a remote value that is not a string of 1 to 255 characters, or input that is not a JSON object gives one `INVALID_INPUT` listing every problem (`kind: unknown kind value "feature"; valid: …`), and the old mapping stays as it was. `sync mapping <connection> --json | jq .mapping` gives a file another connection can import.

An unknown connection gives `NOT_FOUND` for every mapping command, before the rest of the input is checked. `sync connection remove` deletes the connection's mapping with it. These commands read and write only the project database: they make no GitHub or GitLab call and record nothing in item history. They have no MCP tool; `sync mapping --help` lists the format and the local values.

## Outbox

Every item change made on this side (CLI, MCP tools, the web board, batch creates and imports) is queued in the outbox of each connection with auto-sync on, in the same transaction as the change, so the next push knows what to send. Without a connection, or with auto-sync off, nothing is queued; a connection only queues the changes made while its auto-sync is on.

`overseer sync outbox [<connection>] --json` lists the pending entries by `seq`, of one connection or of all: `[{"seq", "connection_id", "item_id", "operation", "changed_fields", "created_at"}]` (`No pending outbox entries.` and a table without `--json`). An unknown connection gives `NOT_FOUND`.

- **Operation**: `create` (also an item created by an import), `update`, `status` or `delete`. `changed_fields` names the item fields that changed; linking or unlinking an item is an update of `links` on the source item, and deleting an item also updates the `links` of the items that linked to it. A comment changes no field and queues nothing.
- **One entry per item and connection**: later changes merge into the pending entry. Changed fields are joined; the operation is `status` while only the status changed, else `update`. A pending `create` stays a `create` with `changed_fields: []`, since the push sends the whole item. A delete replaces the entry (`delete`, `changed_fields: []`); a create followed by a delete before any push leaves no entry.
- **New seq on every change**: a merged entry moves to the end with a new `seq`, so a push that read the entry before the latest change cannot acknowledge that change by mistake.
- **Imports**: changes that come from importing a connection's issues (same host and repository as `import --source --repo`) are not queued for that connection, only for the others; this includes the deletions of an import's `deleted` list, which also drop that connection's pending entry for the deleted item. Issues of a repository without a connection are queued for every connection with auto-sync on. An item imported from a connected repository is still never created on another connection: `sync plan` lists its entries there under `ack` (see [several connections](#several-connections)).

`overseer sync outbox ack <seq...> --json` removes the given entries once their push is confirmed and prints `{"acked": [<seq>, …]}`. If any seq is not pending (never existed, already acknowledged, or replaced by a later change), it gives `NOT_FOUND` naming them and removes nothing; a seq that is not a positive integer gives `INVALID_INPUT`. `sync connection remove` deletes the connection's pending entries with it.

These commands read and write only the project database: they make no GitHub or GitLab call and record nothing in item history. They have no MCP tool.

## Sync pending

When a write queues (or merges into) an outbox entry for a connection with auto-sync on whose [sync has started](#sync-start), its result names that connection: `"sync_pending": [{"connection_id", "host", "repository"}]`, sorted by `connection_id`. This holds for `create_item` (single and batch, compact or `full`), `update_item`, `delete_item`, `link_items` and `import_items`, and for the `--json` output of `add` (also `--batch`), `update`, `delete`, `link` / `unlink` and `import`. A batch, an import or a link gives one list for the whole write, not one per item. The field is omitted when nothing was queued for such a connection: no connection, auto-sync off, sync not started, or an update that only adds a comment.

overseer itself makes no network call. The `overseer` and `overseer-ship` skills run the `overseer-sync` skill's **Sync** step for the listed connections once per request of yours, after its last write. When you said not to sync, or the session lacks the host's MCP tools, they say the changes stay in the outbox; so does a failed push, and `sync status` counts them in `pending_outbox`.

## Sync start

`overseer sync start <connection> <file|-> --json` starts the sync of a connection. Use it once, right after connecting a repository; from then on the [outbox](#outbox) queues each change. The listing is the repository's issues as for [`sync plan`](#sync-plan), fetched through the connection's MCP server (every page joined); pull requests in it are not issues. What it does depends on whether the repository has issues. It prints `{"connection", "started_at", "from", "queued", "by_kind": {"requirement", "epic", "story", "task", "bug"}, "created", "linked", "warnings", "next"}`; without `--json`, a summary line, a `warning:` line per warning and a `Next:` line.

**Empty repository** (`from: "board"`): the board seeds it, so that the first sync creates an issue for every item.

- **Queue**: in one transaction, every item of every kind and status (open or closed) without a remote ref on the connection gets one pending `create` in the connection's outbox, whatever its auto-sync flag (`queued`, `by_kind`). A pending update or status entry of such an item becomes the create; a pending create stays. Items already linked to an issue there are skipped.
- **Then**: `sync plan` gives one `create` push per seeded item (a closed item's create has `issue.state: "closed"`, so the push closes the new issue), the agent runs them through the MCP server, and [`sync confirm`](#sync-confirm) links each item to its issue.

**Repository with issues** (`from: "repository"`): its issues come to the board, the items already on the board are never pushed, and its issues are never created on the other connections ([several connections](#several-connections)).

- **Issues**: in one transaction, the issues are upserted as `import` does: an issue no item has creates one (`created`), an item imported from it earlier is updated from it (`linked`), and each gets its remote ref on the connection with the snapshot of its synced fields. History records these changes via `sync:<host>`; the outbox queues them for no connection, this one or any other.
- **Labels**: each issue's labels are read through the connection's mapping, as [`sync pull`](#sync-pull) reads them: mapped labels set the kind, priority and status instead of becoming tags, so a closed issue labelled with the label mapped to `cancelled` starts `cancelled`.
- **Nothing queued**: no outbox entry is queued for existing local items (`queued: 0`), and their pending create, update and status entries on the connection are dropped. The connection records the highest item ID per kind (`sync_start_baseline`).
- **Then**: an item that existed before the start and has no issue on the connection is never pushed as a create: when it changes, `sync plan` lists its entry under `ack`. Items created after the start get a `create` push as usual, and items linked to an issue get updates.

- **Once per connection**: the connection records `sync_started_at`. Running it again gives `CONFLICT` with the start time and changes nothing.
- **Source of truth**: either way, when the board is the [source of truth](#source-of-truth), the connection becomes it in the same transaction; otherwise it stays.

It reads only the project database and the listing given: no GitHub or GitLab call. An unknown connection gives `NOT_FOUND` before the file is read. It has no MCP tool; `sync start --help` describes the listing.

### Several connections

Each repository's existing issues stay in that repository; only new board items fan out.

- **Items from a repository**: an item a connection's `sync start` created or linked, an item its [`sync pull`](#sync-pull) created, and an item imported from its repository came from that connection (its `external_ref` names the repository and it was recorded via `import:<host>` or `sync:<host>`). Another connection never gets a `create` for it, even when it changes later: its entries there come under `ack` in `sync plan`. With a GitHub and a GitLab connection both started from repositories with issues, the GitLab issues stay on GitLab and the GitHub issues on GitHub.
- **New board items**: an item created on the board after the starts is queued for and pushed to every connection with auto-sync on, then updated on each.
- **Already in both**: an item that has an issue on both connections (pushed to the other before its repository was connected) gets updates on both.
- **Removed connection**: its items no longer come from a connected repository. Like any board item, their next change gives a `create` on the other connections, except on one whose start from a repository with issues came after them.

## Sync plan

`overseer sync plan <connection> <file|-> --json` works out what a sync of one connection would do, from its pending outbox entries, its remote refs with their last synced snapshot, its mapping, the [source of truth](#source-of-truth) and a listing of its issues fetched through the connection's MCP server. It prints `{"push": [...], "pull": [...], "conflicts": [...], "ack": [...], "overwritten": [...], "warnings": [...]}`; without `--json`, a counts line, one table per non-empty part, an `ack:` line and a `warning:` line per warning. [`sync pull`](#sync-pull) applies its pull operations and [`sync confirm`](#sync-confirm) records its pushes.

- **Listing**: the raw MCP answer, as for `import`: a GitHub `list_issues` response (`{"issues": [...]}`) or an array of GitHub issues; a GitLab `list_issues` response (an array of REST issues, with descriptions: the listing the `overseer-sync` skill fetches, `scope: all`, `state: all`, every `page`), a `list_work_items` response (`{"items": [...], "pageInfo": {...}}`, no descriptions), a `get_work_item` response or an array of work items. Join the pages into one array: an issue missing from the listing is neither pulled nor checked for conflicts. Pull requests are skipped with a warning. A listing from the other host (a GitLab answer for a GitHub connection) or an unknown format gives `INVALID_INPUT`; an unknown connection gives `NOT_FOUND` before the file is read.
- **Read only, deterministic**: it writes nothing (no outbox entry is acknowledged, no remote ref or item changes, no history) and makes no network call. The same database and listing give byte-for-byte the same output, whatever order the listing has: push operations, conflicts and overwritten fields by item ID (then field), pull operations by issue (repository, then number). An issue listed twice uses the entry updated last, with a warning.
- **Synced fields**: `title`, `body` (the item's description), `labels`, `state` (`open` or `closed`), `assignee` (the first assignee) and `milestone`, always in this order. The snapshot (`item_remote_refs.synced_fields`) holds the issue's values as of the last sync; `import` writes it. A field missing from the snapshot is unknown: it is never pulled or in conflict, and a missing `state` falls back to the remote ref's state. The one exception is `body` after a listing without bodies (GitLab `list_work_items`): a listed body is then compared with the item's description, so a description edited in the repository is pulled when the item has no pending description change, and [`sync pull`](#sync-pull) makes a matching listed body the snapshot's, after which description edits on both sides are conflicts like any other field.

**The issue an item should be** comes from the item and the connection's mapping:

- `title`, `body`, `assignee` and `milestone` from the item.
- `labels`: the item's tags, minus every tag that is a mapped label of the connection (the label of an earlier kind, priority or status), plus the mapped kind, priority and status values; sorted, without repeats.
- `state`: a status mapped to `open`, `opened` or `closed` (any case) sets it. Otherwise the delivered and closed statuses (`done`, `cancelled`, `implemented`, `verified`, `rejected`, `obsolete`) close the issue and the other statuses leave it open.
- Each unmapped kind, status or priority value gives one warning naming the items pushed with it, since no label is sent for it.

**Push** operations, one per outbox entry that changes the issue: `{"op", "item_id", "seq", "external_ref", "url", "fields", "issue"}`.

| Field | Meaning |
|---|---|
| `op` | `create` when the item has no remote ref on the connection (`external_ref` and `url` null, `fields` all six; `issue.state` `closed` for a delivered or closed item, whose new issue is then closed); `close` or `reopen` when `fields` holds `state` (by the new state); `update` otherwise |
| `seq` | the outbox entry to acknowledge with `sync outbox ack` once the push is confirmed |
| `fields` | the synced fields to set. For an update: those the entry's changed fields touch (`title` → title, `description` → body, `tags`, `kind` and `priority` → labels, `status` → state and labels, `assignee`, `milestone`), minus those whose new value equals the snapshot and those in conflict that the issue wins (see **Conflicts** below). Other item fields (links, acceptance criteria, …) are not synced |
| `issue` | the whole issue as the push leaves it: `{"title", "body", "labels", "state", "assignee", "milestone"}`; a push sets only `fields`, and a field the issue won keeps the listing's value |
| `overwritten` | only when the push replaces a value changed on the issue too: `{"<field>": <the issue's value>}` per conflicting field the board or another connection won |

- A pending `create` whose item already has a remote ref on the connection (a push not acknowledged yet) updates every synced field of that issue; it never opens a second one.
- A `delete` closes the deleted item's issue: `fields: ["state"]`, `issue` with the listing's values and `state: "closed"`, or the tombstone's title and `null` body and labels when the listing lacks the issue.
- An entry that changes nothing on the issue (only unsynced fields, values the issue already has, fields the issue won as source of truth, a deleted item without an issue on the connection or with a closed one, an item gone since, an item without an issue that existed before a [sync start from a repository with issues](#sync-start) or came from another connection's repository (see [several connections](#several-connections))) needs no remote call: its `seq` is in `ack` (ascending), to acknowledge with `sync outbox ack`. It gives no warning.

**Pull** operations, one per listed issue to apply to the board: `{"op", "external_ref", "url", "item_id", "fields", "issue"}`.

- `update`: a linked issue whose `fields` differ from the snapshot, minus those the item changed locally since (pending in the outbox), unless the issue won them as source of truth. Those come with `overwritten`: `{"<field>": <the item's value>}`; applying the pull sets every field in `fields`.
- `create`: an issue no item has (`item_id` null); `fields` lists every field the listing has. Issues of locally deleted items are skipped. An issue imported before the connection existed (its item has the issue's `external_ref` but no remote ref on the connection) gives a warning instead.
- `issue`: the listing's values; `body` is `null` when the listing has no bodies (GitLab `list_work_items`; GitLab `list_issues` has them).

**Conflicts** are fields changed both locally (pending in the outbox) and remotely (the listing differs from the snapshot) to different values; when both sides now hold the same value, there is no conflict and nothing to send. The source of truth resolves each one, so `conflicts` (`{"item_id", "seq", "external_ref", "url", "field", "local", "remote", "snapshot"}`) stays empty:

- **The planned connection is the source of truth**: the issue's value wins. The field leaves the push and joins the item's pull `update`, with the item's value in its `overwritten`.
- **The board or another connection is the source of truth**: the item's value wins. The field stays in the push, with the issue's value in its `overwritten`. To keep a connection that is the source of truth ahead of the others, sync it first (see the `overseer-sync` skill).

**Overwritten**: `{"item_id", "external_ref", "field", "winner", "value", "overwritten"}`, one per resolved conflict. `winner` is `remote` (the pull applies the issue's value) or `local` (the push sends the item's value); `value` is the winning value and `overwritten` the losing one it replaces. Values are the issue's fields as the plan compares them (`labels` with the mapped kind, priority and status labels). [`sync pull`](#sync-pull) and [`sync confirm`](#sync-confirm) record each one in the item's history, and [`sync status`](#sync-status) lists those of the latest pull and confirm.

It has no MCP tool; `sync plan --help` lists the accepted listings.

## Sync pull

`overseer sync pull <connection> <file|-> --json` applies the pull operations of [`sync plan`](#sync-plan) for the same listing (the plan is computed by the same code), in one transaction. It prints `{"created": [{"item_id", "external_ref"}], "updated": [{"item_id", "external_ref", "fields"}], "conflicts": [...], "warnings": [...]}`; without `--json`, a counts line, a table of created and updated items, the conflicts table and a `warning:` line per warning.

- **Create**: an issue no item has becomes an item as `import` creates it: kind, priority and status from its labels and state (see **Labels**), title, body, the other labels as tags, first assignee, milestone, `external_ref` `<host>:<owner/repo#N>`, and its parent when the listing names a parent issue that has an item. Its remote ref on the connection gets the snapshot of every listed field.
- **Update**: only the planned `fields` change, so a field the item changed locally since the last sync (pending in the outbox) keeps its local value, unless the pulled connection is the source of truth and the plan lists it under `overwritten`: `title`, `body` → description, `labels` → tags and the fields mapped labels name (see **Labels**), `assignee`, `milestone`. When `state` or `labels` is pulled, a mapped status label that agrees with the issue's state sets the status (a pull of `labels` alone only when the item's status is already on the issue's side). Otherwise `state` closes the item (`done`, `implemented` for a requirement, `cancelled` for a GitHub issue closed as not planned or duplicate) or reopens it (`backlog`, `in_progress` with an in-progress label, `approved` for a requirement, `open` for an epic) only when its status is on the other side. The snapshot of the applied fields is refreshed with the issue's labels as listed, so a priority or status the pull sets is not pushed back to the pulled connection; other connections with auto-sync on get it as their own mapped label.
- **Labels**: a label that is a mapped kind, priority or status value of the pulled connection (see [Kind, status and priority mapping](#kind-status-and-priority-mapping)) sets that field and is not stored as a tag; every other label is a tag. A status mapped to a state (`closed`) is no label.
  - **Kind**: a mapped kind label, else the issue type, else the label keywords (`bug`, `epic`, `story`, …). An existing item's kind never changes: a mapped label naming another kind gives a warning.
  - **Priority**: a mapped priority label; without one, a new item gets `should` and an existing item keeps its priority.
  - **Status**: a mapped status label wins over the plain state when it agrees with it and the item's kind has that status: on a closed issue a delivered or closed status (a closed issue labelled with the label mapped to `cancelled` becomes `cancelled`, not `done`), on an open issue any other (`in_progress`, `review`, …). A label that disagrees with the state (`in_progress` on a closed issue) is ignored and the state decides as it would without a mapping.
  - **Several values**: when the labels name several values of one dimension, or one label is the remote value of several local values, the first in the local-value order of the mapping table wins (`must` before `could`; `done` before `cancelled`).
- **Conflicts**: the plan's conflicts are returned unchanged; neither the item nor the snapshot of those fields is touched.
- **History and outbox**: each change is an event via `sync:<host>` (`sync:github`, `sync:gitlab`). The outbox skips the pulled connection, which already holds the change, and queues it for every other connection with auto-sync on, as `import` does. A created item queues nothing: it came from this repository and stays there (see [several connections](#several-connections)).
- **Overwritten**: when the pulled connection is the source of truth, each field of the plan's `overwritten` (a local edit the issue's value replaces) also gets an `overwrite` event via `sync:<host>` after the item's update events: `field` is the synced field, `old_value` the overwritten local value and `new_value` the issue's winning value. It queues nothing. The pull's overwritten fields replace the connection's latest pull entries in [`sync status`](#sync-status).
- **Idempotent**: the same listing applied again changes nothing and records nothing. An unknown connection gives `NOT_FOUND` before the file is read; a listing of the other host or an unknown format gives `INVALID_INPUT` and writes nothing.

The `overseer-sync` skill's **Sync** step fetches every page of the listing through the connection's MCP server and runs `sync pull` before pushing. It has no MCP tool; `sync pull --help` lists the accepted listings.

## Sync confirm

`overseer sync confirm <connection> <file|-> --json` records the pushes the agent ran through the connection's MCP server for a `sync plan`. The input is a JSON array with one result per push op: `{"seqs": [<seq>, …], "item_id", "external_id": "<repository>#<number>", "url", "state": "open"|"closed", "fields": [...], "overwritten": {...}}` (`state` is case-insensitive, `opened` counts as `open`; `fields` and `overwritten` are optional). It prints `{"connection_id", "confirmed": [{"item_id", "external_id", "url", "state", "fields"}], "acked": [<seq>, …]}`; without `--json`, one line per result and a summary line.

- **All or nothing**: every result is checked first. A seq that is not pending on the connection, listed twice or of another item, an unknown item, an `external_id` of another repository or already linked to another item there, an `overwritten` field the push did not set (not in `fields`), or a malformed result gives `INVALID_INPUT` naming every problem, and nothing is written. An unknown connection gives `NOT_FOUND` before the file is read.
- **Remote ref**: the item's ref on the connection is created or updated (issue ID, URL, state, sync time). An item without an `external_ref` also gets `external_ref` (`<host>:<repository>#<number>`) and `external_url`, as an import would set. Issue references (`acme/demo#7`, `gitlab:acme/app#3`, the URL) resolve through either, so an item pushed to a GitHub and a GitLab connection is found by both.
- **Snapshot**: the snapshot gets the pushed values of `fields`, other fields keep their earlier snapshot value. The values are recomputed from the item and the connection's mapping rather than taken from the input: a seq still pending means the item has not changed since the plan, so they are the plan's `issue`; `state` is the result's. Pass the plan op's `fields`; when omitted, every synced field for an item not linked yet (or a pending create), else the fields the entries' changes touch.
- **Overwritten**: pass the plan op's `overwritten` as is (`{"<field>": <the issue's value>}`). Confirm has no listing, so this is how it knows which issue values the push replaced. Each field gets an `overwrite` event via `sync:<host>` on the item: `field`, `old_value` the issue's replaced value, `new_value` the pushed value. It queues nothing. Every confirm replaces the connection's latest confirm entries in [`sync status`](#sync-status), with none when no result has `overwritten`.
- **Outbox**: every listed seq is acknowledged. The close of a deleted item has no remote ref left: it only acknowledges.

A failed MCP call has no result: leave it out and its entry stays pending for the next sync. It has no MCP tool.

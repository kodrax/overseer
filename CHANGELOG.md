# Changelog

All notable changes to `@kodrax/overseer` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Write results (`create_item`, batch included, `update_item`, `delete_item`, `link_items`, `import_items` and their `--json` commands) carry `sync_pending: [{connection_id, host, repository}]` naming each connection with auto-sync on and a started sync that the write queued changes for, one list per write; the `overseer` and `overseer-ship` skills then run the `overseer-sync` Sync step once per request, or say the changes stay in the outbox (TASK-0023).
- Overwritten conflicting edits are recorded: `sync pull` adds an `overwrite` history event (field, the local value, the issue's) when the repository wins a conflict, `sync confirm` accepts the plan op's `overwritten` and records the issue's replaced value the same way, and `sync status` lists each connection's overwritten fields of its latest pull and confirm (TASK-0024).
- The `overseer-sync` connect flow proposes a label (name in the repository's style, colour) for each kind, status and priority left unmapped, creates the ones the user confirms through the connection's MCP server (GitHub `label_write`, gitlab-mcp `create_label`) and only then imports the mapping; without a label-creation tool, or when a creation fails, it says so and leaves those values unmapped. `integrations.md` documents the tools and permissions (TASK-0028).
- End-to-end sync tests drive the CLI against a fake GitHub and GitLab repository (`test/helpers/fake-repo.ts`) that renders raw MCP listings and applies push ops as the skill's MCP calls would: both directions, deletes, conflicts by source of truth, one item on two connections, both `sync start` cases and a settled plan after each sync; three bugs they found are marked `it.fails` (TASK-0025).

### Changed

- `overseer sync start` accepts a repository that already has issues: its issues come to the board as an import does (items created or linked, with their remote refs), nothing is queued for the existing local items, and `sync plan` never pushes a create for an item that existed before the start (its entries go to `ack`); items created later are pushed as usual. The output adds `from`, `created`, `linked` and `warnings`.
- The sync source of truth is derived instead of chosen: the board until sync starts on a connection while the board is the source of truth, then that connection until it is removed. `sync source-of-truth` shows it with a `reason`; upgrading drops a stored manual choice (TASK-0066).
- The `overseer-sync` skill asks which MCP server reaches each repository, offering the servers in the session or the host default (`github` / `gitlab`), stores it with `sync connection add|set --mcp-server`, and calls that server's tools with the harness's prefix in every connect and sync step.
- The `overseer-sync` skill starts sync after connecting and mapping: it fetches every page of the repository's issues, runs `sync start`, tells the user whether the board seeds the repository or its issues came to the board, and syncs straight away when the board seeds it (TASK-0067).

### Removed

- `overseer sync source-of-truth set`, and the `overseer-sync` skill's question asking which source of truth to use (TASK-0066).

### Fixed

- `import` of a connected repository finds an issue's item through its remote ref on that connection before its `external_ref`, so an item pushed to GitHub first is updated by an import of its GitLab repository instead of duplicated (and queued as a create for GitHub), and the `deleted` list of a GitLab issue deletes that item instead of warning that no item has the issue. The item keeps its GitHub `external_ref`; the GitLab issue's URL, state and snapshot go to its remote ref (BUG-0014).
- The `overseer-sync` skill, the README and the `sync mapping` help map kinds to labels only, as push sends them: issue types from `sync inspect` are information, never mapping targets, and a kind without a matching label gets a new label proposal (BUG-0016).
- Issues reaching the board through `sync pull`, `sync start` and `import` of a connected repository read their labels through that connection's mapping: a mapped kind, priority or status label sets the field instead of being stored as a tag (a closed issue labelled with the label mapped to `cancelled` becomes `cancelled`, a `priority: could` issue gets `could` instead of `should`), so a later push touching labels keeps the issue's priority label and one connection's mapped labels no longer reach another repository through tags. A status label counts when it agrees with the issue's state; several values go by the mapping table's order; an import without a connection is unchanged (BUG-0017, BUG-0015).
- With several connections, each repository's existing issues stay in that repository: `sync start` from a repository with issues queues nothing for any connection, a `sync pull` create queues nothing, and `sync plan` never pushes a create for an item that came from another connection's repository (start, pull or import), listing its entries under `ack`; only items created on the board fan out to every connection. Before, starting a second connection queued its issues as creates for the first, duplicating them there (BUG-0019).

## [0.2.0] - 2026-10-24

### Added

- `overseer sync start <connection> <listing>` seeds an empty GitHub or GitLab repository from the board: every item without an issue there, of any kind and status, gets one pending create in the connection's outbox, and the connection records its sync start time (`sync_started_at`, shown by `sync connections` and `sync status`) once.
- `overseer pr draft` closes the item's issue in every connected repository on the pull request's host (`Closes owner/repo#N` per repository) and names issues on the other host with `Also tracked in GitLab: <url>` instead of a closing keyword.

### Fixed

- `overseer doctor` counts a harness as installed at project scope only from its own agent file or MCP entry, so a project-scope install for Codex, Gemini CLI, Copilot CLI, Cursor or OpenCode no longer names every harness that reads the shared `.agents/skills` folder (BUG-0013).

## [0.1.1] - 2026-10-24

### Changed

- Releases are prepared in pull requests on `chore/release-X.Y.Z` branches and published by pushing the version tag on the merge commit; 0.1.1 is the first release published from CI, with npm provenance.

## [0.1.0] - 2026-10-23

First release.

### Added

- **Registry and board**: requirements (functional and non-functional), epics, user stories, tasks and bugs in a per-project SQLite database under `.overseer/`, with links (`implements`, `affects`, `depends_on`, …), history, tombstones for deleted items and coverage worked out from the linked work.
- **Duplicate checks and semantic search**: every new item is compared with existing items of the same kind, across languages; hybrid keyword and vector search with the local `Xenova/multilingual-e5-small` model and `sqlite-vec`, falling back to keyword search without them.
- **Off by default**: overseer works only in projects turned on with `overseer enable`.
- **MCP server** (`overseer mcp`): `find_similar`, `check_coverage`, `create_item` (with batches of up to 50 items), `update_item`, `get_item`, `list_items`, `search`, `link_items`, `delete_item`, `report`, `export_report`, `import_items` and `open_board`.
- **CLI** for the same operations, plus reports (summary, coverage, board, drift, lint, traceability), Markdown/JSON export, `config get`/`set` and `reindex`.
- **Web board** (`overseer board`): kanban with drag and drop, requirements table with search, item pages, coverage view and live updates, served on localhost only.
- **Installer** (`overseer install` / `uninstall`) for Claude Code, OMP, Codex CLI, Gemini CLI, GitHub Copilot CLI, Cursor and OpenCode, in user or project scope, and `overseer doctor` health checks.
- **Skills and subagent**: `overseer`, `overseer-bootstrap`, `overseer-import`, `overseer-ship` and `overseer-sync`, plus the `overseer` subagent.
- **GitHub and GitLab import**: one-way, idempotent import of issues from raw MCP responses, including closed and deleted issues and issue references (`acme/demo#7`, issue URLs) in `show` and `get_item`.
- **Ship workflow**: `overseer worktree start`/`finish`/`list` for per-item branches and worktrees, `overseer pr draft` for pull request titles and bodies, and `overseer pr opened`.
- **Sync commands (early, manual)**: repository connections, source of truth, kind/status/priority mapping, outbox, `sync plan`, `sync pull` and `sync confirm`, driven by the `overseer-sync` skill through the harness's GitHub or GitLab MCP server.

[Unreleased]: https://github.com/kodrax/overseer/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/kodrax/overseer/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/kodrax/overseer/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kodrax/overseer/releases/tag/v0.1.0

# Changelog

All notable changes to `@kodrax/overseer` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `overseer sync start <connection> <listing>` seeds an empty GitHub or GitLab repository from the board: every item without an issue there, of any kind and status, gets one pending create in the connection's outbox, and the connection records its sync start time (`sync_started_at`, shown by `sync connections` and `sync status`) once.

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

[Unreleased]: https://github.com/kodrax/overseer/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/kodrax/overseer/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kodrax/overseer/releases/tag/v0.1.0

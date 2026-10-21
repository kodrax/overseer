# overseer tools: names, CLI fallback, results

## Harness tool names

Claude Code / Codex `mcp__overseer__<tool>`; OMP `mcp__overseer_<tool>`; Gemini CLI `mcp_overseer_<tool>`;
Copilot CLI `overseer-<tool>`; OpenCode `overseer_<tool>`; Cursor lists server `overseer` and the plain tool
names in its own UI. Every tool accepts `project_dir`.

## Tool details

- `find_similar`: not needed before `create_item`, which runs it.
- `get_item`: one item (`id`) or up to 50 (`ids` → `{items}`) with coverage, links, children, history; an
  ID may be an issue reference (`owner/repo#7`, an issue URL).
- `list_items` filters: kind, status, req_type, coverage, tag, parent.
- `delete_item`: deletes an item without children, with its links; a tombstone and its history stay; the
  ID is never reused (`board.md`).
- `export_report`: README, requirements, backlog, history, json (`board.md`).

## CLI fallback

No overseer MCP tools available? Run the CLI from the project root: `overseer <cmd> --json` (or add
`--project <abs-path>`); the SKILL.md tool table gives each tool's command. Errors print
`{"error":{"code","message"}}` and exit 1. Connecting or syncing with GitHub/GitLab repositories
(`overseer sync …`) is CLI only.

Reads on a project without `.overseer/` return `{ initialized: false }`; the first write creates it.

## Results

- `create_item` (`overseer add --json`) returns `{created: true, id, title, status, verdict, candidates:
  [{id, title, similarity, match}], warnings}`; `verdict` and `candidates` come from its duplicate check
  and mean the same as in `find_similar`. A likely duplicate returns `{created: false, reason:
  "possible_duplicate", verdict: "duplicate", candidates}` and writes nothing.
- `update_item` (`overseer update --json`) returns `{id, title, status, changed_fields, warnings}`.
- Build the answer from these compact results; pass `full: true` (`--full`) only when you need other
  fields of the item.
- Batch: `create_item` with `items: [...]` instead of the item fields (`overseer add --batch <file|->`, a
  JSON array) creates up to 50 items in one transaction, all or nothing. Each entry takes the create fields
  plus an optional `key`; `parent_id` and `links[].to` take an existing ID or `"@<key>"` of another entry,
  in any order. An invalid batch writes nothing and the `INVALID_INPUT` message lists every problem as
  `items[<index>] (@<key>): …`. Each entry is checked against the board and the earlier entries; a likely
  duplicate without its own `allow_duplicate: true` writes nothing and returns `{created: false, reason:
  "possible_duplicate", duplicates: [{index, key, candidates}]}` (a candidate from the batch has `index`
  and `key`). Success returns `{created: true, items: [{key, id, title, status, verdict, candidates,
  warnings}]}`; `full: true` returns `items: [{key, item, warnings, similar}]`.

<!-- managed-by: overseer-cli -->

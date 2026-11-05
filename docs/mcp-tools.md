# MCP tools

`overseer mcp` is an [MCP](concepts.md#mcp) server over stdio. Your [harness](concepts.md#coding-agent-and-harness) starts it, and its agent calls these tools; you don't call them yourself. Each tool has a CLI command that does the same, listed in the [CLI reference](cli.md#commands).

| Tool | Purpose |
|---|---|
| `find_similar` | items similar to a text; verdict `duplicate`, `related` or `new` |
| `check_coverage` | requirements covering a text, with their [coverage](concepts.md#coverage) and implementing items |
| `create_item` / `update_item` / `get_item` / `list_items` | item lifecycle; creates and updates return compact results unless `full: true`; `create_item` takes `items` for up to 50 items in one call ([Batch create](cli.md#batch-create)) |
| `search` | hybrid search |
| `link_items` | add or remove a relation |
| `delete_item` | delete an item without children; `destructiveHint: true` |
| `report` | the six reports, as Markdown plus data |
| `export_report` | write `docs/overseer/` |
| `import_items` | idempotent GitHub/GitLab issue import (`items` or a raw MCP `payload`, optional `deleted`) |
| `open_board` | start the web board and return its URL |

## Results and errors

- **Compact results**: `create_item` and `update_item` return the same compact results as `add --json` and `update --json`, and `full: true` the whole item. [JSON output and errors](cli.md#json-output-and-errors) describes both, and [Sync pending](sync.md#sync-pending) the `sync_pending` field of write results.

- **Errors**: MCP tools answer `<CODE>: <message>` with `isError: true`; details come as a second text block `{"details": …}` and as `structuredContent.error.details`.

- **Projects that are off**: every tool answers `DISABLED` and creates nothing (see [Turning overseer on and off](getting-started.md#turning-overseer-on-and-off)).

## Which project a tool works on

One server can serve every project. Each call takes an optional `project_dir` argument; without it, the server works out the project as [How overseer finds the project](configuration.md#how-overseer-finds-the-project) describes. A call that lands outside any project answers `NO_PROJECT`, and the [skills](concepts.md#skill) tell the agent to retry with `project_dir`.

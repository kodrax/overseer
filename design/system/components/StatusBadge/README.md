# StatusBadge

A progress dot followed by the status value, for stories, tasks, bugs, epics and requirements.

**Provide** the status value as overseer stores it (`in_progress`, not "In Progress") and its fill step in `data-p`:

| `data-p` | Stories, tasks, bugs | Epics | Requirements | CLI glyph |
|---|---|---|---|---|
| `0` | `backlog` | `open` | `proposed` | ○ |
| `25` | `ready` | | `approved` | ◔ |
| `50` | `in_progress` | `in_progress` | | ◑ |
| `75` | `review` | | `implemented` | ◕ |
| `100` | `done` | `done` | `verified` | ● |
| `closed` | `cancelled` | `cancelled` | `deferred`, `rejected`, `obsolete` | – |

- The dot fills as work advances; from `in_progress` on it is drawn in `signal`. Closed states drop to `ink-faint` with a dash, never a red.
- Always show the word. The dot alone never carries the status.
- Show snake_case values verbatim in tables and on cards; they are what people type in `--status`.

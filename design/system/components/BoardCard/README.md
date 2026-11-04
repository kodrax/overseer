# BoardCard

A card on the kanban board for one story, task or bug; the column is its status, so the card does not repeat it.

**Provide** the item ID, title, and at most one relation line (`implements REQ-…` for stories and tasks, `affects REQ-…` for bugs) plus up to three tags. Place cards in an `ov-col` whose header is the status in uppercase `label` style with a count.

- Card: `surface`, 1px `line`, `radius-md`, `space-3` padding. Hover raises the edge to `line-strong`; only a dragged card gets `shadow-lift` (`is-dragging`).
- Titles wrap to two lines at most, then truncate. Titles stay in the language they were recorded in; never translate them.
- Bugs are recognisable by their ID chip alone. No colored stripes or card backgrounds per kind.
- Columns follow the status order: backlog, ready, in_progress, review, done. `cancelled` is hidden unless "Show closed" is on, matching `--all`.

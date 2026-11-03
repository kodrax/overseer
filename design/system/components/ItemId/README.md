# ItemId

The mono chip that names an item: `REQ-0001`, `EPIC-0002`, `US-0003`, `TASK-0014`, `BUG-0012`.

**Provide** the ID string exactly as overseer issues it (prefix, hyphen, four digits). Render it as `<a class="ov-id" href="…">` when it opens the item page, `<span class="ov-id">` otherwise.

- The prefix already says the kind, so kinds share one neutral chip. Only bugs differ: `ov-id--bug` (danger on `danger-soft`).
- Inside a sentence or a relation line use `ov-id--plain`: mono, no box ("implements REQ-0001").
- Never translate, lowercase or abbreviate an ID; never set it in sans.
- Never put the title inside the chip; the title follows it in `body-sm`.

# Terminal

A rendered block of overseer CLI output, for docs, the repository README and the board's empty states.

**Provide** real command output, prompt included (`$ ` in `ink-muted`, not selectable). Use the spans `ok`, `warn`, `fail`, `dim` and `id` only where the CLI itself would color.

- `sunken` ground, `line` edge, `radius-lg`, 13/20 mono. It follows the page theme; it is not always dark.
- Status words are fixed-width and uppercase: `OK  `, `WARN`, `FAIL`, padded so columns align.
- Every colored word is also a word: output must read correctly with `NO_COLOR` set or piped.
- Never fake output. If a command's real text changes, the block changes with it.

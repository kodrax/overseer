# CoverageTrack

Four segments and the coverage word: how far a requirement has travelled from untracked to verified.

**Provide** the coverage value overseer computed. Never let people set it; it is derived from linked work.

| Coverage | Filled | Text color | CLI |
|---|---|---|---|
| `untracked` | 0 | `ink-muted` | `▱▱▱▱ untracked` |
| `tracked` | 1 | `ink` | `▰▱▱▱ tracked` |
| `in_progress` | 2 | `ink` | `▰▰▱▱ in_progress` |
| `delivered` | 3 | `ink` | `▰▰▰▱ delivered` |
| `verified` | 4 | `signal-ink`, 500 | `▰▰▰▰ verified` |
| `not_applicable` | dashed | `ink-faint` | `- - - - not_applicable` |

- Filled segments are `signal`; empty ones are `sunken` with a `line-strong` edge so they read in both themes.
- Untracked is a gap, not an error: no red. Drift (done work on an open requirement) is a LintNote, not a track color.
- Use it in the Requirements table's coverage column and on item pages; on board cards it is optional.

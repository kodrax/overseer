overseer is a requirements registry and Agile board for coding agents. It is local, opt-in and traceable, and it never calls an LLM. The design follows the same temperament: quiet, exact, terminal-native. It looks like a well-kept ledger, not a dashboard.

The system covers three surfaces: the **CLI** (terminal output), the **web board** (`overseer board`, a React app on 127.0.0.1), and the **public repositories** on GitHub and GitLab (README, docs, exported reports).

## Voice

Write like the README: short declarative sentences, plain words, and an honest account of what the tool does and does not do.

- The name is always **overseer**, lowercase, even at the start of a sentence. In code: `overseer`. Never "Overseer", "OverSeer" or "the Overseer".
- Lead with the behaviour, then the reason. "Off until you turn it on." "Leaves your repository alone." "Items are never deleted; you close them with a status."
- Say what does *not* happen as clearly as what does: "overseer never calls an LLM", "nothing is pushed back to GitHub or GitLab".
- Address the reader as *you*. overseer is *it*, not *we*.
- Sentence case for headings, buttons and menu items: "New item", "Export reports", "Show closed".
- Data values stay as stored, in code style: `in_progress`, `not_applicable`, `REQ-0001`, `--allow-duplicate`. Don't prettify them into "In Progress" in tables or on cards; people type these.
- No exclamation marks, no emoji, no hype ("powerful", "seamless", "AI-powered"). The agent does the reasoning; overseer keeps the record.
- Errors name the code, then the fix: `error: DISABLED: overseer is off for this project. Run overseer enable to turn it on.`
- Text people record keeps the language they wrote it in. UI chrome is English; leave room for Spanish item text, which runs 20–30% longer than English.

## Color

Two themes from one set of semantic tokens. **Terminal** (`dark`) comes first and is the reference; **Paper** (`light`) is its daylight twin. Both are warm neutrals with one brand hue.

- Grounds: `bg` for the page, `surface` for anything raised (columns, cards, tables, dialogs), `sunken` for wells (terminal output, inputs, empty coverage segments).
- Text: `ink` for content, `ink-muted` for metadata, `ink-faint` only for placeholders and closed items. Every text token's note names the grounds it passes 4.5:1 on, in both themes.
- Lines: `line` is a decorative hairline. Any edge that marks a control or carries meaning uses `line-strong` (3:1 or more).
- **`signal`** (teal) is the brand and the one hue of progress: the primary button, the focus ring, filled coverage segments, `verified`, and `OK` in doctor output. Text in the brand hue is `signal-ink`; text on a signal fill is `on-signal`.
- **`warn`** (amber) is for lint, drift and `WARN`. **`danger`** (red-orange) is for bugs, errors and `FAIL`. Each has a `-soft` ground; text on a soft ground is `ink` or its own hue.
- Teal against red-orange keeps success and failure apart for red-green colour blindness. Even so, color never carries meaning alone: every state has its word, and every status dot has its label.
- Use one hue per view as much as possible. A healthy board is mostly neutral with a little teal; amber and red-orange should mean something is wrong.

## Type

Two families, both IBM Plex, shipped as files (`fonts/`) so the board works offline. Never load fonts from a CDN in the product; overseer is local.

- **Sans** (`IBM Plex Sans`) for reading: `h1` page titles, `h2` item titles, `h3` field groups, `body` for descriptions and EARS statements, `body-sm` for cards, tables and metadata.
- **Mono** (`IBM Plex Mono`) for anything a person might type or copy: `id` for item IDs, `code` for commands, paths, field names and status values, `terminal` for CLI output. `display` sets the name.
- `label` (11px, uppercase, tracked) is the only uppercase text: column headers and field labels.
- Weights 400, 500 and 600 only. No italics in the UI.

## Space, shape and depth

- 4px base: `space-1` 4 · `space-2` 8 · `space-3` 12 · `space-4` 16 · `space-6` 24 · `space-8` 32. Cards and table cells use `space-3`; panels `space-4`; page gutters `space-6`.
- Small radii: `radius-sm` (2px) for chips and segments, `radius-md` (4px) for buttons, inputs and cards, `radius-lg` (6px) for panels and terminal blocks. Nothing rounder; no pills.
- Borders before shadows. Resting surfaces separate with `line`. `shadow-lift` is reserved for things that float: a dragged card, a dialog, a menu.
- The board is dense by design: 13px tables, 32px controls, five kanban columns at 280px. Prefer more rows on screen over more whitespace.

## States and interaction

- Focus: `focus-ring` (= `signal`), 2px solid, offset 2px, on every interactive element, in both themes.
- Hover raises an edge from `line` to `line-strong`; it does not change the background color of cards.
- Selected rows use `signal-soft`. Disabled controls drop to `ink-faint` on `line`, and the reason sits next to them in text.
- Live updates (an agent or the CLI writing to the database) appear in place without animation beyond a 150 ms fade. No toasts for writes the person didn't make; a quiet "updated by claude" in the item's metadata is enough.
- Motion is functional only: 150 ms ease-out for fades and drags. Respect `prefers-reduced-motion`.

## The domain vocabulary

The board's visuals are built from the data model; keep them in step with it.

- **IDs** (`ItemId`): mono chips. The prefix names the kind, so all kinds share one chip; bugs alone use `danger`.
- **Status** (`StatusBadge`): a dot that fills ○ ◔ ◑ ◕ ● as work advances, then the status word. Closed states are a dash in `ink-faint`.
- **Coverage** (`CoverageTrack`): four segments filling from `tracked` to `verified`, plus the word. It is derived, never edited.
- **Duplicates** (`SimilarityHint`): verdict, score, match, next step.
- **Lint and drift** (`LintNote`): amber, beside the item, never blocking.
- **Relations** read as lowercase verbs in mono-ID sentences: "US-0003 implements REQ-0001", "BUG-0012 affects REQ-0004".

## CLI output

The terminal has no tokens; it has the user's ANSI theme. Map meaning to ANSI names, never to hex:

| Meaning | ANSI | Example |
|---|---|---|
| OK, verified, created | cyan | `OK    model  cached` |
| WARN, lint, drift | yellow | `WARN  vague term "fast"` |
| FAIL, error codes, bugs | red | `error: NO_PROJECT: …` |
| IDs, headings | bold | `REQ-0001` |
| metadata, hints, paths | dim | `(118 MB, cached)` |

- Fixed-width status words (`OK  `, `WARN`, `FAIL`) in the first column so output aligns.
- Glyphs: ○ ◔ ◑ ◕ ● – for status, ▰ ▱ for coverage, `·` as a separator, `→` for relations. No emoji, no spinners that hide output.
- Respect `NO_COLOR`, `--json` and non-TTY output: drop color and keep every word.
- Errors go to stderr as `error: <CODE>: <message>`; with `--json`, `{"error":{"code","message"}}`. Don't decorate them.

## Iconography

The symbol, wordmark and lockups are defined in `design/brand/` (construction, sizes, contrast, misuse). Use them as drawn there; don't redraw, recolor or improvise a mark.

The CLI's text glyphs above are the icon set. On the board, prefer those same glyphs and words over pictograms. If the board needs UI icons (search, filter, close, drag handle), use one outline set at 16px with a 1.5px stroke, in `ink-muted`, and record the choice here.

## Repository surfaces (GitHub and GitLab)

- README header: the horizontal lockup of `design/brand/` (Surfaces, "README header"), `docs/assets/logo-paper.png` and `logo-terminal.png` swapped with `<picture>` and `prefers-color-scheme`, then the one-line description.
- Code blocks show real commands and real output. Screenshots of the board use the Terminal theme at 1280px wide, with sample data from the README (Ana, password reset, the Safari login bug), never real client data.
- Diagrams: npm renders no Mermaid, so each `docs/assets/<name>.mmd` is rendered to a Paper and a Terminal PNG (`node scripts/render-diagrams.mjs`), swapped with `<picture>` and `prefers-color-scheme`, Terminal as the fallback.
- Exported reports in `docs/overseer/` are plain Markdown: IDs in backticks, statuses verbatim, coverage as the words (optionally with ▰▱), so they read the same on GitHub, GitLab and in a terminal.
- The social preview image (1280×640), when made, uses the cover composition: the name in Plex Mono with the teal, ink and amber blocks.

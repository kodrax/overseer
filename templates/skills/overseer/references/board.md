# overseer board: coverage, planning, delivery, reports

## Is X covered?

Call `check_coverage` with the user's phrasing. Answer in plain language, citing IDs:

| `verdict` | Meaning |
|---|---|
| `covered` | A matching requirement exists (best match ≥ duplicate threshold) |
| `partially` | Only related requirements exist; explain the gap |
| `not_found` | Nothing similar; offer to record it |
| `unknown` | Semantic search unavailable; judge the keyword hits yourself |

Per requirement `coverage`: `untracked` (recorded, no work planned) · `tracked` (in backlog or has
implementing items) · `in_progress` (work in progress/review) · `delivered` (implemented, or all work
done) · `verified` · `not_applicable` (deferred/rejected/obsolete). Mention `implemented_by` items.

## Plan & manage the board

- Epic (`kind: epic`, statuses open → in_progress → done/cancelled) groups stories.
- Story: INVEST, description "As a <role> I want <goal> so that <benefit>" /
  "Como <rol> quiero <objetivo> para <beneficio>"; `parent_id` = epic; add Given/When/Then AC;
  `links: [{rel: implements, to: REQ-…}]` (this puts the requirement in the backlog).
- Task: one pull request of work; `parent_id` = story; may also `implements` a requirement. A step
  smaller than a PR (a one-line change, a rename, a doc line) is not a task: add it as an acceptance
  criterion of the related task.
- Bug: `bug_details {steps[], expected, actual, environment?}`, `severity`
  (critical/major/minor/trivial), optional `parent_id` (epic/story), link `affects` → requirement/story.
- Work-item statuses: backlog → ready → in_progress → review → done (or cancelled).
  `estimate` = story points, `milestone` = sprint/release, `assignee`.
- Other relations: `depends_on`, `relates_to` (any), `duplicates` (same kind),
  `refines` / `conflicts_with` / `supersedes` (requirement → requirement).
- Grooming: `report board`, `report lint`, `list_items` with `coverage: [untracked]` for unplanned requirements.

## After implementing

1. Move the work items to `review` / `done` with `update_item` (`comment` with a short note).
2. Set `delivered_in` (release, PR URL or commit) and `code_refs` (paths of code/tests).
3. Set the requirement to `implemented` (or `verified` once its verification method passed).
4. Run `report drift` and resolve each finding (drift rules below).

## Reports, export, board

- `report` kinds: `summary`, `coverage`, `board`, `drift`, `lint`, `traceability`; show the markdown.
- `export_report` writes `docs/overseer/` by default (`README.md`, `requirements.md`, `backlog.md`,
  `history.md`, `overseer.json`). Only export when asked; suggest committing the folder — it is the only
  way overseer history reaches the repository.
- `open_board` starts the local web board (kanban, requirements, coverage) and returns its URL; give it
  to the user.

## Deleting

Close items with `cancelled`, `rejected` or `obsolete`; call `delete_item` (`overseer delete <id>`) only
when the user asks. It removes an item without children and its links (an item with children answers
`CONFLICT` listing them); a tombstone keeps its ID, kind, title, external refs, `deleted_at` and actor, its
events stay in the history, the ID is never reused, and reading it answers `NOT_FOUND` with the deletion
time.

## Statuses (first = default; any → any within the kind)

| Kind | Statuses | Closed (hidden unless `include_closed` / `--all`) | Delivered |
|---|---|---|---|
| requirement | proposed, approved, implemented, verified, deferred, rejected, obsolete | rejected, obsolete | implemented, verified |
| epic | open, in_progress, done, cancelled | cancelled | done |
| story / task / bug | backlog, ready, in_progress, review, done, cancelled | cancelled | done |

## Read-only fields

| Field | Kinds | Notes |
|---|---|---|
| `id` | all | Immutable. `REQ-0001`, `EPIC-0001`, `US-0001`, `TASK-0001`, `BUG-0001` |
| `kind` | all | Immutable: `requirement`, `epic`, `story`, `task`, `bug` |
| `recorded_via` | all | Auto: MCP client name, `cli`, `web`, `import:github\|gitlab` |
| `in_backlog` | all | Boolean; auto-set when an `implements` link targets the requirement |
| `external_ref`, `external_url`, `external_state`, `external_synced_at` | imports | `github:owner/repo#12` |
| `delivered_at` | all | Auto when entering a delivered status; cleared when leaving it |
| `created_at`, `updated_at`, `status_changed_at` | all | Auto, ISO-8601 with offset |
| `coverage` | requirement | Derived at read time (below) |

## Coverage (requirements; W = non-cancelled items that `implements` it)

1. status deferred/rejected/obsolete → `not_applicable`
2. status verified → `verified`
3. status implemented → `delivered`
4. W non-empty and all done → `delivered`
5. any W in in_progress/review → `in_progress`
6. W non-empty or `in_backlog` → `tracked`
7. otherwise → `untracked`

## Drift rules (`report drift`)

- `work_done_status_open`: all W done, requirement still proposed/approved → move it to implemented.
- `status_ahead_of_work`: requirement implemented/verified but some W not done.
- `unapproved_in_progress`: requirement proposed while some W is in_progress/review/done (ask for approval).

## Lint rules (warnings on create/update of requirements and stories; never block)

| Rule | Severity | Trigger |
|---|---|---|
| `vague_term` | warn | fast, easy, user-friendly, robust, scalable, etc., and/or, TBD, rápido, fácil, intuitivo… |
| `multiple_requirements` | warn | more than one shall/must/debe/deberá in the description |
| `nfr_not_measurable` | warn | non_functional without `fit_criterion` and no digit in description |
| `nfr_category_missing` | warn | non_functional without `nfr_category` |
| `missing_acceptance_criteria` | warn | requirement not proposed, or story not backlog, with empty AC |
| `story_format` | info | story not "As a … I want … so that …" / "Como … quiero … para …" |
| `title_too_long` | warn | title > 100 chars |

<!-- managed-by: overseer-cli -->

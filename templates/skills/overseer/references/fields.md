# overseer field dictionary

## Item fields

| Field | Kinds | Notes |
|---|---|---|
| `id` | all | Immutable. `REQ-0001`, `EPIC-0001`, `US-0001`, `TASK-0001`, `BUG-0001` |
| `kind` | all | Immutable: `requirement`, `epic`, `story`, `task`, `bug` |
| `title` | all | Required, ≤100 chars, scannable |
| `description` | all | Requirement: one EARS statement. Story: "As a … I want … so that …" |
| `status` | all | See statuses below; default = first status of the kind |
| `priority` | all | MoSCoW `must` / `should` (default) / `could` / `wont` |
| `req_type` | requirement (required) | `functional` / `non_functional` |
| `nfr_category` | requirement | ISO/IEC 25010:2023 category (see `nfr-iso25010.md`) |
| `fit_criterion` | requirement | Measurable target, e.g. "p95 < 300 ms at 100 rps" |
| `verification_method` | requirement | `test` / `inspection` / `analysis` / `demonstration` |
| `rationale` | all | Why it exists |
| `acceptance_criteria` | all | Array of strings, Given/When/Then |
| `asked_by` | all | Requester (person/role). Default: project `default_asked_by`; imports: null |
| `source` | all | Provenance: `conversation <date> (<harness>)`, file path, meeting, URL |
| `recorded_via` | all | Auto: MCP client name, `cli`, `web`, `import:github\|gitlab` |
| `in_backlog` | all | Boolean; auto-set when an `implements` link targets the requirement |
| `parent_id` | see parent rules | |
| `assignee`, `milestone` | all | Owner; sprint/release |
| `estimate` | story, task, bug | Story points |
| `severity` | bug | `critical` / `major` / `minor` / `trivial` |
| `bug_details` | bug | `{steps: string[], expected, actual, environment?}` |
| `component`, `tags` | all | Grouping; `tags` is a string array |
| `code_refs` | all | String array of code/test paths |
| `external_ref`, `external_url`, `external_state`, `external_synced_at` | imports | `github:owner/repo#12` |
| `delivered_at` | all | Auto when entering a delivered status; cleared when leaving it |
| `delivered_in` | all | Release, PR or commit |
| `created_at`, `updated_at`, `status_changed_at` | all | Auto, ISO-8601 with offset |
| `coverage` | requirement | Derived at read time (below) |

Using a kind-specific field on another kind → `INVALID_INPUT`. Close items with `cancelled`, `rejected`
or `obsolete`. `delete_item` (`overseer delete <id>`) removes an item without children and its links; a
tombstone keeps its ID, kind, title, external refs, `deleted_at` and actor, its events stay in the history,
the ID is never reused, and reading it answers `NOT_FOUND` with the deletion time.

## Statuses (first = default; any → any within the kind)

| Kind | Statuses | Closed (hidden unless `include_closed` / `--all`) | Delivered |
|---|---|---|---|
| requirement | proposed, approved, implemented, verified, deferred, rejected, obsolete | rejected, obsolete | implemented, verified |
| epic | open, in_progress, done, cancelled | cancelled | done |
| story / task / bug | backlog, ready, in_progress, review, done, cancelled | cancelled | done |

## Parent rules (`INVALID_PARENT` otherwise)

story → epic · task → story · bug → epic or story (optional) · requirement → requirement (decomposition) · epic → none.

## Relations (`INVALID_LINK` on kind mismatch or self-link)

| rel | from → to |
|---|---|
| `implements` | story/task → requirement (sets requirement `in_backlog`) |
| `affects` | bug → requirement/story |
| `refines`, `conflicts_with`, `supersedes` | requirement → requirement |
| `duplicates` | same kind |
| `depends_on`, `relates_to` | any → any |

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
- `unapproved_in_progress`: requirement proposed while some W is in_progress/review/done.

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

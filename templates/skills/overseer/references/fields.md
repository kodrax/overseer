# overseer field dictionary

Fields you set. Read-only fields, statuses, coverage, drift and lint: `board.md`.

| Field | Kinds | Notes |
|---|---|---|
| `title` | all | Required, ≤100 chars, scannable |
| `description` | all | Requirement: one EARS statement. Story: "As a … I want … so that …" |
| `status` | all | Default = first status of the kind (`board.md`) |
| `priority` | all | MoSCoW `must` / `should` (default) / `could` / `wont` |
| `req_type` | requirement (required) | `functional` / `non_functional` |
| `nfr_category` | requirement | ISO/IEC 25010:2023 category (see `nfr-iso25010.md`) |
| `fit_criterion` | requirement | Measurable target, e.g. "p95 < 300 ms at 100 rps" |
| `verification_method` | requirement | `test` / `inspection` / `analysis` / `demonstration` |
| `rationale` | all | Why it exists |
| `acceptance_criteria` | all | Array of strings, Given/When/Then |
| `asked_by` | all | Requester (person/role). Default: project `default_asked_by`; imports: null |
| `source` | all | Provenance: `conversation <date> (<harness>)`, file path, meeting, URL |
| `parent_id` | see parent rules | |
| `assignee`, `milestone` | all | Owner; sprint/release |
| `estimate` | story, task, bug | Story points |
| `severity` | bug | `critical` / `major` / `minor` / `trivial` |
| `bug_details` | bug | `{steps: string[], expected, actual, environment?}` |
| `component`, `tags` | all | Grouping; `tags` is a string array |
| `code_refs` | all | String array of code/test paths |
| `delivered_in` | all | Release, PR or commit |

Using a kind-specific field on another kind → `INVALID_INPUT`.

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

<!-- managed-by: overseer-cli -->

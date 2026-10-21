---
name: overseer-bootstrap
description: Build or refresh the overseer requirements registry from an existing codebase and docs, or elicit initial requirements for a new project with a short interview. Use when starting overseer on a project or when asked to discover or reverse-engineer requirements.
---

# overseer-bootstrap

Uses the `overseer` skill's tools and rules (`create_item` runs the duplicate check, one requirement per
item, EARS statements, user's language). Never modify project files; only read them.

## 1. Check the current state

Run `report summary`. If it answers `DISABLED`, overseer is off for this project (the default): ask the
user to run `overseer enable` there, or run it yourself only when they tell you to, then continue. If
requirements already exist, this is a refresh: dedupe against them and update instead of duplicating.

## 2a. Existing project — discover

Inventory, reading only what is needed:
- `README*`, `docs/`, ADRs, CHANGELOG, product notes.
- API specs and routes (OpenAPI, GraphQL schemas, router/controller files), CLI commands.
- UI pages/screens and navigation; i18n files for feature names.
- Test names (`describe`/`it`, test files) — they often state behaviour verbatim.
- Config limits: timeouts, rate limits, quotas, retention, auth/roles, password policy, CORS.
- CI/CD: supported platforms, quality gates, deployment targets.

For each behaviour found:
- Present in code → requirement with `status: implemented`, `tags: ["discovered"]`,
  `asked_by: "(discovered)"`, `source: "discovered: <path>"`, `code_refs: [<paths>]`.
- Documented but absent from code → `status: proposed`, same tags/asked_by, `source` = the doc path.
- Limits and qualities (timeouts, auth, availability) → `non_functional` with `nfr_category` and the
  observed value as `fit_criterion`.
- Work in batches grouped by area (`component`): one `create_item` `{items}` call per area, no
  `find_similar` first; keep each requirement atomic. On `possible_duplicate`, update each flagged
  existing item (add `code_refs`) and resend the batch once without those entries.

## 2b. New project — interview

Ask briefly, one group at a time, and stop when the user wants:
1. Vision: problem, target outcome, what is out of scope.
2. Users and roles; who approves requirements (`asked_by`).
3. Top 3–5 user journeys.
4. Constraints: platforms, integrations, deadlines, compliance, budget.
5. NFR checklist, one prompt per ISO 25010 category (`overseer/references/nfr-iso25010.md`).

Record dictated requirements as `approved`, your own suggestions as `proposed`. Then propose epics
(one per journey/area) and INVEST stories with `implements` links to the requirements; create them
after the user agrees.

## 3. Finish

Show a batch summary for confirmation: table `ID | Title | Type | Status | Source`, items updated
instead of created, discovered gaps (documented but not implemented), and open questions. Offer
`report coverage` and, if asked, `export_report`.

<!-- managed-by: overseer-cli -->

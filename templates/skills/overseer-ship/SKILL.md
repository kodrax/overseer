---
name: overseer-ship
description: Ship one board item end to end. Resolves a board ID, a GitHub/GitLab issue or a free-text request to a task or bug, creates its git worktree and branch, implements it against the acceptance criteria, opens the pull request from overseer's draft and closes the item after the merge. Use when asked to ship, implement, deliver or finish TASK-…, BUG-…, an issue such as #42, or an ad-hoc change.
---

# overseer-ship

Drives one task or bug from the board to a merged pull request: one item, one worktree, one branch,
one pull request. Uses the `overseer` skill's tools and rules (find_similar before every create, the
user's language, report every ID and status you change; `DISABLED` → stop). The `overseer worktree`,
`overseer pr` and `overseer config` commands are CLI only; run them with `--json` from the project root
or from the worktree (board lookups from a worktree resolve to the main checkout). Never merge the pull
request yourself.

## 1. Resolve the item

- **Board ID** (`TASK-0012`, `BUG-0003`) → `get_item`. Read the parent, the linked requirements
  (`implements`, `affects`) with their acceptance criteria, and the `depends_on` items before coding.
  - `done` or `cancelled` → tell the user and stop unless they insist.
  - A story, epic or requirement → propose a task under it (`parent_id` = the story,
    `implements` = the requirement) and ship that task once the user agrees.
  - No acceptance criteria → derive Given/When/Then criteria from the description and the linked
    requirements, show them, and record them with `update_item` after the user agrees.
- **Issue reference** (`#42`, `owner/repo#42`, an issue URL) → import that one issue with the
  `overseer-import` steps (`import_items` with a single item). The ID in `created`, `updated` or
  `unchanged` is the board item; continue as for a board ID.
- **Free text** → a bug when it reports broken behaviour, otherwise a task.
  1. `find_similar` with the request text and `kind: task` or `bug`:
     - `duplicate` → show the match and ask; reusing it is the default.
     - `related` → mention the matches; use a matching story as `parent_id`.
  2. `check_coverage` with the request; a matching requirement becomes an `implements` link.
  3. `create_item` before any coding, with title, description, Given/When/Then
     `acceptance_criteria`, `priority`, `component`, `parent_id`, `links`, and `asked_by` / `source` as
     the `overseer` skill says. Bugs also get `severity` and
     `bug_details {steps[], expected, actual, environment?}`; ask for the steps if the request lacks them.
  4. Show the new ID and its acceptance criteria to the user.
- **Connected repositories**: only when the project has a repository connection with auto-sync on,
  push the new item to each connected repository through that connection's MCP server and record the
  issue reference on the item before step 3. No connection, or auto-sync off → skip this step; never
  create issues on your own.

## 2. Worktree settings (first run)

`overseer config get --stored --json` prints only the settings stored in this project. If
`worktree_root`, `base_branch` or `branch_pattern` is missing there, this is the first run:

1. Read each value in effect with `overseer config get <key> --json`.
2. Propose them to the user and agree each one:

   | Key | Meaning | Default |
   |---|---|---|
   | `worktree_root` | Folder holding one worktree per item, relative to the project root | `../<project folder>.worktrees` |
   | `base_branch` | Branch new work starts from and pull requests target | the remote's default branch |
   | `branch_pattern` | Branch name; placeholders `{type}`, `{id}`, `{slug}`; must contain `{id}` | `{type}/{id}-{slug}` |

3. Store all three with `overseer config set <key> <value>`, defaults included, so later runs ask
   nothing.

Agree the **branch type** on the first run and confirm it for each item: a Conventional Commits type
(`feat`, `fix`, `docs`, `test`, `ci`, `refactor`, `perf`, `build`, `chore`). Bugs always use `fix`;
tasks default to `feat`. Follow the project's CONTRIBUTING file when it defines the types.

## 3. Start the worktree

```sh
overseer worktree start <ID> --type <T> [--slug <S>] [--base <B>] --json
# → {"path": "…", "branch": "…", "base": "…", "reused": false}
```

- `--slug`: only to override overseer's slug (two to four lowercase words with hyphens).
- `--base`: when the item `depends_on` an item that is not merged yet, ask whether to start from that
  item's branch; the pull request then targets that branch. Otherwise omit it (`base_branch` applies).
- `reused: true` → work already exists. Read `git -C <path> status` and `git -C <path> log <base>..HEAD`
  and continue from there instead of starting over.
- `update_item`: `status: in_progress`, `comment` with the branch name.
- From now on, edit files and run commands only inside `path`. Never edit the main checkout.

## 4. Implement and check

1. Read the project's conventions first: CONTRIBUTING, AGENTS.md or CLAUDE.md, the README's
   development section and the CI workflow.
2. Implement against each acceptance criterion. Add or update tests for changed behaviour; update the
   README and docs where commands or behaviour change.
3. Run the checks CI runs (typecheck, lint, tests, build) and fix every failure. Then run the changed
   command or scenario and look at the output. Note each command and its result for the pull request.
4. A criterion you cannot meet, or a needed change outside the item's scope → tell the user before
   opening the pull request.

## 5. Commit, push, pull request

1. Commit following the project's conventions and push: `git -C <path> push -u origin <branch>`.
2. `overseer pr draft <ID> --type <T> --json` → `{title, body}`. Fill what only you know: what
   changed, how it was verified (the real commands and results from step 4) and the risk. Keep the
   template's headings; tick checklist boxes only when they are true.
3. Show the title and body to the user, apply their edits and show the result again until they
   approve. Never create the pull request before that.
4. Create it from `branch` against `base`:
   - GitHub with `gh`: `gh pr create --base <base> --head <branch> --title "<title>" --body-file <file>`
     (write the body to a file outside the worktree, or pass `--body-file -` and the body on stdin).
   - GitHub MCP server: `create_pull_request` (`owner`, `repo`, `title`, `body`, `head`, `base`).
   - GitLab MCP server: `create_merge_request` (`project_id`, `title`, `description`,
     `source_branch`, `target_branch`).
   - Add `--draft` / `draft: true` when the user asks for a draft.
5. `update_item`: `status: review`, `delivered_in` = the pull request URL, `code_refs` = the changed
   paths (`git -C <path> diff --name-only <base>...HEAD`), `comment` with the pull request URL.
6. `report drift` and resolve every finding for this item or its requirements, as in the `overseer`
   skill's "After implementing".
7. Report the item ID, its status, the branch, the worktree path and the pull request URL.

## 6. After the merge

Run when the user says the pull request is merged, or asks to finish or clean up the item.

1. Confirm the merge and read the pull request's head commit:
   - `gh pr view <url> --json state,headRefOid` → `state` must be `MERGED`; the SHA is `headRefOid`.
   - GitHub MCP server: `pull_request_read` (`method: get`) → `merged: true`, `head.sha`.
   - GitLab MCP server: `get_merge_request` (`url`) → `state: merged`, `sha`.
   - Not merged → stop; nothing is removed.
2. `overseer worktree finish <ID> --merged-head <sha> --json`. It removes the worktree and the branch,
   fast-forwards the base branch and sets the item `done` with `delivered_in` and `code_refs`. If it
   refuses (uncommitted changes, or commits missing from the merged head), show the user what would be
   lost and stop; never force it.
3. Set the linked requirements to `implemented` once all their work is done, run `report drift`, and
   report the IDs and statuses.

<!-- managed-by: overseer-cli -->

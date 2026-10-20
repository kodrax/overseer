# Contributing

Work is planned on the overseer board: every change belongs to a task (`TASK-…`) or a bug (`BUG-…`). One item gets one branch, one pull request and one squash commit on `main`.

## Workflow

1. Pick a task or bug and create a worktree on its branch:

   ```sh
   overseer worktree start TASK-0032 --slug ship-skill --json
   ```

   It fetches `origin`, creates `feat/TASK-0032-ship-skill` from `origin/main` in `../overseer.worktrees/TASK-0032-ship-skill`, runs `npm ci` there, moves the item to in_progress and prints the path. Without overseer, use git directly:

   ```sh
   git fetch origin
   git worktree add --no-track -b feat/TASK-0032-ship-skill ../overseer.worktrees/TASK-0032-ship-skill origin/main
   cd ../overseer.worktrees/TASK-0032-ship-skill && npm ci
   ```

2. Commit as often as you like. The pull request is squash-merged, so its title becomes the commit on `main`.
3. Push and open a pull request. The template asks for the item, why, what changed, how it was verified and the risk. Then, from the worktree, record it on the board: `overseer pr opened --url <url>` sets the item to review with the pull request URL and the changed files.
4. CI must pass: `check (node …)` (typecheck, tests, build) and `conventions` (branch name and title).
5. After the merge, clean up with the pull request's head commit: `overseer worktree finish TASK-0032 --merged-head <sha> --pr <url>`. It refuses when uncommitted changes or unmerged commits would be lost, then removes the worktree and the branches, fast-forwards `main`, sets the item done and sets its story done once all the story's tasks and bugs are done or cancelled. Without overseer: `git worktree remove ../overseer.worktrees/TASK-0032-ship-skill && git branch -D feat/TASK-0032-ship-skill`.

If a task needs another task that is not merged yet, branch from that task's branch and set it as the pull request's base.

## Branch names

`<type>/<item-ID>-<slug>`: a type from the table, the board item ID, and a short lowercase slug with hyphens.

| Type | Use for | Example |
|---|---|---|
| `feat` | New behaviour | `feat/TASK-0032-ship-skill` |
| `fix` | Bug fixes (every `BUG-…` item) | `fix/BUG-0010-node-minimum` |
| `docs` | Documentation only | `docs/TASK-0006-readme-gaps` |
| `test` | Tests only | `test/TASK-0002-board-spa` |
| `ci` | CI workflows and repository automation | `ci/TASK-0054-ci-workflow` |
| `refactor` | Code changes without behaviour change | `refactor/TASK-0123-split-service` |
| `perf` | Performance work | `perf/TASK-0124-faster-similar` |
| `build` | Build setup and dependencies | `build/TASK-0125-bump-tsdown` |
| `chore` | Anything else | `chore/TASK-0126-tidy-scripts` |

Dependabot and Renovate branches are exempt.

## Pull request titles

`<type>: <summary> (<item-ID>)`, following [Conventional Commits](https://www.conventionalcommits.org/). The type and item ID must match the branch. An optional scope and `!` for breaking changes are allowed: `feat(cli)!: rename the --json output fields (TASK-0123)`.

Check a name and title before pushing:

```sh
.github/scripts/check-conventions.sh feat/TASK-0032-ship-skill "feat: add the ship skill (TASK-0032)"
```

## Development

Setup, test and build commands are in the README's [Development](README.md#development) section.

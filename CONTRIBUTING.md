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

Release pull requests are the one exception to the item ID: the branch is `chore/release-X.Y.Z` (SemVer, optionally with a pre-release such as `0.2.0-rc.1`) and the title is exactly `chore: release X.Y.Z` with the same version, without an item ID. See [Releasing](#releasing).

## Pull request titles

`<type>: <summary> (<item-ID>)`, following [Conventional Commits](https://www.conventionalcommits.org/). The type and item ID must match the branch. An optional scope and `!` for breaking changes are allowed: `feat(cli)!: rename the --json output fields (TASK-0123)`.

Check a name and title before pushing:

```sh
.github/scripts/check-conventions.sh feat/TASK-0032-ship-skill "feat: add the ship skill (TASK-0032)"
```

## Development

Setup, test and build commands are in the README's [Development](README.md#development) section.

## Releasing

overseer is published to npm as [`@kodrax/overseer`](https://www.npmjs.com/package/@kodrax/overseer). Pushing a `v*` tag runs `.github/workflows/publish.yml`, which checks that the tag is `v` plus the `package.json` version, runs `npm ci`, the typecheck, the tests and the build, and runs `npm publish`. It authenticates with npm trusted publishing (OIDC), so the repository holds no npm token, and npm adds provenance automatically.

### One-time setup

1. 0.1.0 was published by hand from `main` (commit `dcc4951`) on 2026-10-23 by an owner of the `kodrax` npm organization with two-factor authentication on: `npm ci && npm run build && npm publish --access public`. A trusted publisher can only be added to a package that exists.
2. On npmjs.com, open `@kodrax/overseer` → Settings → Trusted Publisher → GitHub Actions and enter organization `kodrax`, repository `overseer`, workflow filename `publish.yml` (no environment), allowing `npm publish`.
3. Validate the configuration within 48 hours with a publish from CI (the next release below); otherwise it expires. An expired configuration can simply be deleted and added again.

### Each release

`main` is protected, so a release goes through a pull request and the tag is pushed afterwards on the merge commit.

1. On an up-to-date `main` (`git switch main && git pull --ff-only`), create the branch `chore/release-X.Y.Z`.
2. Choose the version with [SemVer](https://semver.org/) from the changes since the previous release, `git log vPREV..origin/main --oneline`: a patch release for fixes only; a minor release when there is any `feat` or, below 1.0, any breaking change; from 1.0 on, a major release for breaking changes.
3. Bump the version without a commit or tag: `npm version X.Y.Z --no-git-tag-version`. It updates `package.json` and `package-lock.json`.
4. Move the `[Unreleased]` entries in `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD` heading, leave `## [Unreleased]` empty and update the compare links at the bottom.
5. Commit, push and open a pull request titled `chore: release X.Y.Z`.
6. After the squash merge, tag the merge commit and push only the tag:

   ```sh
   git fetch origin && git tag vX.Y.Z origin/main && git push origin vX.Y.Z
   ```

7. Watch the Publish workflow in GitHub Actions. A tag that does not match `package.json` fails before anything is published; delete the tag (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`) and tag the right commit again.

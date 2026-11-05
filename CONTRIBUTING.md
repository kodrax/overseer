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

To build from a checkout of this repository:

```sh
npm install
npm link                  # after `npm run build`: puts this checkout's `overseer` on your PATH (or: npm install -g .)
npm run typecheck
npm test                  # vitest; a deterministic hash embedder, no model download; SPA tests in jsdom
npm run build             # tsdown → dist/cli.js, vite → dist/web/
node scripts/smoke-pack.mjs   # after build: pack, install the tarball in a temp prefix and HOME, run --version, install, doctor, mcp, board
npm run dev:web           # SPA dev server; proxies /api to `overseer board` on 4477
OVERSEER_REAL_MODEL=1 npx vitest run test/real-model.test.ts   # duplicate detection with the real model
npm run calibrate         # suggested similarity thresholds; regenerates src/core/reference-means.ts
OVERSEER_UPDATE_GOLDEN=1 npx vitest run test/install.test.ts   # regenerate installer golden files
npm run measure:capture -- --out docs/measurements/capture-<label> [--live]   # capture calls, CLI latency, tokens
```

`npm ci` (its `prepare` script) points `core.hooksPath` at `.githooks/`. The hooks run `scripts/ensure-build.mjs` after `git pull`/`git merge` (including the fast-forward in `overseer worktree finish`), branch switches and rebases: it hashes the build inputs (files under `src/` and `web/`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsdown.config.ts`, `vite.config.ts`), compares the hash with `dist/.build-hash` and runs `npm run build` when they differ, so the global `overseer` command runs the merged code. `npm run build` records the hash itself (`postbuild`). In a checkout without `node_modules` the hooks skip the build with a message. Run `node scripts/ensure-build.mjs` to check by hand.

`npm run measure:capture` records the fixed 20-item dictation in a temp project seeded with 300 items, the way the `overseer` skill prescribes, and writes `<prefix>.json` and `<prefix>.md`: overseer calls, CLI latency p50/p95 per command, and the tokens of the skill, subagent prompt, references and MCP tool definitions. `--live` also sends the dictation 3 times to `omp -p --mode json` in throwaway repositories and records tool calls and tokens; it spends model tokens. It is not part of `npm test`. Any label other than `baseline` adds a table against the committed baseline and a verdict on REQ-0254's fit criterion. The baseline (per-item flow) is in [docs/measurements/capture-baseline.md](docs/measurements/capture-baseline.md), the repeat after the batch capture flow in [docs/measurements/capture-after.md](docs/measurements/capture-after.md).

| Path | Contents |
|---|---|
| `src/core/` | `OverseerService`, database and migrations, search and embeddings, coverage, lint, reports, export, import, repository connections |
| `src/mcp/` | MCP server |
| `src/cli/` | CLI |
| `src/board/`, `web/` | board server and React app |
| `src/install/` | harness installer and doctor checks |
| `templates/` | skills and the subagent prompt that `install` copies |
| `scripts/` | build check, git hooks, `measure-capture.mjs` |
| `docs/measurements/` | committed measurement results |
| `test/` | test suites and fixtures; `test/web/` tests the React app in jsdom with Testing Library against a stubbed `/api` |

### README and docs

The README is the page GitHub and npm show: the brand header, what overseer is, install, a first run and links to `docs/`, in at most 150 lines. Everything else lives in `docs/`, indexed by [`docs/README.md`](docs/README.md): a Start here path (getting started, concepts, web board, each page linking to the next) and the reference pages. npm ships only `dist` and `templates`, so every link in the README is an absolute `https://github.com/kodrax/overseer/blob/main/...` URL; links between pages in `docs/` are relative. A page that first uses a term from [`docs/concepts.md`](docs/concepts.md) (harness, MCP, skill, subagent, EARS, coverage) links to it, and commands with output shown in the docs are real runs.

The README and the docs show only PNGs, linked by absolute `raw.githubusercontent.com/kodrax/overseer/main/docs/assets/...` URLs: npm renders no Mermaid, cannot resolve relative paths, and raw.githubusercontent.com serves SVG as `text/plain`, which browsers refuse in `<img>`. A new or changed image therefore shows only once it is on `main`. `scripts/smoke-pack.mjs` fails on a Mermaid block, a relative image path (`<img src>`, `<source srcset>`, Markdown images) or a relative link in the packed README. Regenerate an image after changing its source and commit both:

| Image | Source | Command |
|---|---|---|
| `docs/assets/logo-{paper,terminal}.{svg,png}` | the horizontal lockup of `design/brand/` (Surfaces, "README header"), wordmark outlined from `design/system/fonts/IBMPlexMono-600.woff2` | `python3 scripts/render-logos.py` |
| `docs/assets/<name>-{paper,terminal}.png` | `docs/assets/<name>.mmd`, colours in `docs/assets/mermaid-{paper,terminal}.json` (from `design/system/tokens.json`) | `node scripts/render-diagrams.mjs` |
| `docs/assets/board-terminal.png` | the board after `npm run build`, 1280 px wide, Terminal theme, seeded with the sample data of the docs only | `node scripts/screenshot-board.mjs` |

- **Python**: `render-logos.py` and `render-diagrams.mjs` need fontTools with brotli, e.g. `python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools brotli`, then run `/tmp/ft/bin/python scripts/render-logos.py` and `PYTHON=/tmp/ft/bin/python node scripts/render-diagrams.mjs`.
- **Chrome**: `render-logos.py` and `screenshot-board.mjs` run headless Chrome (`CHROME`, default `google-chrome`). `render-diagrams.mjs` runs `@mermaid-js/mermaid-cli` through `npx`; if Puppeteer cannot find its Chromium, point it at an installed Chrome with `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome`.
- **Light and dark**: the README swaps the Paper and Terminal variants with `<picture>` and `prefers-color-scheme`. The `<img>` inside is what npm shows: Paper for the logo, Terminal for the diagrams.

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

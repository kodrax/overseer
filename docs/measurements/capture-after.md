# Capture measurement (after)

Measured by `scripts/measure-capture.mjs` for REQ-0254: the baseline by TASK-0056, the repeat after TASK-0045/TASK-0046 by TASK-0047.

| | |
|---|---|
| Date | 2026-10-21T21:23:30.413Z |
| Commit | `f3bb0ea72d77aca87f6a7a76d371d6e5f8db1618` plus uncommitted: `scripts/measure-capture.mjs` |
| Embedder | Xenova/multilingual-e5-small (local cache, semantic results 1/1) |
| Machine | linux 7.2.7-1-default x64; AMD Ryzen 7 9800X3D 8-Core Processor (16 threads); 60 GB RAM; Node v24.18.1; load average (1/5/15 min) at start 4.04 / 2.26 / 1.45, at end 3.53 / 3.96 / 2.39 |
| omp | omp/18.12.3 |
| Live model | anthropic/claude-opus-5-5 |
| Command | `npm run measure:capture -- --live --out docs/measurements/capture-after` |

## REQ-0254 fit criterion

> Recording a dictated batch of up to 20 items with their links takes at most 3 overseer calls and no codebase reads; fetching one item with its parent, links and children takes 1 call; every CLI call finishes under 1 s at p95 on a 300-item registry.

| Measure | Target | Replay (skill steps) | Live runs (mean; min–max) |
|---|---|---|---|
| overseer requests to record the 20 items (received by overseer) | ≤ 3 | 2 | 2.3; 2–3 |
| agent tool calls that reached overseer | ≤ 3 | 2 | 2.3; 2–3 |
| codebase reads while recording | 0 | 0 | 0; 0–0 |
| agent tool calls in total | — | 2 | 4.3; 4–5 |
| calls to fetch one item with parent, links, children | 1 | 1 (`show --context`) | — |
| CLI `add --batch` p95, 300-item registry | < 1000 ms | 891 ms | — |
| CLI `show --context` p95, 300-item registry | < 1000 ms | 146 ms | — |

### Verdict

| Fit criterion element | Measured | Verdict |
|---|---|---|
| ≤ 3 overseer calls to record a 20-item dictation with its links | replay 2 per replay; live max 3 requests, 3 agent tool calls reaching overseer | **met** |
| duplicate check ran for every item (REQ-0254 AC) | replay 60/60 entries with a verdict (inside `create_item {items}`) | **met** |
| no codebase reads while recording | live max 0 | **met** |
| fetching one item with parent, links and children takes 1 call | 1 call (`show --context` / `get_item {context: true}`) for each of the 20 items | **met** |
| every CLI call < 1 s at p95 on a 300-item registry | `add --batch` 891 ms, `show --context` 146 ms | **met** |

Every element of the fit criterion is met.

## Against the baseline

Baseline: `docs/measurements/capture-baseline.json` (2026-10-20T13:53:31.293Z, commit `b273986b2a9a`, the per-item flow: `find_similar` then `create_item` per item). Same machine, registry, dictation, prompt, token counter and file set; the replay follows each commit's skill.

| Measure | Baseline | This run | Change |
|---|---|---|---|
| overseer requests to record the 20 items, replay | 41 | 2 | -39 (-95 %) |
| overseer requests to record the 20 items, live mean | 47.7 | 2.3 | -45.4 (-95 %) |
| agent tool calls reaching overseer, live mean | 8.7 | 2.3 | -6.4 (-74 %) |
| agent tool calls in total, live mean | 12.7 | 4.3 | -8.4 (-66 %) |
| codebase reads, live max | 0 | 0 | 0 |
| skill reads + tool doc reads, live mean | 3.7 | 2 | -1.7 (-46 %) |
| input tokens, live mean | 283,965.7 | 98,604 | -185,361.7 (-65 %) |
| output tokens, live mean | 6,516 | 7,134 | +618 (+9 %) |
| cost USD (per 1,000 runs), live mean | 340.8 | 343.3 | +2.5 (+1 %) |
| wall time s, live mean | 66.7 | 54.7 | -12 (-18 %) |
| CLI `similar` p50 ms (not in the new flow) | 566 | n/a | — |
| CLI `similar` p95 ms (not in the new flow) | 602 | n/a | — |
| CLI `add` p50 ms (not in the new flow) | 566 | n/a | — |
| CLI `add` p95 ms (not in the new flow) | 588 | n/a | — |
| CLI `show --context` p50 ms | 133 | 139 | +6 (+5 %) |
| CLI `show --context` p95 ms | 138 | 146 | +8 (+6 %) |
| CLI `add --batch` p50 ms (new in this flow) | n/a | 813 | — |
| CLI `add --batch` p95 ms (new in this flow) | n/a | 891 | — |
| tokens (claude-v5): skill | 3,524 | 2,465 | -1,059 (-30 %) |
| tokens (claude-v5): subagent prompt | 713 | 641 | -72 (-10 %) |
| tokens (claude-v5): reference: ears.md | 1,124 | 1,124 | 0 (0 %) |
| tokens (claude-v5): reference: nfr-iso25010.md | 958 | 958 | 0 (0 %) |
| tokens (claude-v5): reference: fields.md | 1,958 | 907 | -1,051 (-54 %) |
| **tokens (claude-v5): skill + subagent prompt + references** | 8,277 | 6,095 | -2,182 (-26 %) |
| tokens (claude-v5): MCP tool definitions | 7,114 | 8,247 | +1,133 (+16 %) |
| **tokens (claude-v5): all, with tool definitions** | 15,391 | 14,342 | -1,049 (-7 %) |
| tokens (o200k_base): skill + subagent prompt + references | 5,533 | 4,065 | -1,468 (-27 %) |

## Replay: CLI latency

3 replays of the 20-item dictation, each on a fresh copy of the seeded registry; every call is a new `node dist/cli.js` process. Seeding 300 items took 8.1 s. Duplicate-check verdicts of the created entries: related 54, duplicate 3, new 3. Embedder answered the warm-up `similar`: yes. Resends with `allow_duplicate`: 1, 1, 1 entries per replay.

| Command | Calls | p50 ms | p95 ms | min ms | max ms | mean ms |
|---|---|---|---|---|---|---|
| `add --batch` | 6 | 813 | 891 | 791 | 891 | 828 |
| `show --context` | 60 | 139 | 146 | 133 | 150 | 139 |
| `all` | 66 | 139 | 813 | 133 | 891 | 202 |

## Tokens loaded by capture

| Text | Loaded | Chars | ≈ chars/4 | o200k_base | claude-v5 |
|---|---|---|---|---|---|
| skill (`templates/skills/overseer/SKILL.md`) | read when the agent records items | 6,551 | 1,638 | 1,725 | 2,465 |
| subagent prompt (`templates/agent-prompt.md`) | system prompt of the overseer subagent | 1,736 | 434 | 428 | 641 |
| reference: ears.md (`templates/skills/overseer/references/ears.md`) | Capture a requirement, step 1 | 2,844 | 711 | 692 | 1,124 |
| reference: nfr-iso25010.md (`templates/skills/overseer/references/nfr-iso25010.md`) | Capture a requirement, step 2 (non-functional) | 2,481 | 621 | 593 | 958 |
| reference: fields.md (`templates/skills/overseer/references/fields.md`) | field dictionary the skill points to | 2,163 | 541 | 627 | 907 |
| MCP tool definitions (`(tools/list of overseer mcp, JSON)`) | by the harness in every session | 21,011 | 5,253 | 5,073 | 8,247 |
| **Skill + subagent prompt + references** | | 15,775 | 3,945 | 4,065 | 6,095 |
| **All, with tool definitions** | | 36,786 | 9,198 | 9,138 | 14,342 |

## Live runs

`omp -p --mode json` (omp/18.12.3), 3 runs. Input = uncached input + cache reads + cache writes, summed over every assistant message of the main agent and its subagents.

| Run | Wall s | overseer requests | by tool | Agent tool calls reaching overseer | by tool | Codebase reads | Skill reads | Tool doc reads | Subagents | Other | All tool calls | Input tokens | of which cache read | Output tokens | Cost USD | Items created | With parent | implements links |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 54.1 | 2 | create_item 2 | 2 | create_item 2 | 0 | 1 | 1 | 0 | 0 | 4 | 88,400 | 57,202 | 6,953 | 0.4 | 20 | 14 | 12 |
| 2 | 51.8 | 2 | create_item 2 | 2 | create_item 2 | 0 | 1 | 1 | 0 | 0 | 4 | 88,291 | 69,149 | 6,947 | 0.3059 | 20 | 14 | 12 |
| 3 | 58.3 | 3 | create_item 2, update_item 1 | 3 | create_item 2, update_item 1 | 0 | 1 | 1 | 0 | 0 | 5 | 119,121 | 99,860 | 7,502 | 0.3241 | 20 | 14 | 12 |

Expected from the dictation: 20 items, 14 with a parent, 12 implements links. Timing check (MCP/CLI tool calls with an overseer request in their time window, per run): 2/2, 2/2, 3/3.

## Method

- **Registry**: 300 generated items in a fixed order (10 epics; per epic 6 requirements, 6 stories with the epic as parent and an implements link, 14 tasks under the stories, 3 bugs), created with `create_item` through `node dist/cli.js mcp` in a temp git repository.
- **Dictation**: 20 fixed items (6 requirements, 6 stories under the seeded Payments epic, 8 tasks under the stories; 14 parent and 12 implements links). Live prompt below.
- **Replay**: the capture steps of `templates/skills/overseer/SKILL.md` and `templates/agent-prompt.md` (TASK-0045) as CLI calls: one `overseer add --batch - --json` with the 20 entries as `{items}` (dictation keys as `key`, `parent_id: "@<key>"`, `links: [{rel: implements, to: "@<key>"}]`, the seeded epic by ID); if it answers `possible_duplicate`, one resend with `allow_duplicate: true` on each listed entry (the dictation is new work, so the entries are kept). No `find_similar` first: the batch runs the duplicate check per entry. Then `overseer show <id> --context --json` per new item. One untimed warm-up `similar` call first. The baseline's per-item replay (`similar` then `add` per item) is not kept in the script; its numbers stay as committed in `docs/measurements/capture-baseline.{json,md}` and can be reproduced from its commit.
- **Latency**: wall time from spawn to exit of each `node dist/cli.js` process, run from the project root; p50/p95 by nearest rank over all replays.
- **Embedder**: the CLI's default, Xenova/multilingual-e5-small (q8 ONNX via transformers.js), loaded from the local model cache (`/home/ignacio/.cache/overseer/models`); "semantic results" counts `similar` answers with `semantic: true`.
- **Tokens**: the files as shipped in `templates/` (the subagent prompt with its `{{…}}` placeholders) and the JSON of the MCP `tools/list` answer. `≈ chars/4` needs no tokenizer; `o200k_base` (OpenAI) and `claude-v5` (Claude Opus 5+) come from `omp toks --json`, the offline tokenizers bundled with omp; `n/a` when omp is not installed. No dependency added.
- **Live**: per run a new temp git repository (README and one source file), `overseer install --scope project --targets omp` with this checkout's build on `PATH` (current skills, subagent and MCP server), `overseer enable`, the same 300 seeded items, then `omp -p --mode json --session-dir <tmp> --auto-approve --max-time 20m "<prompt>"`. Agent tool calls and token usage come from the assistant messages of the JSON event stream and of the subagent transcripts omp writes under `--session-dir`. After the run `overseer disable` and the repository is deleted.
- **overseer requests**: what overseer itself received. The `overseer` on `PATH` is a shim: `overseer mcp` runs behind a small proxy that logs every JSON-RPC line it receives with a timestamp (MCP `tools/call` requests by tool), and every other `overseer` command is logged with a timestamp (GNU `date`). An agent can send many requests from one tool call (a loop in an eval cell), so requests and agent tool calls are both reported.
- **Agent tool call classes**: reaching overseer = MCP tool calls (`write xd://mcp__overseer_<tool>` in omp, `mcp__overseer_<tool>` elsewhere), shell commands running `overseer`, and code-running calls (eval) whose code names `mcp__overseer_*` or during which overseer received a request (each main-agent call's time window comes from the arrival times of its `tool_execution_start`/`tool_execution_end` events; subagent calls are classified by their arguments only); codebase reads = `read`/`grep`/`glob`/`find`/`lsp` on files and shell commands such as `cat`, `ls`, `grep`, `git`; skill reads = `skill://` and `.omp/skills|agents` files; tool doc reads = `read xd://mcp__overseer_<tool>` (schema lookups); subagents = `task`; other = the rest.

### Repeat

On the same machine, with the model cached (`overseer models pull`), omp logged in with the same default model, from a clean checkout of the commit to compare:

```sh
npm ci
npm run measure:capture -- --live --out docs/measurements/capture-<label>
```

Any label other than `baseline` gets the "Against the baseline" table from `docs/measurements/capture-baseline.json`. The JSON keeps every sample: `capture_calls_per_replay`, `latency`, `tokens` and each live run's `overseer_requests`, `overseer_tool_calls`, `codebase_reads`, `total_tool_calls`, `tokens` and `registry`.

### Live prompt

```text
Record this dictation in overseer. I dictated the requirements, so they are approved.

Requirements:
R1 (must): When a customer buys a gift card, the shop shall email the gift card code to the recipient within 5 minutes. Acceptance: Given a paid gift card order, when 5 minutes pass, then the recipient has an email with the code.
R2 (must): When a customer enters a valid gift card code at checkout, the shop shall subtract the card balance from the order total. Acceptance: Given a card with 30 EUR and an order of 50 EUR, when the code is applied, then 20 EUR remain to pay.
R3 (should): When a gift card balance reaches zero, the shop shall mark the card as used and reject further redemptions. Acceptance: Given a card with balance 0, when its code is entered, then checkout rejects it as used.
R4 (must; non-functional, security; target: at most one valid code per 10^12 random guesses): The shop shall generate gift card codes of 16 random characters that cannot be guessed. Acceptance: Given 1000 generated codes, when checked, then all are 16 characters from a 32-symbol alphabet and unique.
R5 (should): When a gift card is 30 days from its expiry date, the shop shall remind the recipient by email. Acceptance: Given a card expiring in 30 days, when the daily job runs, then the recipient gets one reminder email.
R6 (should; non-functional, performance efficiency; target: p95 < 500 ms at 50 requests per second): When a customer checks a gift card balance, the shop shall answer within 500 ms. Acceptance: Given 50 requests per second, when balances are checked for 10 minutes, then p95 latency is below 500 ms.

User stories, all under the existing epic EPIC-0005 (Payments):
S1 (implements R1): As a customer I want to buy a gift card for a friend so that I can give a present.
S2 (implements R2 and R3): As a customer I want to pay with a gift card at checkout so that I can use my present.
S3 (implements R6): As a customer I want to check my gift card balance so that I know how much is left.
S4 (implements R5): As a gift card recipient I want a reminder before my card expires so that I do not lose the money.
S5 (implements R3): As a store manager I want to see sold and redeemed gift cards so that I can reconcile revenue.
S6 (implements R4): As a store manager I want to block a stolen gift card so that nobody can use it.

Tasks:
T1 (story S1): Create the gift card product type. Add a gift card product type with amounts of 25, 50 and 100 EUR.
T2 (story S1, implements R1): Send the gift card email. Send the recipient an email with the gift card code after payment.
T3 (story S2): Add the gift card field to checkout. Add a gift card code field to the order review step of checkout.
T4 (story S2, implements R2): Apply the gift card balance to the order. Subtract the gift card balance from the order total and store the remaining balance.
T5 (story S3, implements R6): Build the gift card balance page. Page where a customer enters a code and sees the remaining balance.
T6 (story S4, implements R5): Schedule the gift card expiry reminder job. Daily job that emails recipients whose card expires in 30 days.
T7 (story S5): Add the gift card report to the admin dashboard. Report of gift cards sold, redeemed and outstanding per month.
T8 (story S6, implements R4): Generate secure gift card codes. Generate 16-character codes from a cryptographic random source and reject collisions.
```

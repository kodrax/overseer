# Capture baseline (baseline)

Measured by `scripts/measure-capture.mjs` for REQ-0254 (TASK-0056). TASK-0047 repeats it after TASK-0045/TASK-0046 and compares.

| | |
|---|---|
| Date | 2026-10-20T13:53:31.293Z |
| Commit | `b273986b2a9a3503f8bd840952f2b5d5a0661a06` (merge base with origin/main: `63290d6392b9193e00fcc06fb0b3ed539b384d76`) |
| Embedder | Xenova/multilingual-e5-small (local cache, semantic results 60/60) |
| Machine | linux 7.2.7-1-default x64; AMD Ryzen 7 9800X3D 8-Core Processor (16 threads); 60 GB RAM; Node v24.18.1; load average (1/5/15 min) at start 0.81 / 1.67 / 1.8, at end 2.78 / 2.43 / 2.11 |
| omp | omp/18.12.3 |
| Live model | anthropic/claude-opus-5-5 |
| Command | `npm run measure:capture -- --live --out docs/measurements/capture-baseline` |

## REQ-0254 fit criterion

> Recording a dictated batch of up to 20 items with their links takes at most 3 overseer calls and no codebase reads; fetching one item with its parent, links and children takes 1 call; every CLI call finishes under 1 s at p95 on a 300-item registry.

| Measure | Target | Replay (skill steps) | Live runs (mean; min–max) |
|---|---|---|---|
| overseer requests to record the 20 items (received by overseer) | ≤ 3 | 41 | 47.7; 46–49 |
| agent tool calls that reached overseer | ≤ 3 | 41 | 8.7; 8–9 |
| codebase reads while recording | 0 | 0 | 0; 0–0 |
| agent tool calls in total | — | 41 | 12.7; 12–13 |
| calls to fetch one item with parent, links, children | 1 | 1 (`show --context`) | — |
| CLI `similar` p95, 300-item registry | < 1000 ms | 602 ms | — |
| CLI `add` p95, 300-item registry | < 1000 ms | 588 ms | — |
| CLI `show --context` p95, 300-item registry | < 1000 ms | 138 ms | — |

## Replay: CLI latency

3 replays of the 20-item dictation, each on a fresh copy of the seeded registry; every call is a new `node dist/cli.js` process. Seeding 300 items took 6.4 s. Duplicate-check verdicts: related 54, duplicate 3, new 3. Semantic results: 60/60.

| Command | Calls | p50 ms | p95 ms | min ms | max ms | mean ms |
|---|---|---|---|---|---|---|
| `similar` | 60 | 566 | 602 | 549 | 645 | 572 |
| `add` | 63 | 566 | 588 | 536 | 616 | 565 |
| `show --context` | 60 | 133 | 138 | 128 | 139 | 134 |
| `all` | 183 | 556 | 596 | 128 | 645 | 426 |

## Tokens loaded by capture

| Text | Loaded | Chars | ≈ chars/4 | o200k_base | claude-v5 |
|---|---|---|---|---|---|
| skill (`templates/skills/overseer/SKILL.md`) | read when the agent records items | 9,112 | 2,278 | 2,422 | 3,524 |
| subagent prompt (`templates/agent-prompt.md`) | system prompt of the overseer subagent | 1,978 | 495 | 493 | 713 |
| reference: ears.md (`templates/skills/overseer/references/ears.md`) | Capture a requirement, step 1 | 2,844 | 711 | 692 | 1,124 |
| reference: nfr-iso25010.md (`templates/skills/overseer/references/nfr-iso25010.md`) | Capture a requirement, step 2 (non-functional) | 2,481 | 621 | 593 | 958 |
| reference: fields.md (`templates/skills/overseer/references/fields.md`) | field dictionary the skill points to | 4,743 | 1,186 | 1,333 | 1,958 |
| MCP tool definitions (`(tools/list of overseer mcp, JSON)`) | by the harness in every session | 17,888 | 4,472 | 4,346 | 7,114 |
| **Skill + subagent prompt + references** | | 21,158 | 5,291 | 5,533 | 8,277 |
| **All, with tool definitions** | | 39,046 | 9,763 | 9,879 | 15,391 |

## Live runs

`omp -p --mode json` (omp/18.12.3), 3 runs. Input = uncached input + cache reads + cache writes, summed over every assistant message of the main agent and its subagents.

| Run | Wall s | overseer requests | by tool | Agent tool calls reaching overseer | by tool | Codebase reads | Skill reads | Tool doc reads | Subagents | Other | All tool calls | Input tokens | of which cache read | Output tokens | Cost USD | Items created | With parent | implements links |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 63.4 | 49 | get_item 7, find_similar 20, create_item 22 | 9 | eval (code) 9 | 0 | 1 | 3 | 0 | 0 | 13 | 283,919 | 266,518 | 6,297 | 0.3183 | 20 | 14 | 12 |
| 2 | 71 | 46 | get_item 4, find_similar 21, create_item 21 | 9 | eval (code) 9 | 0 | 1 | 3 | 0 | 0 | 13 | 304,365 | 283,845 | 6,562 | 0.3521 | 20 | 14 | 12 |
| 3 | 65.7 | 48 | get_item 3, list_items 1, find_similar 21, search 1, create_item 22 | 8 | get_item 1, list_items 1, eval (code) 6 | 0 | 1 | 2 | 0 | 1 | 12 | 263,613 | 242,394 | 6,689 | 0.3519 | 20 | 14 | 12 |

Expected from the dictation: 20 items, 14 with a parent, 12 implements links. Timing check (MCP/CLI tool calls with an overseer request in their time window, per run): 0/0, 0/0, 2/2.

## Method

- **Registry**: 300 generated items in a fixed order (10 epics; per epic 6 requirements, 6 stories with the epic as parent and an implements link, 14 tasks under the stories, 3 bugs), created with `create_item` through `node dist/cli.js mcp` in a temp git repository.
- **Dictation**: 20 fixed items (6 requirements, 6 stories under the seeded Payments epic, 8 tasks under the stories; 14 parent and 12 implements links). Live prompt below.
- **Replay**: the steps of `templates/skills/overseer/SKILL.md` and `templates/agent-prompt.md` ("Always run `find_similar` before creating an item", then `create_item` with `parent_id` and `links`), in dictation order, as CLI calls: `overseer similar "<title>. <description>" --kind <kind> --json`, then `overseer add <kind> … --parent … --implements … --json` (retried with `--allow-duplicate` if it reports a possible duplicate, skill step 5 c). Then `overseer show <id> --context --json` per new item. One untimed warm-up call first.
- **Latency**: wall time from spawn to exit of each `node dist/cli.js` process, run from the project root; p50/p95 by nearest rank over all replays.
- **Embedder**: the CLI's default, Xenova/multilingual-e5-small (q8 ONNX via transformers.js), from the local model cache (`/home/ignacio/.cache/overseer/models`); "semantic results" counts `similar` answers with `semantic: true`.
- **Tokens**: the files as shipped in `templates/` (the subagent prompt with its `{{…}}` placeholders) and the JSON of the MCP `tools/list` answer. `≈ chars/4` needs no tokenizer; `o200k_base` (OpenAI) and `claude-v5` (Claude Opus 5+) come from `omp toks --json`, the offline tokenizers bundled with omp; `n/a` when omp is not installed. No dependency added.
- **Live**: per run a new temp git repository (README and one source file), `overseer install --scope project --targets omp` with this checkout's build on `PATH` (current skills, subagent and MCP server), `overseer enable`, the same 300 seeded items, then `omp -p --mode json --session-dir <tmp> --auto-approve --max-time 20m "<prompt>"`. Agent tool calls and token usage come from the assistant messages of the JSON event stream and of the subagent transcripts omp writes under `--session-dir`. After the run `overseer disable` and the repository is deleted.
- **overseer requests**: what overseer itself received. The `overseer` on `PATH` is a shim: `overseer mcp` runs behind a small proxy that logs every JSON-RPC line it receives with a timestamp (MCP `tools/call` requests by tool), and every other `overseer` command is logged with a timestamp (GNU `date`). An agent can send many requests from one tool call (a loop in an eval cell), so requests and agent tool calls are both reported.
- **Agent tool call classes**: reaching overseer = MCP tool calls (`write xd://mcp__overseer_<tool>` in omp, `mcp__overseer_<tool>` elsewhere), shell commands running `overseer`, and code-running calls (eval) whose code names `mcp__overseer_*` or during which overseer received a request (each main-agent call's time window comes from the arrival times of its `tool_execution_start`/`tool_execution_end` events; subagent calls are classified by their arguments only); codebase reads = `read`/`grep`/`glob`/`find`/`lsp` on files and shell commands such as `cat`, `ls`, `grep`, `git`; skill reads = `skill://` and `.omp/skills|agents` files; tool doc reads = `read xd://mcp__overseer_<tool>` (schema lookups); subagents = `task`; other = the rest.

### Repeat (TASK-0047)

On the same machine, with the model cached (`overseer models pull`), omp logged in with the same default model, from a clean checkout of the commit to compare:

```sh
npm ci
npm run measure:capture -- --live --out docs/measurements/capture-<label>
```

Compare `capture_calls_per_replay`, `latency`, `tokens` and each live run's `overseer_requests`, `overseer_tool_calls`, `codebase_reads`, `total_tool_calls`, `tokens` and `registry` in the JSON with this baseline.

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

#!/usr/bin/env node
// Measures what capturing a dictated batch of items costs today (REQ-0254, TASK-0056; repeated by TASK-0047):
//   node scripts/measure-capture.mjs --out <prefix> [--replays N] [--live] [--live-runs N] [--model M]
//
// 1. Replay: a fixed 20-item dictation (requirements, stories, tasks with parent and implements links) recorded the way
//    the `overseer` skill prescribes (find_similar, then create_item, per item), through the built CLI, in a temp project
//    seeded with 300 generated items. Counts the overseer calls and times every CLI call (p50/p95 per command), plus a
//    lookup of each new item with `show --context` (REQ-0254: one call per item).
// 2. Tokens: the skill, the subagent prompt and the references capture loads, and the MCP tool definitions.
// 3. --live: the same dictation, sent N times (default 3) to `omp -p --mode json` in a throwaway git repository that has
//    the current skills installed at project scope and the same 300 seeded items. Turned on with `overseer enable`,
//    off again with `overseer disable`, then deleted. Records overseer calls, other tool calls, tokens and wall time.
//
// Writes <prefix>.json (every sample) and <prefix>.md (summary and method). Not part of `npm test`: it takes minutes
// and --live spends model tokens.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { arch, cpus, homedir, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const MODEL = 'Xenova/multilingual-e5-small';
const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];
const TODAY = new Date().toISOString().slice(0, 10);
const SOURCE = `conversation ${TODAY} (measure-capture)`;
const SEED_SIZE = 300;
const REQ_0254_FIT =
  'Recording a dictated batch of up to 20 items with their links takes at most 3 overseer calls and no codebase reads; ' +
  'fetching one item with its parent, links and children takes 1 call; every CLI call finishes under 1 s at p95 on a 300-item registry.';

// ---------------------------------------------------------------------------------------------------------------------
// Arguments

function parseArgs(argv) {
  const options = { out: undefined, replays: 3, live: false, liveRuns: 3, model: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) usage(`${arg} needs a value`);
      return next;
    };
    if (arg === '--out') options.out = value();
    else if (arg === '--replays') options.replays = positive(arg, value());
    else if (arg === '--live') options.live = true;
    else if (arg === '--live-runs') options.liveRuns = positive(arg, value());
    else if (arg === '--model') options.model = value();
    else if (arg === '--help' || arg === '-h') usage();
    else usage(`unknown argument ${arg}`);
  }
  if (!options.out) usage('--out <prefix> is required, e.g. --out docs/measurements/capture-baseline');
  return options;
}

function positive(flag, text) {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) usage(`${flag} must be a positive integer`);
  return n;
}

function usage(error) {
  const text = [
    'Usage: node scripts/measure-capture.mjs --out <prefix> [--replays N] [--live] [--live-runs N] [--model M]',
    '  --out <prefix>   write <prefix>.json and <prefix>.md',
    '  --replays N      deterministic replays of the dictation, each on a fresh copy of the seeded registry (default 3)',
    '  --live           also run the dictation with `omp -p --mode json` (spends model tokens)',
    '  --live-runs N    live runs (default 3)',
    '  --model M        model passed to omp --model (default: omp\'s default model)',
  ].join('\n');
  if (error) {
    console.error(`error: ${error}\n${text}`);
    process.exit(2);
  }
  console.log(text);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixed data: the 300-item seed registry and the 20-item dictation

const AREAS = [
  ['Product catalog', 'shopper', ['product page', 'category list', 'product image gallery', 'price label', 'stock badge', 'size chart']],
  ['Site search', 'shopper', ['search box', 'search results page', 'search filters', 'autocomplete list', 'spelling suggestion', 'sort order menu']],
  ['Shopping cart', 'shopper', ['cart page', 'mini cart', 'quantity selector', 'saved-for-later list', 'coupon field', 'cart summary']],
  ['Checkout', 'customer', ['shipping address form', 'delivery option list', 'order review page', 'guest checkout form', 'billing address form', 'order confirmation page']],
  ['Payments', 'customer', ['card payment form', 'PayPal button', 'refund request', 'payment retry', 'invoice PDF', 'stored card list']],
  ['Shipping and tracking', 'customer', ['tracking page', 'carrier label', 'delivery estimate', 'return label', 'pickup point map', 'shipment email']],
  ['Customer accounts', 'customer', ['sign-up form', 'login form', 'password reset', 'address book', 'order history', 'account deletion']],
  ['Reviews and ratings', 'customer', ['review form', 'star rating', 'review moderation queue', 'review photos', 'helpful vote', 'review summary']],
  ['Notifications', 'customer', ['back-in-stock alert', 'price drop alert', 'newsletter signup', 'push notification', 'SMS opt-in', 'notification settings']],
  ['Admin reporting', 'store manager', ['sales dashboard', 'inventory report', 'CSV export', 'low-stock report', 'refund report', 'traffic chart']],
];
/** Area whose epic the dictated stories go under. */
const DICTATION_EPIC_AREA = 4;

const REQUIREMENT_TEMPLATES = [
  (n, a) => ({ title: `Load the ${n} quickly`, description: `When a ${a} opens the ${n}, the shop shall display it within 2 seconds.`, req_type: 'non_functional', nfr_category: 'performance_efficiency', fit_criterion: 'p95 < 2 s on a 4G connection' }),
  (n) => ({ title: `Keep the ${n} accessible`, description: `The shop shall make the ${n} usable with a keyboard and a screen reader (WCAG 2.2 AA).`, req_type: 'non_functional', nfr_category: 'interaction_capability', fit_criterion: 'no WCAG 2.2 AA violations in an axe audit' }),
  (n, a) => ({ title: `Validate input in the ${n}`, description: `When a ${a} submits invalid data in the ${n}, the shop shall show an inline error next to the field.`, req_type: 'functional' }),
  (n) => ({ title: `Audit changes to the ${n}`, description: `When the ${n} changes, the shop shall record who changed it and when in the audit log.`, req_type: 'functional' }),
  (n, a) => ({ title: `Localize the ${n}`, description: `The shop shall show the ${n} in the ${a}'s language and currency.`, req_type: 'functional' }),
  (n) => ({ title: `Throttle abuse of the ${n}`, description: `When more than 20 requests per minute reach the ${n} from one client, the shop shall throttle that client.`, req_type: 'non_functional', nfr_category: 'security', fit_criterion: 'the 21st request within a minute gets HTTP 429' }),
];
const STORY_TEMPLATES = [
  (n, a) => ({ title: `Remember my last choice in the ${n}`, description: `As a ${a} I want the ${n} to remember my last choice so that I save time.` }),
  (n, a) => ({ title: `Use the ${n} on my phone`, description: `As a ${a} I want to use the ${n} on my phone so that I can shop on the go.` }),
  (n, a) => ({ title: `Clear errors in the ${n}`, description: `As a ${a} I want clear errors in the ${n} so that I can fix mistakes quickly.` }),
  (n, a) => ({ title: `See the ${n} in my language`, description: `As a ${a} I want the ${n} in my language so that I understand it.` }),
  (n, a) => ({ title: `Share the ${n}`, description: `As a ${a} I want to share the ${n} with a friend so that we can decide together.` }),
  (n, a) => ({ title: `Fast ${n}`, description: `As a ${a} I want the ${n} to load fast so that I do not give up.` }),
];
const TASK_TEMPLATES = [
  'Add an API endpoint for the %s',
  'Write unit tests for the %s',
  'Add an end-to-end test for the %s',
  'Add analytics events to the %s',
  'Cache the %s on the CDN',
  'Put the %s behind a feature flag',
  'Translate the %s strings',
  'Document the %s API',
  'Refactor the %s component',
  'Add a database index for the %s',
  'Monitor errors in the %s',
  'Design mockups for the %s',
  'Load test the %s',
  'Move the %s to the new design system',
];
const BUG_TEMPLATES = [
  ['The %s shows a blank page on Safari', 'major', 'Open the %s in Safari 18', 'The %s renders', 'A blank page'],
  ['The %s rounds prices wrong', 'minor', 'Open the %s with a price of 9.995', 'The price shows 10.00', 'The price shows 9.99'],
  ['The %s times out under load', 'critical', 'Send 200 concurrent requests to the %s', 'Responses within 2 s', 'Requests time out after 30 s'],
];

/** 300 items: per area 1 epic, 6 requirements, 6 stories (epic parent, implements), 14 tasks (story parent), 3 bugs. */
function* seedItems() {
  for (const [epic, actor, nouns] of AREAS) {
    yield { key: `epic:${epic}`, input: { kind: 'epic', title: epic, description: `Everything about the ${epic.toLowerCase()} of the online shop.` } };
    for (const [i, noun] of nouns.entries()) {
      yield {
        key: `req:${epic}:${i}`,
        input: {
          kind: 'requirement',
          status: 'approved',
          priority: i < 2 ? 'must' : 'should',
          verification_method: 'test',
          component: epic.toLowerCase(),
          acceptance_criteria: [`Given the ${noun}, when a ${actor} uses it, then it behaves as stated.`],
          ...REQUIREMENT_TEMPLATES[i](noun, actor),
        },
      };
    }
    for (const [i, noun] of nouns.entries()) {
      yield {
        key: `story:${epic}:${i}`,
        refs: { parent_id: `epic:${epic}`, implements: [`req:${epic}:${i}`] },
        input: { kind: 'story', priority: 'should', ...STORY_TEMPLATES[i](noun, actor) },
      };
    }
    for (const [i, template] of TASK_TEMPLATES.entries()) {
      const noun = nouns[i % nouns.length];
      const title = template.replace('%s', noun);
      yield {
        key: `task:${epic}:${i}`,
        refs: { parent_id: `story:${epic}:${i % nouns.length}` },
        input: { kind: 'task', title, description: `${title} so the ${epic.toLowerCase()} story can ship.` },
      };
    }
    for (const [i, [title, severity, step, expected, actual]] of BUG_TEMPLATES.entries()) {
      const noun = nouns[(i * 2) % nouns.length];
      yield {
        key: `bug:${epic}:${i}`,
        refs: { parent_id: `epic:${epic}` },
        input: {
          kind: 'bug',
          title: title.replace('%s', noun),
          severity,
          bug_details: { steps: [step.replace('%s', noun)], expected: expected.replace('%s', noun), actual },
        },
      };
    }
  }
}

/** The fixed 20-item dictation. `refs` name dictation keys (`R1`…) or `epic` (the seeded Payments epic). */
const DICTATION = [
  { key: 'R1', kind: 'requirement', priority: 'must', req_type: 'functional', title: 'Email the gift card code to the recipient', description: 'When a customer buys a gift card, the shop shall email the gift card code to the recipient within 5 minutes.', ac: ['Given a paid gift card order, when 5 minutes pass, then the recipient has an email with the code.'] },
  { key: 'R2', kind: 'requirement', priority: 'must', req_type: 'functional', title: 'Redeem a gift card at checkout', description: 'When a customer enters a valid gift card code at checkout, the shop shall subtract the card balance from the order total.', ac: ['Given a card with 30 EUR and an order of 50 EUR, when the code is applied, then 20 EUR remain to pay.'] },
  { key: 'R3', kind: 'requirement', priority: 'should', req_type: 'functional', title: 'Close used gift cards', description: 'When a gift card balance reaches zero, the shop shall mark the card as used and reject further redemptions.', ac: ['Given a card with balance 0, when its code is entered, then checkout rejects it as used.'] },
  { key: 'R4', kind: 'requirement', priority: 'must', req_type: 'non_functional', nfr_category: 'security', title: 'Unguessable gift card codes', description: 'The shop shall generate gift card codes of 16 random characters that cannot be guessed.', fit: 'at most one valid code per 10^12 random guesses', ac: ['Given 1000 generated codes, when checked, then all are 16 characters from a 32-symbol alphabet and unique.'] },
  { key: 'R5', kind: 'requirement', priority: 'should', req_type: 'functional', title: 'Remind before a gift card expires', description: 'When a gift card is 30 days from its expiry date, the shop shall remind the recipient by email.', ac: ['Given a card expiring in 30 days, when the daily job runs, then the recipient gets one reminder email.'] },
  { key: 'R6', kind: 'requirement', priority: 'should', req_type: 'non_functional', nfr_category: 'performance_efficiency', title: 'Fast gift card balance check', description: 'When a customer checks a gift card balance, the shop shall answer within 500 ms.', fit: 'p95 < 500 ms at 50 requests per second', ac: ['Given 50 requests per second, when balances are checked for 10 minutes, then p95 latency is below 500 ms.'] },
  { key: 'S1', kind: 'story', title: 'Buy a gift card for a friend', description: 'As a customer I want to buy a gift card for a friend so that I can give a present.', parent: 'epic', implements: ['R1'] },
  { key: 'S2', kind: 'story', title: 'Pay with a gift card', description: 'As a customer I want to pay with a gift card at checkout so that I can use my present.', parent: 'epic', implements: ['R2', 'R3'] },
  { key: 'S3', kind: 'story', title: 'Check my gift card balance', description: 'As a customer I want to check my gift card balance so that I know how much is left.', parent: 'epic', implements: ['R6'] },
  { key: 'S4', kind: 'story', title: 'Get a reminder before my gift card expires', description: 'As a gift card recipient I want a reminder before my card expires so that I do not lose the money.', parent: 'epic', implements: ['R5'] },
  { key: 'S5', kind: 'story', title: 'Reconcile gift card revenue', description: 'As a store manager I want to see sold and redeemed gift cards so that I can reconcile revenue.', parent: 'epic', implements: ['R3'] },
  { key: 'S6', kind: 'story', title: 'Block a stolen gift card', description: 'As a store manager I want to block a stolen gift card so that nobody can use it.', parent: 'epic', implements: ['R4'] },
  { key: 'T1', kind: 'task', title: 'Create the gift card product type', description: 'Add a gift card product type with amounts of 25, 50 and 100 EUR.', parent: 'S1' },
  { key: 'T2', kind: 'task', title: 'Send the gift card email', description: 'Send the recipient an email with the gift card code after payment.', parent: 'S1', implements: ['R1'] },
  { key: 'T3', kind: 'task', title: 'Add the gift card field to checkout', description: 'Add a gift card code field to the order review step of checkout.', parent: 'S2' },
  { key: 'T4', kind: 'task', title: 'Apply the gift card balance to the order', description: 'Subtract the gift card balance from the order total and store the remaining balance.', parent: 'S2', implements: ['R2'] },
  { key: 'T5', kind: 'task', title: 'Build the gift card balance page', description: 'Page where a customer enters a code and sees the remaining balance.', parent: 'S3', implements: ['R6'] },
  { key: 'T6', kind: 'task', title: 'Schedule the gift card expiry reminder job', description: 'Daily job that emails recipients whose card expires in 30 days.', parent: 'S4', implements: ['R5'] },
  { key: 'T7', kind: 'task', title: 'Add the gift card report to the admin dashboard', description: 'Report of gift cards sold, redeemed and outstanding per month.', parent: 'S5' },
  { key: 'T8', kind: 'task', title: 'Generate secure gift card codes', description: 'Generate 16-character codes from a cryptographic random source and reject collisions.', parent: 'S6', implements: ['R4'] },
];

/** What a user would type: the same 20 items, links by dictation number. */
function dictationPrompt(epicId) {
  const lines = ['Record this dictation in overseer. I dictated the requirements, so they are approved.', '', 'Requirements:'];
  for (const item of DICTATION.filter((entry) => entry.kind === 'requirement')) {
    const extra = [item.nfr_category ? `non-functional, ${item.nfr_category.replace('_', ' ')}` : null, item.fit ? `target: ${item.fit}` : null].filter(Boolean).join('; ');
    lines.push(`${item.key} (${item.priority}${extra ? `; ${extra}` : ''}): ${item.description} Acceptance: ${item.ac.join(' ')}`);
  }
  lines.push('', `User stories, all under the existing epic ${epicId} (Payments):`);
  for (const item of DICTATION.filter((entry) => entry.kind === 'story')) {
    lines.push(`${item.key} (implements ${item.implements.join(' and ')}): ${item.description}`);
  }
  lines.push('', 'Tasks:');
  for (const item of DICTATION.filter((entry) => entry.kind === 'task')) {
    const implementsText = item.implements ? `, implements ${item.implements.join(' and ')}` : '';
    lines.push(`${item.key} (story ${item.parent}${implementsText}): ${item.title}. ${item.description}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

function realTemp(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=measure-capture', '-c', 'user.email=measure@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 30, ...options });
  return result.error || result.status !== 0 ? null : result.stdout.trim();
}

/** Environment without the variables that would point overseer at another project. */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.OVERSEER_PROJECT;
  delete env.CLAUDE_PROJECT_DIR;
  return env;
}

/** One overseer CLI call from `cwd`, timed from spawn to exit. */
function cli(args, cwd, env) {
  const start = performance.now();
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 1 << 28 });
  const ms = performance.now() - start;
  if (result.status !== 0) throw new Error(`overseer ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  return { ms, json: JSON.parse(result.stdout) };
}

/** Nearest-rank percentile. */
function percentile(sorted, p) {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (ms) => Math.round(ms);
  return {
    n: sorted.length,
    p50_ms: round(percentile(sorted, 50)),
    p95_ms: round(percentile(sorted, 95)),
    min_ms: round(sorted[0]),
    max_ms: round(sorted.at(-1)),
    mean_ms: round(sorted.reduce((sum, ms) => sum + ms, 0) / sorted.length),
  };
}

function modelCacheDir() {
  if (process.env.OVERSEER_MODEL_DIR) return process.env.OVERSEER_MODEL_DIR;
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'overseer', 'models');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'overseer', 'models');
  return join(process.env.XDG_CACHE_HOME || join(home, '.cache'), 'overseer', 'models');
}

// ---------------------------------------------------------------------------------------------------------------------
// Seeding through the MCP server (one process, so 300 creates take seconds, not minutes)

async function withMcp(cwd, env, run) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], cwd, env, stderr: 'inherit' });
  const client = new Client({ name: 'measure-capture', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

/** Creates the 300 seed items; returns the ID per seed key. */
async function seedRegistry(client) {
  const ids = new Map();
  for (const { key, input, refs } of seedItems()) {
    const args = { ...input, source: 'measure-capture seed', allow_duplicate: true };
    if (refs?.parent_id) args.parent_id = ids.get(refs.parent_id);
    if (refs?.implements) args.links = refs.implements.map((ref) => ({ rel: 'implements', to: ids.get(ref) }));
    const result = await callTool(client, 'create_item', args);
    const id = result.id ?? result.item?.id;
    if (!result.created || !id) throw new Error(`seeding ${key} did not create an item: ${JSON.stringify(result)}`);
    ids.set(key, id);
  }
  if (ids.size !== SEED_SIZE) throw new Error(`seeded ${ids.size} items, expected ${SEED_SIZE}`);
  return ids;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Deterministic replay

function addArgs(item, ids) {
  const args = ['add', item.kind, '--title', item.title, '--description', item.description];
  if (item.kind === 'requirement') {
    args.push('--type', item.req_type, '--priority', item.priority, '--status', 'approved', '--verification', 'test');
    if (item.nfr_category) args.push('--nfr-category', item.nfr_category);
    if (item.fit) args.push('--fit', item.fit);
  }
  for (const criterion of item.ac ?? []) args.push('--ac', criterion);
  if (item.parent) args.push('--parent', ids.get(item.parent));
  for (const ref of item.implements ?? []) args.push('--implements', ids.get(ref));
  args.push('--source', SOURCE, '--json');
  return args;
}

/** Records the dictation with the skill's steps: per item find_similar (`similar`), then create_item (`add`). */
function replayOnce(project, env, epicId) {
  const ids = new Map([['epic', epicId]]);
  const calls = [];
  for (const item of DICTATION) {
    const similar = cli(['similar', `${item.title}. ${item.description}`, '--kind', item.kind, '--json'], project, env);
    const top = similar.json.matches?.[0];
    calls.push({
      step: 'capture',
      command: 'similar',
      item: item.key,
      ms: similar.ms,
      verdict: similar.json.verdict,
      semantic: similar.json.semantic,
      ...(top ? { top_match: { id: top.id, title: top.title, similarity: top.similarity } } : {}),
    });
    let add = cli(addArgs(item, ids), project, env);
    calls.push({ step: 'capture', command: 'add', item: item.key, ms: add.ms, created: add.json.created, verdict: add.json.verdict });
    if (!add.json.created) {
      // Skill step 5 (c): create anyway after showing the candidates.
      add = cli([...addArgs(item, ids), '--allow-duplicate'], project, env);
      calls.push({ step: 'capture', command: 'add', item: item.key, ms: add.ms, created: add.json.created, verdict: add.json.verdict, retry: true });
    }
    if (!add.json.id) throw new Error(`add ${item.key} returned no id: ${JSON.stringify(add.json)}`);
    ids.set(item.key, add.json.id);
  }
  for (const item of DICTATION) {
    const show = cli(['show', ids.get(item.key), '--context', '--json'], project, env);
    calls.push({ step: 'lookup', command: 'show --context', item: item.key, ms: show.ms });
  }
  return { ids: Object.fromEntries(DICTATION.map((item) => [item.key, ids.get(item.key)])), calls };
}

async function measureReplay(replays) {
  const base = realTemp('overseer-measure-');
  try {
    const project = join(base, 'project');
    const snapshot = join(base, 'snapshot');
    mkdirSync(project);
    git(project, 'init', '-q');
    const env = cleanEnv({ OVERSEER_CONFIG_DIR: join(base, 'config'), OVERSEER_ACTOR: 'measure-capture' });
    cli(['init', '--name', 'measure-capture', '--json'], project, env);

    const seedStart = performance.now();
    const { ids, tools } = await withMcp(project, env, async (client) => ({ ids: await seedRegistry(client), tools: (await client.listTools()).tools }));
    const seedSeconds = (performance.now() - seedStart) / 1000;
    const epicId = ids.get(`epic:${AREAS[DICTATION_EPIC_AREA][0]}`);
    cpSync(join(project, '.overseer'), snapshot, { recursive: true });

    // Untimed warm-up so the first sample does not pay for a cold disk cache.
    const warmup = cli(['similar', 'gift card', '--json'], project, env);

    const runs = [];
    for (let replay = 1; replay <= replays; replay++) {
      rmSync(join(project, '.overseer'), { recursive: true, force: true });
      cpSync(snapshot, join(project, '.overseer'), { recursive: true });
      runs.push({ replay, ...replayOnce(project, env, epicId) });
    }
    const total = cli(['list', '--all', '--limit', '1', '--json'], project, env).json.total;

    const all = runs.flatMap((run) => run.calls);
    const byCommand = {};
    for (const command of ['similar', 'add', 'show --context']) byCommand[command] = stats(all.filter((call) => call.command === command).map((call) => call.ms));
    const verdicts = {};
    for (const call of all.filter((entry) => entry.command === 'similar')) verdicts[call.verdict] = (verdicts[call.verdict] ?? 0) + 1;
    const capturePerReplay = runs.map((run) => run.calls.filter((call) => call.step === 'capture').length);
    return {
      seed: { items: ids.size, seconds: Math.round(seedSeconds * 10) / 10, epic: epicId, registry_after_last_replay: total },
      semantic: { similar_calls: all.filter((call) => call.command === 'similar').length, semantic_true: all.filter((call) => call.semantic === true).length, warmup_semantic: warmup.json.semantic === true },
      capture_calls_per_replay: capturePerReplay,
      lookup_calls_per_item: 1,
      similar_verdicts: verdicts,
      latency: byCommand,
      all_calls: stats(all.map((call) => call.ms)),
      runs,
      tools,
    };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. Tokens

const CAPTURE_FILES = [
  ['skill', 'templates/skills/overseer/SKILL.md', 'read when the agent records items'],
  ['subagent prompt', 'templates/agent-prompt.md', 'system prompt of the overseer subagent'],
  ['reference: ears.md', 'templates/skills/overseer/references/ears.md', 'Capture a requirement, step 1'],
  ['reference: nfr-iso25010.md', 'templates/skills/overseer/references/nfr-iso25010.md', 'Capture a requirement, step 2 (non-functional)'],
  ['reference: fields.md', 'templates/skills/overseer/references/fields.md', 'field dictionary the skill points to'],
];

function ompToks(file) {
  const out = tryRun('omp', ['toks', '--json', file]);
  if (!out) return null;
  const encodings = Object.fromEntries(JSON.parse(out).encodings.map((encoding) => [encoding.name, encoding.tokens]));
  return { o200k_base: encodings.o200k_base ?? null, 'claude-v5': encodings['claude-v5'] ?? null };
}

function countTokens(tools) {
  const scratch = realTemp('overseer-measure-toks-');
  try {
    const toolsFile = join(scratch, 'mcp-tools.json');
    writeFileSync(toolsFile, JSON.stringify(tools));
    const entries = [...CAPTURE_FILES.map(([name, path, loaded]) => ({ name, path, loaded, file: join(ROOT, path) })), { name: 'MCP tool definitions', path: '(tools/list of overseer mcp, JSON)', loaded: 'by the harness in every session', file: toolsFile }];
    const rows = entries.map(({ name, path, loaded, file }) => {
      const chars = readFileSync(file, 'utf8').length;
      return { name, path, loaded, chars, approx_chars_div_4: Math.ceil(chars / 4), ...(ompToks(file) ?? { o200k_base: null, 'claude-v5': null }) };
    });
    const sum = (list, key) => (list.some((row) => row[key] === null) ? null : list.reduce((total, row) => total + row[key], 0));
    const captureRows = rows.slice(0, CAPTURE_FILES.length);
    const totals = (list) => ({ chars: sum(list, 'chars'), approx_chars_div_4: sum(list, 'approx_chars_div_4'), o200k_base: sum(list, 'o200k_base'), 'claude-v5': sum(list, 'claude-v5') });
    return { rows, total_skill_prompt_references: totals(captureRows), total_with_tool_definitions: totals(rows) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Live runs with omp

const READ_TOOLS = new Set(['read', 'grep', 'glob', 'find', 'lsp', 'ast_grep', 'search']);
const OVERSEER_CLI = /(?:^|[\s;&|(`])overseer\s+([a-z-]+)/g;
const SHELL_READS = /\b(cat|ls|head|tail|grep|rg|find|fd|sed|awk|tree|wc|git)\b/;

/**
 * Sorts one agent tool call into overseer (the call reached overseer: an MCP tool, a shell `overseer` command, or code
 * run by an eval tool that calls `mcp__overseer_*`) / codebase read / skill read / tool docs / subagent / other.
 */
function classify(name, args = {}) {
  const path = typeof args.path === 'string' ? args.path : '';
  const mcp = name.match(/^(?:mcp__overseer__?|mcp_overseer_|overseer[-_])([a-z_]+)$/);
  if (mcp) return { category: 'overseer', tool: mcp[1] };
  const xdev = path.match(/^xd:\/\/mcp__overseer_([a-z_]+)/);
  if (xdev) return name === 'write' ? { category: 'overseer', tool: xdev[1] } : { category: 'tool_docs' };
  if (name === 'bash' && typeof args.command === 'string') {
    const commands = [...args.command.matchAll(OVERSEER_CLI)].map((match) => match[1]);
    if (commands.length > 0) return { category: 'overseer', tool: `bash: overseer ${commands[0]}` };
    return { category: SHELL_READS.test(args.command) ? 'codebase_read' : 'other' };
  }
  if (typeof args.code === 'string' && /mcp__overseer_/.test(args.code)) return { category: 'overseer', tool: `${name} (code)` };
  if (name === 'read' && (path.startsWith('skill://') || /\/\.omp\/(skills|agents)\//.test(path))) return { category: 'skill_read' };
  if (name === 'read' && /^[a-z]+:\/\//.test(path)) return { category: 'other' };
  if (READ_TOOLS.has(name)) return { category: 'codebase_read' };
  if (name === 'task') return { category: 'subagent' };
  return { category: 'other' };
}

function brief(args = {}) {
  const text = args.code !== undefined ? `${args.title ?? ''}: ${args.code}` : (args.command ?? args.path ?? args.pattern ?? JSON.stringify(args));
  return String(text).replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * Usage and tool calls of the assistant messages; `who` = main or the subagent file name. `requestsDuring(id)` counts
 * the overseer requests received while tool call `id` ran (main agent only); a call that runs code (eval) and sent
 * requests through a helper it defined earlier counts as reaching overseer.
 */
function tally(messages, who, requestsDuring = () => 0) {
  const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0, assistant_messages: 0 };
  const calls = [];
  const models = new Set();
  for (const message of messages) {
    usage.assistant_messages++;
    if (message.model) models.add(`${message.provider ?? ''}/${message.model}`.replace(/^\//, ''));
    const u = message.usage ?? {};
    usage.input += u.input ?? 0;
    usage.output += u.output ?? 0;
    usage.cache_read += u.cacheRead ?? 0;
    usage.cache_write += u.cacheWrite ?? 0;
    usage.cost_usd += u.cost?.total ?? 0;
    for (const part of message.content ?? []) {
      if (part.type !== 'toolCall') continue;
      const call = { who, name: part.name, ...classify(part.name, part.arguments), requests_during: requestsDuring(part.id), args: brief(part.arguments) };
      if (call.category === 'other' && call.requests_during > 0) Object.assign(call, { category: 'overseer', tool: `${part.name} (code)` });
      calls.push(call);
    }
  }
  return { usage, calls, models };
}

function jsonLines(text) {
  return text.split('\n').flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

function filesUnder(dir, suffix) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path, suffix) : entry.name.endsWith(suffix) ? [path] : [];
  });
}

/**
 * `overseer` on PATH for omp: this checkout's build, logging what reaches overseer with a timestamp. `overseer mcp` runs
 * behind a proxy that logs each JSON-RPC line it receives to mcp-<pid>.jsonl; any other command appends to cli.log
 * (GNU `date` for milliseconds).
 */
function writeShim(binDir, logDir) {
  mkdirSync(binDir, { recursive: true });
  const proxy = join(binDir, 'mcp-proxy.mjs');
  writeFileSync(
    proxy,
    [
      "import { spawn } from 'node:child_process';",
      "import { appendFileSync } from 'node:fs';",
      'const [log, ...command] = process.argv.slice(2);',
      "const child = spawn(process.execPath, command, { stdio: ['pipe', 'inherit', 'inherit'] });",
      "let pending = '';",
      "process.stdin.on('data', (chunk) => {",
      '  child.stdin.write(chunk);',
      '  pending += chunk;',
      "  for (let end = pending.indexOf('\\n'); end !== -1; end = pending.indexOf('\\n')) {",
      "    appendFileSync(log, JSON.stringify({ t: Date.now(), line: pending.slice(0, end) }) + '\\n');",
      '    pending = pending.slice(end + 1);',
      '  }',
      '});',
      "process.stdin.on('end', () => child.stdin.end());",
      "for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));",
      "child.on('exit', (code) => process.exit(code ?? 0));",
      '',
    ].join('\n'),
  );
  const shim = join(binDir, 'overseer');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      `if [ "$1" = "mcp" ]; then exec "${process.execPath}" "${proxy}" "${logDir}/mcp-$$.jsonl" "${CLI}" "$@"; fi`,
      `printf '%s %s\\n' "$(date +%s%3N)" "$*" >> "${logDir}/cli.log"`,
      `exec "${process.execPath}" "${CLI}" "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(shim, 0o755);
}

/** Requests overseer received from the agent (MCP tools/call by tool name, CLI commands by subcommand), with times. */
function overseerRequests(logDir) {
  const byTool = {};
  const times = [];
  const add = (tool, time) => {
    byTool[tool] = (byTool[tool] ?? 0) + 1;
    times.push(time);
  };
  for (const file of readdirSync(logDir)) {
    const text = readFileSync(join(logDir, file), 'utf8');
    if (file === 'cli.log') {
      for (const line of text.split('\n').filter(Boolean)) {
        const [time, subcommand] = line.split(' ');
        add(`cli ${subcommand}`, Number(time));
      }
      continue;
    }
    for (const { t, line } of jsonLines(text)) {
      const [message] = jsonLines(line);
      if (message?.method === 'tools/call') add(message.params?.name ?? 'unknown', t);
    }
  }
  return { total: times.length, by_tool: byTool, times };
}

/** Runs omp, stamping each JSON event with its arrival time (`at`, ms since the epoch). */
function runOmp(args, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('omp', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const events = [];
    let pending = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      pending += chunk;
      for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
        const at = Date.now();
        for (const event of jsonLines(pending.slice(0, end))) events.push({ ...event, at });
        pending = pending.slice(end + 1);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolvePromise({ status, events, stderr }));
  });
}

async function liveRun(run, options) {
  const base = realTemp('overseer-live-');
  const repo = join(base, 'repo');
  const sessions = join(base, 'sessions');
  const logs = join(base, 'logs');
  const env = cleanEnv({ PATH: `${join(base, 'bin')}:${process.env.PATH}` });
  delete env.OVERSEER_CONFIG_DIR;
  mkdirSync(logs);
  writeShim(join(base, 'bin'), logs);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# Demo shop\n\nAn online shop: catalog, cart, checkout, payments and shipping.\n');
  writeFileSync(join(repo, 'src', 'index.js'), "export function cartTotal(lines) {\n  return lines.reduce((sum, line) => sum + line.price * line.quantity, 0);\n}\n");
  git(repo, 'init', '-q');
  let enabled = false;
  try {
    // The current skills, subagent and MCP entry (`overseer mcp` through the shim, i.e. this checkout's build).
    cli(['install', '--scope', 'project', '--targets', 'omp', '--skip-model', '--json'], repo, env);
    cli(['enable', '--json'], repo, env);
    enabled = true;
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'Demo shop');
    const ids = await withMcp(repo, env, seedRegistry);
    const seeded = new Set(ids.values());
    const prompt = dictationPrompt(ids.get(`epic:${AREAS[DICTATION_EPIC_AREA][0]}`));

    const args = ['-p', '--mode', 'json', '--session-dir', sessions, '--auto-approve', '--max-time', '20m', ...(options.model ? ['--model', options.model] : []), prompt];
    console.error(`live run ${run}: omp in ${repo}`);
    const start = performance.now();
    const result = await runOmp(args, repo, env);
    const wallSeconds = (performance.now() - start) / 1000;

    const { events } = result;
    const requests = overseerRequests(logs);
    // When each main-agent tool call ran, from the arrival times of its tool_execution_start/end events.
    const windows = new Map();
    for (const event of events) {
      if (event.type === 'tool_execution_start') windows.set(event.toolCallId, { start: event.at, end: Infinity });
      if (event.type === 'tool_execution_end' && windows.has(event.toolCallId)) windows.get(event.toolCallId).end = event.at;
    }
    const requestsDuring = (id) => {
      const window = windows.get(id);
      return window ? requests.times.filter((time) => time >= window.start && time <= window.end).length : 0;
    };
    const main = tally(
      events.filter((event) => event.type === 'message_end' && event.message?.role === 'assistant').map((event) => event.message),
      'main',
      requestsDuring,
    );
    // Subagents write their own transcripts next to the main session file: <session-dir>/<main session>/<Agent>.jsonl.
    const subagentFiles = filesUnder(sessions, '.jsonl').filter((file) => dirname(file) !== sessions);
    const subagents = subagentFiles.map((file) =>
      tally(jsonLines(readFileSync(file, 'utf8')).filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant').map((entry) => entry.message), relative(sessions, file)),
    );
    const parts = [main, ...subagents];
    const calls = parts.flatMap((part) => part.calls);
    const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0, assistant_messages: 0 };
    for (const part of parts) for (const key of Object.keys(usage)) usage[key] += part.usage[key];
    usage.cost_usd = Math.round(usage.cost_usd * 10000) / 10000;
    const count = (category) => calls.filter((call) => call.category === category).length;
    const overseerToolCalls = {};
    for (const call of calls.filter((entry) => entry.category === 'overseer')) overseerToolCalls[call.tool] = (overseerToolCalls[call.tool] ?? 0) + 1;

    // What the run left in the registry.
    const listed = cli(['list', '--all', '--limit', '1000', '--json'], repo, env).json;
    const created = listed.items.filter((item) => !seeded.has(item.id));
    const byKind = {};
    for (const item of created) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    let withParent = 0;
    let implementsLinks = 0;
    for (let i = 0; i < created.length; i += 50) {
      const details = cli(['show', ...created.slice(i, i + 50).map((item) => item.id), '--json'], repo, env).json;
      for (const detail of details.items ?? [details]) {
        if (detail.item.parent_id) withParent++;
        implementsLinks += detail.links.outgoing.filter((link) => link.rel === 'implements').length;
      }
    }

    return {
      run,
      exit_code: result.status,
      wall_s: Math.round(wallSeconds * 10) / 10,
      models: [...new Set(parts.flatMap((part) => [...part.models]))],
      subagents: subagents.length,
      overseer_requests: requests.total,
      overseer_requests_by_tool: requests.by_tool,
      overseer_tool_calls: count('overseer'),
      overseer_tool_calls_by_tool: overseerToolCalls,
      // Main-agent MCP/CLI calls (found from their arguments) that had a request in their time window: checks the timing.
      timing_check: {
        calls_by_arguments: main.calls.filter((call) => call.category === 'overseer' && !call.tool.endsWith('(code)')).length,
        with_request_in_window: main.calls.filter((call) => call.category === 'overseer' && !call.tool.endsWith('(code)') && call.requests_during > 0).length,
      },
      codebase_reads: count('codebase_read'),
      skill_reads: count('skill_read'),
      tool_doc_reads: count('tool_docs'),
      subagent_calls: count('subagent'),
      other_calls: count('other'),
      total_tool_calls: calls.length,
      tokens: { ...usage, prompt_total: usage.input + usage.cache_read + usage.cache_write },
      registry: { items_created: created.length, by_kind: byKind, with_parent: withParent, implements_links: implementsLinks },
      calls,
      prompt,
    };
  } finally {
    if (enabled) cli(['disable', '--json'], repo, env);
    rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Report

function machine() {
  const cpu = cpus();
  return {
    os: `${platform()} ${release()} ${arch()}`,
    cpu: `${cpu[0]?.model.trim() ?? 'unknown'} (${cpu.length} threads)`,
    memory_gb: Math.round(totalmem() / 2 ** 30),
    node: process.version,
  };
}

const loadAverage = () => loadavg().map((load) => Math.round(load * 100) / 100);

function commitInfo() {
  const sha = git(ROOT, 'rev-parse', 'HEAD');
  const status = execFileSync('git', ['status', '--porcelain', '-z'], { cwd: ROOT, encoding: 'utf8' });
  const dirty = status.split('\0').filter(Boolean).map((entry) => entry.slice(3));
  return { sha, merge_base_origin_main: tryRun('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: ROOT }), dirty_paths: dirty };
}

const fmt = (value) => (value === null || value === undefined ? 'n/a' : typeof value === 'number' ? value.toLocaleString('en-US') : String(value));
const avg = (values) => Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;

function markdown(data, command) {
  const { replay, tokens, live } = data;
  const lines = [];
  lines.push(`# Capture baseline (${data.label})`, '');
  lines.push(`Measured by \`scripts/measure-capture.mjs\` for REQ-0254 (TASK-0056). TASK-0047 repeats it after TASK-0045/TASK-0046 and compares.`, '');
  lines.push('| | |', '|---|---|');
  lines.push(`| Date | ${data.date} |`);
  const base = data.commit.merge_base_origin_main && data.commit.merge_base_origin_main !== data.commit.sha ? ` (merge base with origin/main: \`${data.commit.merge_base_origin_main}\`)` : '';
  lines.push(`| Commit | \`${data.commit.sha}\`${base}${data.commit.dirty_paths.length ? ` plus uncommitted: ${data.commit.dirty_paths.map((path) => `\`${path}\``).join(', ')}` : ''} |`);
  lines.push(`| Embedder | ${data.embedder.label} |`);
  lines.push(`| Machine | ${data.machine.os}; ${data.machine.cpu}; ${data.machine.memory_gb} GB RAM; Node ${data.machine.node}; load average (1/5/15 min) at start ${data.machine.load_start.join(' / ')}, at end ${data.machine.load_end.join(' / ')} |`);
  lines.push(`| omp | ${data.omp_version ?? 'not found'} |`);
  if (live) lines.push(`| Live model | ${live.models.join(', ')} |`);
  lines.push(`| Command | \`${command}\` |`, '');

  lines.push('## REQ-0254 fit criterion', '', `> ${REQ_0254_FIT}`, '');
  lines.push('| Measure | Target | Replay (skill steps) | Live runs (mean; min–max) |', '|---|---|---|---|');
  const liveRange = (key) => (live ? `${avg(live.runs.map((run) => run[key]))}; ${Math.min(...live.runs.map((run) => run[key]))}–${Math.max(...live.runs.map((run) => run[key]))}` : 'not run');
  lines.push(`| overseer requests to record the 20 items (received by overseer) | ≤ 3 | ${replay.capture_calls_per_replay[0]} | ${liveRange('overseer_requests')} |`);
  lines.push(`| agent tool calls that reached overseer | ≤ 3 | ${replay.capture_calls_per_replay[0]} | ${liveRange('overseer_tool_calls')} |`);
  lines.push(`| codebase reads while recording | 0 | 0 | ${liveRange('codebase_reads')} |`);
  lines.push(`| agent tool calls in total | — | ${replay.capture_calls_per_replay[0]} | ${liveRange('total_tool_calls')} |`);
  lines.push(`| calls to fetch one item with parent, links, children | 1 | ${replay.lookup_calls_per_item} (\`show --context\`) | — |`);
  for (const [command, stat] of Object.entries(replay.latency)) lines.push(`| CLI \`${command}\` p95, ${data.seed_size}-item registry | < 1000 ms | ${stat.p95_ms} ms | — |`);
  lines.push('');

  lines.push('## Replay: CLI latency', '');
  lines.push(`${data.replays} replays of the 20-item dictation, each on a fresh copy of the seeded registry; every call is a new \`node dist/cli.js\` process. Seeding ${replay.seed.items} items took ${replay.seed.seconds} s. Duplicate-check verdicts: ${Object.entries(replay.similar_verdicts).map(([verdict, n]) => `${verdict} ${n}`).join(', ')}. Semantic results: ${replay.semantic.semantic_true}/${replay.semantic.similar_calls}.`, '');
  lines.push('| Command | Calls | p50 ms | p95 ms | min ms | max ms | mean ms |', '|---|---|---|---|---|---|---|');
  for (const [command, stat] of [...Object.entries(replay.latency), ['all', replay.all_calls]]) {
    lines.push(`| \`${command}\` | ${stat.n} | ${stat.p50_ms} | ${stat.p95_ms} | ${stat.min_ms} | ${stat.max_ms} | ${stat.mean_ms} |`);
  }
  lines.push('');

  lines.push('## Tokens loaded by capture', '');
  lines.push('| Text | Loaded | Chars | ≈ chars/4 | o200k_base | claude-v5 |', '|---|---|---|---|---|---|');
  for (const row of tokens.rows) lines.push(`| ${row.name} (\`${row.path}\`) | ${row.loaded} | ${fmt(row.chars)} | ${fmt(row.approx_chars_div_4)} | ${fmt(row.o200k_base)} | ${fmt(row['claude-v5'])} |`);
  for (const [label, total] of [['Skill + subagent prompt + references', tokens.total_skill_prompt_references], ['All, with tool definitions', tokens.total_with_tool_definitions]]) {
    lines.push(`| **${label}** | | ${fmt(total.chars)} | ${fmt(total.approx_chars_div_4)} | ${fmt(total.o200k_base)} | ${fmt(total['claude-v5'])} |`);
  }
  lines.push('');

  lines.push('## Live runs', '');
  if (!live) lines.push('Not run (pass `--live`).', '');
  else {
    lines.push(`\`omp -p --mode json\` (${data.omp_version}), ${live.runs.length} runs. Input = uncached input + cache reads + cache writes, summed over every assistant message of the main agent and its subagents.`, '');
    lines.push('| Run | Wall s | overseer requests | by tool | Agent tool calls reaching overseer | by tool | Codebase reads | Skill reads | Tool doc reads | Subagents | Other | All tool calls | Input tokens | of which cache read | Output tokens | Cost USD | Items created | With parent | implements links |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    const list = (counts) => Object.entries(counts).map(([tool, n]) => `${tool} ${n}`).join(', ');
    for (const run of live.runs) {
      lines.push(`| ${run.run} | ${run.wall_s} | ${run.overseer_requests} | ${list(run.overseer_requests_by_tool)} | ${run.overseer_tool_calls} | ${list(run.overseer_tool_calls_by_tool)} | ${run.codebase_reads} | ${run.skill_reads} | ${run.tool_doc_reads} | ${run.subagent_calls} | ${run.other_calls} | ${run.total_tool_calls} | ${fmt(run.tokens.prompt_total)} | ${fmt(run.tokens.cache_read)} | ${fmt(run.tokens.output)} | ${run.tokens.cost_usd} | ${run.registry.items_created} | ${run.registry.with_parent} | ${run.registry.implements_links} |`);
    }
    const timing = live.runs.map((run) => `${run.timing_check.with_request_in_window}/${run.timing_check.calls_by_arguments}`).join(', ');
    lines.push('', `Expected from the dictation: 20 items, 14 with a parent, 12 implements links. Timing check (MCP/CLI tool calls with an overseer request in their time window, per run): ${timing}.`, '');
  }

  lines.push('## Method', '');
  lines.push(`- **Registry**: ${data.seed_size} generated items in a fixed order (10 epics; per epic 6 requirements, 6 stories with the epic as parent and an implements link, 14 tasks under the stories, 3 bugs), created with \`create_item\` through \`node dist/cli.js mcp\` in a temp git repository.`);
  lines.push(`- **Dictation**: 20 fixed items (6 requirements, 6 stories under the seeded Payments epic, 8 tasks under the stories; 14 parent and 12 implements links). Live prompt below.`);
  lines.push('- **Replay**: the steps of `templates/skills/overseer/SKILL.md` and `templates/agent-prompt.md` ("Always run `find_similar` before creating an item", then `create_item` with `parent_id` and `links`), in dictation order, as CLI calls: `overseer similar "<title>. <description>" --kind <kind> --json`, then `overseer add <kind> … --parent … --implements … --json` (retried with `--allow-duplicate` if it reports a possible duplicate, skill step 5 c). Then `overseer show <id> --context --json` per new item. One untimed warm-up call first.');
  lines.push('- **Latency**: wall time from spawn to exit of each `node dist/cli.js` process, run from the project root; p50/p95 by nearest rank over all replays.');
  const embedderMethod = data.embedder.cached_before_run
    ? `the CLI's default, ${MODEL} (q8 ONNX via transformers.js), loaded from the local model cache (\`${data.embedder.cache_dir}\`)`
    : `none: ${MODEL} was not in the model cache (\`${data.embedder.cache_dir}\`), so the CLI answered with keyword (FTS) search only; run \`overseer models pull\` and measure again for semantic results`;
  lines.push(`- **Embedder**: ${embedderMethod}; "semantic results" counts \`similar\` answers with \`semantic: true\`.`);
  lines.push('- **Tokens**: the files as shipped in `templates/` (the subagent prompt with its `{{…}}` placeholders) and the JSON of the MCP `tools/list` answer. `≈ chars/4` needs no tokenizer; `o200k_base` (OpenAI) and `claude-v5` (Claude Opus 5+) come from `omp toks --json`, the offline tokenizers bundled with omp; `n/a` when omp is not installed. No dependency added.');
  lines.push('- **Live**: per run a new temp git repository (README and one source file), `overseer install --scope project --targets omp` with this checkout\'s build on `PATH` (current skills, subagent and MCP server), `overseer enable`, the same 300 seeded items, then `omp -p --mode json --session-dir <tmp> --auto-approve --max-time 20m "<prompt>"`. Agent tool calls and token usage come from the assistant messages of the JSON event stream and of the subagent transcripts omp writes under `--session-dir`. After the run `overseer disable` and the repository is deleted.');
  lines.push('- **overseer requests**: what overseer itself received. The `overseer` on `PATH` is a shim: `overseer mcp` runs behind a small proxy that logs every JSON-RPC line it receives with a timestamp (MCP `tools/call` requests by tool), and every other `overseer` command is logged with a timestamp (GNU `date`). An agent can send many requests from one tool call (a loop in an eval cell), so requests and agent tool calls are both reported.');
  lines.push('- **Agent tool call classes**: reaching overseer = MCP tool calls (`write xd://mcp__overseer_<tool>` in omp, `mcp__overseer_<tool>` elsewhere), shell commands running `overseer`, and code-running calls (eval) whose code names `mcp__overseer_*` or during which overseer received a request (each main-agent call\'s time window comes from the arrival times of its `tool_execution_start`/`tool_execution_end` events; subagent calls are classified by their arguments only); codebase reads = `read`/`grep`/`glob`/`find`/`lsp` on files and shell commands such as `cat`, `ls`, `grep`, `git`; skill reads = `skill://` and `.omp/skills|agents` files; tool doc reads = `read xd://mcp__overseer_<tool>` (schema lookups); subagents = `task`; other = the rest.');
  lines.push('');
  lines.push('### Repeat (TASK-0047)', '');
  lines.push('On the same machine, with the model cached (`overseer models pull`), omp logged in with the same default model, from a clean checkout of the commit to compare:', '');
  lines.push('```sh', 'npm ci', 'npm run measure:capture -- --live --out docs/measurements/capture-<label>', '```', '');
  lines.push('Compare `capture_calls_per_replay`, `latency`, `tokens` and each live run\'s `overseer_requests`, `overseer_tool_calls`, `codebase_reads`, `total_tool_calls`, `tokens` and `registry` in the JSON with this baseline.', '');
  if (live) lines.push('### Live prompt', '', '```text', live.runs[0].prompt, '```', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ensure = spawnSync(process.execPath, [join(ROOT, 'scripts', 'ensure-build.mjs')], { stdio: ['ignore', 2, 2] });
  if (ensure.status !== 0 || !existsSync(CLI)) throw new Error('dist/cli.js is missing or out of date and the build failed');

  const cacheDir = modelCacheDir();
  const cached = MODEL_FILES.every((file) => existsSync(join(cacheDir, MODEL, file)));
  const ompVersion = tryRun('omp', ['--version']);
  const loadStart = loadAverage();
  const startedAt = new Date().toISOString();

  console.error(`replay: ${options.replays} × 20 items on ${SEED_SIZE} seeded items`);
  const replay = await measureReplay(options.replays);
  const semantic = replay.semantic.semantic_true === replay.semantic.similar_calls;
  const tokens = countTokens(replay.tools);

  let live = null;
  if (options.live) {
    if (!ompVersion) throw new Error('--live needs omp on PATH');
    const runs = [];
    for (let run = 1; run <= options.liveRuns; run++) runs.push(await liveRun(run, options));
    live = { models: [...new Set(runs.flatMap((run) => run.models))], runs };
  }

  const data = {
    label: basename(options.out).replace(/^capture-/, ''),
    date: startedAt,
    commit: commitInfo(),
    machine: { ...machine(), load_start: loadStart, load_end: loadAverage() },
    embedder: {
      label: semantic
        ? `${MODEL} (local cache, semantic results ${replay.semantic.semantic_true}/${replay.semantic.similar_calls})`
        : `keyword only (${cached ? `${MODEL} cached but not used` : `${MODEL} not in the cache`}): ${replay.semantic.semantic_true}/${replay.semantic.similar_calls} semantic results`,
      model: MODEL,
      cached_before_run: cached,
      cache_dir: cacheDir,
    },
    omp_version: ompVersion,
    seed_size: SEED_SIZE,
    replays: options.replays,
    fit_criterion: REQ_0254_FIT,
    replay: { ...replay, tools: replay.tools.map((tool) => tool.name) },
    tokens,
    live,
  };
  const command = `npm run measure:capture -- ${process.argv.slice(2).join(' ')}`;
  data.command = command;
  const out = resolve(options.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.json`, `${JSON.stringify(data, null, 2)}\n`);
  writeFileSync(`${out}.md`, markdown(data, command));
  console.error(`wrote ${relative(process.cwd(), out)}.json and .md`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type CallToolResult, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer, INSTRUCTIONS, type McpServerOptions } from '../src/mcp/server.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { freePort, listening } from './helpers/net.js';
import { tempDir, tempRepo, tempUserConfig } from './helpers/tmp.js';

const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  vi.unstubAllEnvs();
});

async function connect(options: McpServerOptions, roots?: string[]): Promise<Client> {
  // Projects are off by default: a throwaway user config turns overseer on for temp dirs and keeps the host's rules out.
  const server = createMcpServer({ embedder: new HashEmbedder(), ...options, env: { OVERSEER_CONFIG_DIR: tempUserConfig(), ...options.env } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: roots ? { roots: {} } : {} });
  if (roots) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: roots.map((dir) => ({ uri: pathToFileURL(dir).href })) }));
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
  return { result, text, data: result.structuredContent as Record<string, unknown> | undefined };
}

describe('mcp server', () => {
  it('lists exactly the thirteen tools and sends the instructions', async () => {
    const client = await connect({ cwd: tempRepo() });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'check_coverage',
        'create_item',
        'delete_item',
        'export_report',
        'find_similar',
        'get_item',
        'import_items',
        'link_items',
        'list_items',
        'open_board',
        'report',
        'search',
        'update_item',
      ].sort(),
    );
    expect(tools.find((tool) => tool.name === 'find_similar')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === 'create_item')!.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((tool) => tool.name === 'delete_item')!.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    for (const tool of tools) expect(Object.keys(tool.inputSchema.properties ?? {})).toContain('project_dir');
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
  });

  it('creates an item and finds it again, recording the client name', async () => {
    const repo = tempRepo();
    const client = await connect({ cwd: repo });
    const created = await call(client, 'create_item', {
      kind: 'requirement',
      title: 'Password reset by email',
      description: 'When a user requests a password reset, the system shall email a single-use link.',
      req_type: 'functional',
    });
    expect(created.result.isError).toBeFalsy();
    expect(created.data).toMatchObject({ created: true, id: 'REQ-0001' });
    expect(JSON.parse(created.text)).toMatchObject({ created: true });
    const updated = await call(client, 'update_item', { id: 'REQ-0001', full: true });
    expect(updated.data).toMatchObject({ item: { id: 'REQ-0001', recorded_via: 'test-client' }, changed_fields: [] });

    const similar = await call(client, 'find_similar', { text: 'Password reset by email single-use link', kind: 'requirement' });
    expect(similar.data).toMatchObject({ semantic: true, matches: [{ id: 'REQ-0001', coverage: 'untracked' }] });

    const report = await call(client, 'report', { kind: 'coverage' });
    expect(report.text).toContain('# Requirement coverage');
    expect(report.data).toMatchObject({ kind: 'coverage', data: { requirements: [{ id: 'REQ-0001' }] } });

    const missing = await call(client, 'get_item', { id: 'REQ-0099' });
    expect(missing.result.isError).toBe(true);
    expect(missing.text).toBe('NOT_FOUND: No item with id REQ-0099.');
  });

  it('get_item takes id or ids, with optional context', async () => {
    const client = await connect({ cwd: tempRepo() });
    await call(client, 'create_item', {
      kind: 'requirement',
      title: 'Password reset by email',
      description: 'When a user requests a password reset, the system shall email a single-use link.',
      req_type: 'functional',
      acceptance_criteria: ['Given a user, when reset, then email'],
    });
    await call(client, 'create_item', { kind: 'story', title: 'Reset password', links: [{ rel: 'implements', to: 'REQ-0001' }], allow_duplicate: true });
    await call(client, 'create_item', { kind: 'task', title: 'Reset form', parent_id: 'US-0001', links: [{ rel: 'implements', to: 'REQ-0001' }], allow_duplicate: true });

    const single = await call(client, 'get_item', { id: 'TASK-0001' });
    expect(Object.keys(single.data!)).toEqual(['item', 'links', 'children']);

    const many = await call(client, 'get_item', { ids: ['TASK-0001', 'REQ-0001'], context: true });
    expect(many.result.isError).toBeFalsy();
    expect(JSON.parse(many.text)).toEqual(many.data);
    expect(many.data).toMatchObject({
      items: [
        {
          item: { id: 'TASK-0001' },
          parent: { id: 'US-0001', kind: 'story', title: 'Reset password', status: 'backlog' },
          requirements: [{ rel: 'implements', id: 'REQ-0001', acceptance_criteria: ['Given a user, when reset, then email'] }],
        },
        { item: { id: 'REQ-0001' }, parent: null, requirements: [], links: { incoming: [{ id: 'TASK-0001' }, { id: 'US-0001' }] } },
      ],
    });

    const missing = await call(client, 'get_item', { ids: ['REQ-0098', 'TASK-0001', 'REQ-0099'] });
    expect(missing.text).toBe('NOT_FOUND: No items with ids REQ-0098, REQ-0099.');
    const both = await call(client, 'get_item', { id: 'REQ-0001', ids: ['REQ-0001'] });
    expect(both.text).toBe('INVALID_INPUT: Pass exactly one of id and ids.');
    const neither = await call(client, 'get_item', {});
    expect(neither.text).toBe('INVALID_INPUT: Pass exactly one of id and ids.');
    const tooMany = await call(client, 'get_item', { ids: Array.from({ length: 51 }, () => 'REQ-0001') });
    expect(tooMany.result.isError).toBe(true);
    expect(tooMany.text).toMatch(/^INVALID_INPUT: /);
  });

  it('returns compact create and update results unless full is set', async () => {
    const repo = tempRepo();
    const client = await connect({ cwd: repo });
    const { tools } = await client.listTools();
    for (const name of ['create_item', 'update_item']) {
      expect(Object.keys(tools.find((tool) => tool.name === name)!.inputSchema.properties ?? {})).toContain('full');
    }
    const reset = {
      kind: 'requirement',
      title: 'Password reset by email',
      description: 'When a user requests a password reset, the system shall email a single-use link.',
      req_type: 'functional',
      acceptance_criteria: ['Given a registered email, when a reset is requested, then a link is sent'],
    };

    const created = await call(client, 'create_item', reset);
    expect(created.data).toEqual({ created: true, id: 'REQ-0001', title: 'Password reset by email', status: 'proposed', verdict: 'new', candidates: [], warnings: [] });
    expect(JSON.parse(created.text)).toEqual(created.data);

    const duplicate = await call(client, 'create_item', reset);
    expect(duplicate.data).toEqual({
      created: false,
      reason: 'possible_duplicate',
      verdict: 'duplicate',
      candidates: [{ id: 'REQ-0001', title: 'Password reset by email', similarity: expect.any(Number), match: 'duplicate' }],
    });

    const forced = await call(client, 'create_item', { ...reset, allow_duplicate: true });
    expect(forced.data).toEqual({
      created: true,
      id: 'REQ-0002',
      title: 'Password reset by email',
      status: 'proposed',
      verdict: 'duplicate',
      candidates: [{ id: 'REQ-0001', title: 'Password reset by email', similarity: expect.any(Number), match: 'duplicate' }],
      warnings: [],
    });

    const fullCreate = await call(client, 'create_item', { ...reset, allow_duplicate: true, full: true });
    expect(fullCreate.data).toMatchObject({
      created: true,
      item: { id: 'REQ-0003', kind: 'requirement', description: reset.description, recorded_via: 'test-client' },
      warnings: [],
      similar: [{ id: 'REQ-0001', kind: 'requirement', status: 'proposed', match: 'duplicate' }, { id: 'REQ-0002' }],
    });
    expect(Object.keys(fullCreate.data!).sort()).toEqual(['created', 'item', 'similar', 'warnings']);
    const fullDuplicate = await call(client, 'create_item', { ...reset, full: true });
    expect(fullDuplicate.data).toMatchObject({ created: false, reason: 'possible_duplicate' });
    expect((fullDuplicate.data!.candidates as object[])[0]).toMatchObject({ id: 'REQ-0001', kind: 'requirement', status: 'proposed', coverage: 'untracked' });
    expect(fullDuplicate.data).not.toHaveProperty('verdict');

    const updated = await call(client, 'update_item', { id: 'REQ-0001', status: 'approved', priority: 'must' });
    expect(updated.data).toEqual({ id: 'REQ-0001', title: 'Password reset by email', status: 'approved', changed_fields: ['priority', 'status'], warnings: [] });
    const fullUpdate = await call(client, 'update_item', { id: 'REQ-0001', acceptance_criteria: [], full: true });
    expect(fullUpdate.data).toMatchObject({
      item: { id: 'REQ-0001', status: 'approved', priority: 'must', acceptance_criteria: [] },
      changed_fields: ['acceptance_criteria'],
      warnings: [expect.objectContaining({ rule: expect.any(String) })],
    });
    expect(Object.keys(fullUpdate.data!).sort()).toEqual(['changed_fields', 'item', 'warnings']);
  });

  it('delete_item deletes an item, refuses one with children, and get_item then says when it was deleted', async () => {
    const client = await connect({ cwd: tempRepo() });
    await call(client, 'create_item', { kind: 'epic', title: 'Accounts' });
    await call(client, 'create_item', { kind: 'story', title: 'Sign in', parent_id: 'EPIC-0001' });

    const refused = await call(client, 'delete_item', { id: 'EPIC-0001' });
    expect(refused.result.isError).toBe(true);
    expect(refused.text).toBe('CONFLICT: EPIC-0001 has children: US-0001. Delete them or give them another parent first; nothing was deleted.');

    const deleted = await call(client, 'delete_item', { id: 'US-0001' });
    expect(deleted.result.isError).toBeFalsy();
    expect(deleted.data).toEqual({ deleted: true, id: 'US-0001', kind: 'story', title: 'Sign in', external_refs: [], deleted_at: expect.any(String), actor: expect.any(String) });
    const at = String(deleted.data!.deleted_at);
    expect((await call(client, 'get_item', { id: 'US-0001' })).text).toBe(`NOT_FOUND: Item US-0001 was deleted on ${at}.`);
    expect((await call(client, 'get_item', { ids: ['EPIC-0001', 'US-0001', 'US-0009'] })).text).toBe(
      `NOT_FOUND: No items with ids US-0001 (deleted on ${at}), US-0009.`,
    );
    expect((await call(client, 'get_item', { id: 'EPIC-0001' })).data).toMatchObject({ children: [] });
    expect((await call(client, 'create_item', { kind: 'story', title: 'Sign out' })).data).toMatchObject({ id: 'US-0002' });
  });

  it('names every tool in the overseer skill tool table and the README tool list', async () => {
    const client = await connect({ cwd: tempRepo() });
    const { tools } = await client.listTools();
    const skill = readFileSync(join(import.meta.dirname, '../templates/skills/overseer/SKILL.md'), 'utf8');
    const readme = readFileSync(join(import.meta.dirname, '../README.md'), 'utf8');
    const readmeTools = readme.slice(readme.indexOf('### MCP tools'), readme.indexOf('## Data model'));
    for (const { name } of tools) {
      expect(skill, name).toMatch(new RegExp(`^\\| \`${name}\` \\| .+ \\| \`overseer .+\\|$`, 'm'));
      expect(readmeTools, name).toContain(`\`${name}\``);
    }
  });

  it('records the TASK-0056 dictation (20 items, 14 parents, 12 links) in one create_item call (AC5)', async () => {
    const repo = tempRepo();
    const client = await connect({ cwd: repo });
    const epic = await call(client, 'create_item', { kind: 'epic', title: 'Payments', description: 'Paying for orders.' });
    const epicId = String(epic.data!.id);
    const requirement = (key: string, title: string, description: string) => ({ key, kind: 'requirement', req_type: 'functional', status: 'approved', title, description });
    const story = (key: string, title: string, description: string, implemented: string[]) => ({
      key,
      kind: 'story',
      title,
      description,
      parent_id: epicId,
      links: implemented.map((to) => ({ rel: 'implements', to: `@${to}` })),
    });
    const task = (key: string, title: string, description: string, parent: string, implemented: string[] = []) => ({
      key,
      kind: 'task',
      title,
      description,
      parent_id: `@${parent}`,
      ...(implemented.length > 0 ? { links: implemented.map((to) => ({ rel: 'implements', to: `@${to}` })) } : {}),
    });
    // scripts/measure-capture.mjs DICTATION, as one batch.
    const items = [
      requirement('R1', 'Email the gift card code to the recipient', 'When a customer buys a gift card, the shop shall email the gift card code to the recipient within 5 minutes.'),
      requirement('R2', 'Redeem a gift card at checkout', 'When a customer enters a valid gift card code at checkout, the shop shall subtract the card balance from the order total.'),
      requirement('R3', 'Close used gift cards', 'When a gift card balance reaches zero, the shop shall mark the card as used and reject further redemptions.'),
      requirement('R4', 'Unguessable gift card codes', 'The shop shall generate gift card codes of 16 random characters that cannot be guessed.'),
      requirement('R5', 'Remind before a gift card expires', 'When a gift card is 30 days from its expiry date, the shop shall remind the recipient by email.'),
      requirement('R6', 'Fast gift card balance check', 'When a customer checks a gift card balance, the shop shall answer within 500 ms.'),
      story('S1', 'Buy a gift card for a friend', 'As a customer I want to buy a gift card for a friend so that I can give a present.', ['R1']),
      story('S2', 'Pay with a gift card', 'As a customer I want to pay with a gift card at checkout so that I can use my present.', ['R2', 'R3']),
      story('S3', 'Check my gift card balance', 'As a customer I want to check my gift card balance so that I know how much is left.', ['R6']),
      story('S4', 'Get a reminder before my gift card expires', 'As a gift card recipient I want a reminder before my card expires so that I do not lose the money.', ['R5']),
      story('S5', 'Reconcile gift card revenue', 'As a store manager I want to see sold and redeemed gift cards so that I can reconcile revenue.', ['R3']),
      story('S6', 'Block a stolen gift card', 'As a store manager I want to block a stolen gift card so that nobody can use it.', ['R4']),
      task('T1', 'Create the gift card product type', 'Add a gift card product type with amounts of 25, 50 and 100 EUR.', 'S1'),
      task('T2', 'Send the gift card email', 'Send the recipient an email with the gift card code after payment.', 'S1', ['R1']),
      task('T3', 'Add the gift card field to checkout', 'Add a gift card code field to the order review step of checkout.', 'S2'),
      task('T4', 'Apply the gift card balance to the order', 'Subtract the gift card balance from the order total and store the remaining balance.', 'S2', ['R2']),
      task('T5', 'Build the gift card balance page', 'Page where a customer enters a code and sees the remaining balance.', 'S3', ['R6']),
      task('T6', 'Schedule the gift card expiry reminder job', 'Daily job that emails recipients whose card expires in 30 days.', 'S4', ['R5']),
      task('T7', 'Add the gift card report to the admin dashboard', 'Report of gift cards sold, redeemed and outstanding per month.', 'S5'),
      task('T8', 'Generate secure gift card codes', 'Generate 16-character codes from a cryptographic random source and reject collisions.', 'S6', ['R4']),
    ];
    expect(items.filter((item) => 'parent_id' in item)).toHaveLength(14);
    expect(items.flatMap((item) => ('links' in item ? item.links : []))).toHaveLength(12);

    const recorded = await call(client, 'create_item', { items });
    expect(recorded.result.isError).toBeFalsy();
    expect(recorded.data).toMatchObject({ created: true });
    const created = recorded.data!.items as { key: string; id: string; verdict: string }[];
    expect(created.map(({ key, id }) => `${key}=${id}`)).toEqual([
      ...[1, 2, 3, 4, 5, 6].map((n) => `R${n}=REQ-000${n}`),
      ...[1, 2, 3, 4, 5, 6].map((n) => `S${n}=US-000${n}`),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `T${n}=TASK-000${n}`),
    ]);
    expect(created.every(({ verdict }) => ['new', 'related', 'duplicate'].includes(verdict))).toBe(true);

    const details = await call(client, 'get_item', { ids: created.map(({ id }) => id) });
    const stored = details.data!.items as { item: { parent_id: string | null }; links: { outgoing: unknown[] } }[];
    expect(stored.filter(({ item }) => item.parent_id !== null)).toHaveLength(14);
    expect(stored.flatMap(({ links }) => links.outgoing)).toHaveLength(12);
    expect(stored[12]!.item.parent_id).toBe('US-0001');
    expect(stored[6]!.item.parent_id).toBe(epicId);
  });

  it('create_item takes either the item fields or items; full:true returns full batch items', async () => {
    const repo = tempRepo();
    const client = await connect({ cwd: repo });
    const { tools } = await client.listTools();
    const schema = tools.find((tool) => tool.name === 'create_item')!.inputSchema;
    expect(schema.properties).toHaveProperty('items');
    expect(schema.required ?? []).toEqual([]);

    const both = await call(client, 'create_item', { kind: 'task', title: 'Single', items: [{ kind: 'task', title: 'Batch' }] });
    expect(both.text).toBe("INVALID_INPUT: Pass either one item's fields or items, not both; move title, kind into the items entries.");
    const invalid = await call(client, 'create_item', { items: [{ kind: 'task' }, { kind: 'story', title: 'Orphan', parent_id: '@missing' }] });
    expect(invalid.text).toBe(
      'INVALID_INPUT: Nothing written: 2 problems in the batch: items[0]: title: Invalid input: expected string, received undefined; items[1]: parent_id "@missing": no entry of this batch has key "@missing"',
    );

    const full = await call(client, 'create_item', { items: [{ key: 'a', kind: 'task', title: 'Write the importer' }], full: true });
    expect(full.data).toMatchObject({ created: true, items: [{ key: 'a', item: { id: 'TASK-0001', recorded_via: 'test-client' }, warnings: [], similar: [] }] });
    expect(await call(client, 'list_items', {})).toMatchObject({ data: { total: 1 } });
  });

  it('answers reads on an uninitialized project without creating it', async () => {
    const repo = tempRepo();
    const client = await connect({ cwd: repo });
    const listed = await call(client, 'list_items', {});
    expect(listed.data).toEqual({ initialized: false, root: repo });
    expect(existsSync(join(repo, '.overseer'))).toBe(false);
  });

  it('refuses writes when the project resolves to the home directory', async () => {
    const home = tempDir('ovs-home-');
    vi.stubEnv('HOME', home);
    const repo = tempRepo();
    // Only the repo is on: the home guard still answers first, so agents retry with project_dir instead of stopping.
    const client = await connect({ cwd: home, env: { OVERSEER_CONFIG_DIR: tempUserConfig({ enabled_projects: [repo] }) } });
    const created = await call(client, 'create_item', { kind: 'task', title: 'Anything' });
    expect(created.result.isError).toBe(true);
    expect(created.text).toBe(
      `NO_PROJECT: No project detected (resolved to ${home}). Run inside a project folder, or pass project_dir / --project.`,
    );
    expect(existsSync(join(home, '.overseer'))).toBe(false);

    const retried = await call(client, 'create_item', { kind: 'task', title: 'Anything', project_dir: repo });
    expect(retried.data).toMatchObject({ created: true, id: 'TASK-0001' });
    expect((await call(client, 'create_item', { kind: 'task', title: 'x', project_dir: 'relative/path' })).text).toMatch(/^INVALID_INPUT: /);
  });

  it('reports invalid tool arguments as INVALID_INPUT naming the field', async () => {
    const repo = tempRepo();
    const client = await connect({ cwd: repo });
    const kind = await call(client, 'find_similar', { text: 'probe', kind: 'nope' });
    expect(kind.result.isError).toBe(true);
    expect(kind.text).toBe('INVALID_INPUT: kind: Invalid option: expected one of "requirement"|"epic"|"story"|"task"|"bug"');
    const id = await call(client, 'get_item', { id: 42 });
    expect(id.result.isError).toBe(true);
    expect(id.text).toBe('INVALID_INPUT: id: Invalid input: expected string, received number');
    const title = await call(client, 'create_item', { kind: 'task' });
    expect(title.result.isError).toBe(true);
    expect(title.text).toBe('INVALID_INPUT: title: Invalid input: expected string, received undefined');
    expect(existsSync(join(repo, '.overseer'))).toBe(false);

    // Errors overseer raises itself and valid calls are unchanged.
    expect((await call(client, 'create_item', { kind: 'task', title: 'Valid' })).data).toMatchObject({ created: true, id: 'TASK-0001' });
    expect((await call(client, 'get_item', { id: 'TASK-0999' })).text).toBe('NOT_FOUND: No item with id TASK-0999.');
  });

  it('uses the first client root when the client advertises roots', async () => {
    const home = tempDir('ovs-home-');
    vi.stubEnv('HOME', home);
    const repo = tempRepo();
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
    const client = await connect({ cwd: home }, [join(repo, 'packages', 'app')]);
    const created = await call(client, 'create_item', { kind: 'epic', title: 'Onboarding' });
    expect(created.data).toMatchObject({ created: true });
    expect(existsSync(join(repo, '.overseer', 'overseer.db'))).toBe(true);
  });

  it('is off in projects the user has not turned on, checked on every call', async () => {
    const repo = tempRepo();
    const config = tempUserConfig({});
    const rules = (value: object) => writeFileSync(join(config, 'config.json'), JSON.stringify(value));
    const client = await connect({ cwd: repo, env: { OVERSEER_CONFIG_DIR: config } });
    const off = await call(client, 'create_item', { kind: 'task', title: 'First' });
    expect(off.result.isError).toBe(true);
    expect(off.text).toBe(
      `DISABLED: overseer is off for ${repo} (overseer is off by default and works only in projects the user turned on). Do not use overseer in this project; to turn it on, the user runs: overseer enable --project ${repo}`,
    );
    expect((await call(client, 'list_items', {})).text).toMatch(/^DISABLED: /);
    expect((await call(client, 'open_board', { open_browser: false })).text).toMatch(/^DISABLED: /);
    expect(existsSync(join(repo, '.overseer'))).toBe(false);

    rules({ enabled_projects: [repo] });
    expect((await call(client, 'create_item', { kind: 'task', title: 'First' })).data).toMatchObject({ created: true });
    // The service is cached now; the switch is still read per call. A folder listed twice counts as disabled.
    rules({ enabled_projects: [repo], disabled_projects: [repo] });
    expect((await call(client, 'list_items', {})).text).toBe(
      `DISABLED: overseer is off for ${repo}. Do not use overseer in this project; to turn it on, the user runs: overseer enable --project ${repo}`,
    );
  });

  it('closes the databases and boards it opened when the connection closes', async () => {
    const repo = tempRepo();
    const client = await connect({ cwd: repo });
    await call(client, 'create_item', { kind: 'task', title: 'Close everything' });
    const board = await call(client, 'open_board', { port: await freePort(), open_browser: false });
    const port = Number(new URL(String(board.data!.url)).port);
    expect(await listening(port)).toBe(true);
    // WAL mode: SQLite removes the -wal and -shm files when the last connection to the database closes (the service's and
    // the board's). This process keeps running, so nothing else closes them.
    const db = join(repo, '.overseer', 'overseer.db');
    expect(existsSync(`${db}-wal`)).toBe(true);

    await client.close();
    await vi.waitFor(async () => expect(await listening(port)).toBe(false));
    expect(existsSync(`${db}-wal`)).toBe(false);
    expect(existsSync(`${db}-shm`)).toBe(false);
  });
});

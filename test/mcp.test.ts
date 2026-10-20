import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type CallToolResult, ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer, INSTRUCTIONS, type McpServerOptions } from '../src/mcp/server.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
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
  it('lists exactly the twelve tools and sends the instructions', async () => {
    const client = await connect({ cwd: tempRepo() });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'check_coverage',
        'create_item',
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
});

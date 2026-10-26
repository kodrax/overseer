import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import type { ImportResult } from '../src/core/import.js';
import { OverseerService } from '../src/core/service.js';
import { createMcpServer } from '../src/mcp/server.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { ctx, openService } from './helpers/service.js';
import { tempRepo, tempUserConfig } from './helpers/tmp.js';

/*
 * Fixtures in test/fixtures/import/ copy the response shapes of the MCP servers the overseer-import skill uses:
 * - github-list-issues.json: github/github-mcp-server list_issues (GraphQL) → MinimalIssuesResponse {issues, totalCount,
 *   pageInfo} of MinimalIssue (state OPEN/CLOSED, labels and assignees as strings, issue_type as a string), from
 *   https://github.com/github/github-mcp-server/blob/main/pkg/github/minimal_types.go (MinimalIssue,
 *   fragmentToMinimalIssue, MinimalIssuesResponse) and pkg/github/__toolsnaps__/list_issues_output.snap.
 * - github-list-issues-rest.json: list_issues of github-mcp-server v0.1.0, which returned the REST issues of
 *   client.Issues.ListByRepo as-is (pull requests included, with `pull_request`):
 *   https://github.com/github/github-mcp-server/blob/v0.1.0/pkg/github/issues.go (listIssues) and
 *   https://docs.github.com/en/rest/issues/issues#list-repository-issues (labels {name}, assignees {login},
 *   milestone {title}, type {name}).
 * - gitlab-list-work-items.json, gitlab-get-work-item.json, gitlab-get-work-item-epic.json: zereight/gitlab-mcp
 *   list_work_items → {items, pageInfo} and get_work_item (widgets flattened; the hierarchy widget's parent as
 *   parent {iid, title, type, project, webUrl}), from https://github.com/zereight/gitlab-mcp/blob/main/index.ts
 *   (listWorkItems, getWorkItem); work item state is the GraphQL WorkItemState OPEN/CLOSED
 *   (https://docs.gitlab.com/api/graphql/reference/#workitemstate).
 * - gitlab-list-issues.json: zereight/gitlab-mcp list_issues (project_id, scope all, state all, page/per_page), as
 *   2.3.11 answers it (build/index.js listIssues and the "list_issues" handler, build/schemas.js GitLabIssueSchema):
 *   the JSON text of an array of GitLab REST issues, ids coerced to strings, description null when empty, state
 *   opened/closed, labels as strings, assignees and author {username, id, name, avatar_url, web_url}, milestone {id,
 *   iid, title, description, state, web_url} or null, references {short, relative, full}, issue_type
 *   issue|incident|test_case|task; the TASK-0073 pilot got the same shape (with numeric ids, also accepted).
 */
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'import', name), 'utf8');

async function cli(cwd: string, args: string[], stdin?: string) {
  let out = '';
  const io = {
    stdout: { write: (chunk: string) => (out += chunk) },
    stderr: { write: () => true },
    stdin: Readable.from(stdin === undefined ? [] : [stdin]),
  };
  const code = await runCli(args, io, { embedder: new HashEmbedder(), env: { OVERSEER_CONFIG_DIR: tempUserConfig() }, cwd });
  return { code, out, json: <T,>(): T => JSON.parse(out) };
}

const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

async function mcpImport(cwd: string, args: Record<string, unknown>) {
  const server = createMcpServer({ embedder: new HashEmbedder(), cwd, env: { OVERSEER_CONFIG_DIR: tempUserConfig() } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  clients.push(client);
  const result = (await client.callTool({ name: 'import_items', arguments: args })) as CallToolResult;
  const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
  return { isError: result.isError === true, text, data: result.structuredContent as unknown as ImportResult };
}

/** Board state of a project for comparing two imports (timestamps aside). */
function board(root: string) {
  const service = OverseerService.open({ root, create: false, embedder: new HashEmbedder() })!;
  const { items } = service.listItems({ include_closed: true });
  const state = items.map((summary) => {
    const item = service.getItem(summary.id).item;
    return [item.id, item.kind, item.status, item.title, item.description, item.tags, item.assignee, item.milestone, item.parent_id, item.external_ref, item.external_url, item.external_state];
  });
  service.close();
  return state;
}

const withoutTime = (result: ImportResult) => ({ ...result, last_import_at: undefined });

describe('import of raw GitHub MCP responses', () => {
  it('maps list_issues piped to overseer import: owner/repo#N, issue types, pull requests skipped and warned', async () => {
    const repo = tempRepo();
    const args = ['import', '-', '--source', 'github', '--repo', 'acme/demo', '--json'];
    const listed = await cli(repo, args, fixture('github-list-issues.json'));
    expect(listed.code).toBe(0);
    expect(listed.json<ImportResult>()).toMatchObject({ created: ['EPIC-0001', 'BUG-0001', 'US-0001', 'TASK-0001'], warnings: [] });
    const show = async (id: string) => (await cli(repo, ['show', id, '--json'])).json<{ item: Record<string, unknown> }>().item;
    expect(await show('BUG-0001')).toMatchObject({
      kind: 'bug',
      status: 'backlog',
      external_ref: 'github:acme/demo#7',
      external_url: 'https://github.com/acme/demo/issues/7',
      external_state: 'open',
      tags: ['needs-triage'],
      assignee: 'hubot',
    });
    expect(await show('US-0001')).toMatchObject({ kind: 'story', external_ref: 'github:acme/demo#8' });
    expect(await show('TASK-0001')).toMatchObject({ kind: 'task', status: 'done', external_ref: 'github:acme/demo#9', external_state: 'closed' });
    expect(await show('EPIC-0001')).toMatchObject({ kind: 'epic', status: 'open', external_ref: 'github:acme/demo#1' });

    writeFileSync(join(repo, 'rest.json'), fixture('github-list-issues-rest.json'));
    const rest = await cli(repo, ['import', 'rest.json', '--source', 'github', '--repo', 'acme/demo']);
    expect(rest.code).toBe(0);
    expect(rest.out).toContain('created: 1  BUG-0002');
    expect(rest.out).toContain('warning: acme/demo#11: pull request skipped.');
    expect(await show('BUG-0002')).toMatchObject({
      external_ref: 'github:acme/demo#10',
      external_url: 'https://github.com/acme/demo/issues/10',
      tags: ['regression'],
      assignee: 'hubot',
      milestone: 'v1.0',
    });

    const again = await cli(repo, args, fixture('github-list-issues.json'));
    expect(again.json<ImportResult>()).toMatchObject({ created: [], updated: [], unchanged: ['EPIC-0001', 'BUG-0001', 'US-0001', 'TASK-0001'] });
  });
});

describe('import of raw GitLab MCP responses', () => {
  it('maps list_work_items and get_work_item: group/project#IID, work item types, opened → open, hierarchy parent', async () => {
    const service = openService();
    const listed = await service.importItems({ source: 'gitlab', repo: 'acme/demo', payload: JSON.parse(fixture('gitlab-list-work-items.json')) }, ctx);
    expect(listed).toMatchObject({ created: ['US-0001', 'TASK-0001', 'BUG-0001', 'REQ-0001'], warnings: [] });
    const item = (id: string) => service.getItem(id).item;
    // Type Issue carries no type hint: the labels decide (feature → story).
    expect(item('US-0001')).toMatchObject({
      kind: 'story',
      status: 'backlog',
      external_ref: 'gitlab:acme/demo#1',
      external_url: 'https://gitlab.com/acme/demo/-/work_items/1',
      external_state: 'open',
      tags: ['feature'],
      assignee: 'alice',
      milestone: 'M1',
    });
    expect(item('TASK-0001')).toMatchObject({ kind: 'task', status: 'backlog', external_ref: 'gitlab:acme/demo#2', parent_id: null });
    expect(item('BUG-0001')).toMatchObject({ kind: 'bug', status: 'done', external_ref: 'gitlab:acme/demo#3', external_state: 'closed' });
    expect(item('REQ-0001')).toMatchObject({ kind: 'requirement', status: 'approved', req_type: 'non_functional', external_ref: 'gitlab:acme/demo#4' });

    const detail = await service.importItems({ source: 'gitlab', repo: 'acme/demo', payload: JSON.parse(fixture('gitlab-get-work-item.json')) }, ctx);
    expect(detail).toMatchObject({ created: [], updated: ['TASK-0001'], warnings: [] });
    expect(item('TASK-0001')).toMatchObject({
      description: 'Write the cart to localStorage on every change.',
      tags: ['frontend'],
      assignee: 'bob',
      milestone: 'M1',
      parent_id: 'US-0001',
    });

    const epic = await service.importItems({ source: 'gitlab', repo: 'acme/demo', payload: JSON.parse(fixture('gitlab-get-work-item-epic.json')) }, ctx);
    expect(epic.created).toEqual(['EPIC-0001']);
    expect(item('EPIC-0001')).toMatchObject({ kind: 'epic', status: 'open', external_ref: 'gitlab:acme#5' });

    // GitLab REST issues (and older work item payloads) spell the open state "opened".
    const opened = { ...JSON.parse(fixture('gitlab-get-work-item.json')), iid: '6', state: 'opened', parent: null, webUrl: 'https://gitlab.com/acme/demo/-/work_items/6' };
    const reopened = await service.importItems({ source: 'gitlab', repo: 'acme/demo', payload: opened }, ctx);
    expect(reopened.created).toEqual(['TASK-0002']);
    expect(item('TASK-0002')).toMatchObject({ status: 'backlog', external_state: 'open', external_ref: 'gitlab:acme/demo#6' });
  });

  it('maps list_issues REST issues: description as body, group/project#IID, issue types, first assignee, milestone title (BUG-0018)', async () => {
    const repo = tempRepo();
    const listed = await cli(repo, ['import', '-', '--source', 'gitlab', '--repo', 'acme/demo', '--json'], fixture('gitlab-list-issues.json'));
    expect(listed.code).toBe(0);
    expect(listed.json<ImportResult>()).toMatchObject({ created: ['US-0001', 'TASK-0001', 'BUG-0001'], warnings: [] });
    expect(board(repo)).toEqual([
      ['BUG-0001', 'bug', 'done', 'Checkout fails on Safari', '', [], 'bob', null, null, 'gitlab:acme/demo#3', 'https://gitlab.com/acme/demo/-/issues/3', 'closed'],
      ['TASK-0001', 'task', 'backlog', 'Persist the cart in local storage', 'Write the cart to localStorage on every change.', ['frontend'], null, null, null, 'gitlab:acme/demo#2', 'https://gitlab.com/acme/demo/-/issues/2', 'open'],
      ['US-0001', 'story', 'backlog', 'Checkout as a guest', 'As a shopper I check out without an account.', ['feature', 'priority: must'], 'alice', 'M1', null, 'gitlab:acme/demo#1', 'https://gitlab.com/acme/demo/-/work_items/1', 'open'],
    ]);

    // The same issues over import_items, as the parsed answer: numeric ids, label objects ({name}, with_labels_details)
    // and an assignee without a username (gitlab-mcp's GitLabUserSchema leaves it optional) map alike.
    const service = openService();
    const issues = JSON.parse(fixture('gitlab-list-issues.json'));
    issues[0] = { ...issues[0], id: 207992601, iid: 1, project_id: 88083972, labels: [{ id: '1', name: 'feature', color: '#fff' }, 'priority: must'], assignees: [{ id: '9' }, ...issues[0].assignees] };
    const result = await service.importItems({ source: 'gitlab', repo: 'acme/demo', payload: issues }, ctx);
    expect(result).toMatchObject({ created: ['US-0001', 'TASK-0001', 'BUG-0001'], warnings: [] });
    expect(service.getItem('US-0001').item).toMatchObject({ description: 'As a shopper I check out without an account.', tags: ['feature', 'priority: must'], assignee: 'alice', external_ref: 'gitlab:acme/demo#1' });

    // A REST issue answer is GitLab's, whatever source is given.
    const mismatch = await cli(tempRepo(), ['import', '-', '--source', 'github', '--repo', 'acme/demo', '--json'], fixture('gitlab-list-issues.json'));
    expect(mismatch.json()).toEqual({ error: { code: 'INVALID_INPUT', message: 'The payload is a GitLab response but source is github.' } });
  });
});

describe('import_items payload', () => {
  it('gives the same result and board as the CLI for the same raw payload', async () => {
    const viaCli = tempRepo();
    const viaMcp = tempRepo();
    const steps: [source: string, repo: string, file: string][] = [
      ['github', 'acme/demo', 'github-list-issues.json'],
      ['github', 'acme/demo', 'github-list-issues-rest.json'],
      ['gitlab', 'acme/demo', 'gitlab-list-work-items.json'],
      ['gitlab', 'acme/demo', 'gitlab-get-work-item.json'],
      ['gitlab', 'acme/demo', 'gitlab-get-work-item-epic.json'],
    ];
    for (const [index, [source, repo, file]] of steps.entries()) {
      const fromCli = await cli(viaCli, ['import', '-', '--source', source, '--repo', repo, '--json'], fixture(file));
      expect(fromCli.code).toBe(0);
      // The payload may be the parsed response or the MCP tool's JSON text as returned.
      const payload = index % 2 === 0 ? JSON.parse(fixture(file)) : fixture(file);
      const fromMcp = await mcpImport(viaMcp, { source, repo, payload });
      expect(fromMcp.isError).toBe(false);
      expect(withoutTime(fromMcp.data)).toEqual(withoutTime(fromCli.json<ImportResult>()));
    }
    expect(board(viaMcp)).toEqual(board(viaCli));
    expect(board(viaCli)).toHaveLength(10);
  });

  it('takes exactly one of items and payload', async () => {
    const repo = tempRepo();
    const issue = { external_id: 'acme/demo#7', url: 'https://github.com/acme/demo/issues/7', title: 'Login fails', state: 'open' };
    const both = await mcpImport(repo, { source: 'github', repo: 'acme/demo', items: [issue], payload: JSON.parse(fixture('github-list-issues.json')) });
    expect(both).toMatchObject({ isError: true, text: 'INVALID_INPUT: Pass exactly one of items (ImportItems) or payload (a raw GitHub/GitLab MCP response).' });
    const neither = await mcpImport(repo, { source: 'github', repo: 'acme/demo' });
    expect(neither.text).toBe('INVALID_INPUT: Pass exactly one of items (ImportItems) or payload (a raw GitHub/GitLab MCP response).');
  });
});

describe('import of an unknown format', () => {
  const accepted = /^Unrecognized import format; accepted formats: ImportItems .*GitHub MCP list_issues.*GitLab MCP list_issues.*list_work_items.*get_work_item/;

  it('fails with INVALID_INPUT naming the accepted formats and writes nothing (CLI)', async () => {
    const repo = tempRepo();
    for (const input of [{ data: { repository: { issues: { nodes: [] } } } }, [{ id: 1, name: 'not an issue' }], 42]) {
      const result = await cli(repo, ['import', '-', '--source', 'github', '--repo', 'acme/demo', '--json'], JSON.stringify(input));
      expect(result.code).toBe(1);
      const { error } = result.json<{ error: { code: string; message: string } }>();
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toMatch(accepted);
    }
    expect(existsSync(join(repo, '.overseer'))).toBe(false);

    const mismatch = await cli(repo, ['import', '-', '--source', 'gitlab', '--repo', 'acme/demo', '--json'], fixture('github-list-issues.json'));
    expect(mismatch.json()).toEqual({ error: { code: 'INVALID_INPUT', message: 'The payload is a GitHub response but source is gitlab.' } });
    expect(existsSync(join(repo, '.overseer'))).toBe(false);
  });

  it('fails with INVALID_INPUT naming the accepted formats and writes nothing (import_items)', async () => {
    const service = openService();
    await expect(service.importItems({ source: 'gitlab', repo: 'acme/demo', payload: { workItems: [{ iid: '1' }] } }, ctx)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringMatching(accepted),
    });
    // One bad entry rejects the whole payload.
    const list = JSON.parse(fixture('gitlab-list-work-items.json'));
    list.items.push({ iid: '9' });
    await expect(service.importItems({ source: 'gitlab', repo: 'acme/demo', payload: list }, ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(service.listItems({ include_closed: true }).total).toBe(0);
    expect(service.lastImports()).toEqual([]);
  });
});

describe('import of ImportItems', () => {
  it('keeps the items path: arrays and {"items"} go to items validation, not format detection', async () => {
    const repo = tempRepo();
    const invalid = [{ external_id: 'acme/demo#7', url: 'https://github.com/acme/demo/issues/7', title: 'Login fails', state: 'merged' }];
    for (const input of [invalid, { items: invalid }]) {
      const result = await cli(repo, ['import', '-', '--source', 'github', '--repo', 'acme/demo', '--json'], JSON.stringify(input));
      expect(result.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/^items\.0\.state: /) });
    }
    const empty = await cli(repo, ['import', '-', '--source', 'github', '--repo', 'acme/demo', '--json'], '[]');
    expect(empty.json<{ error: { message: string } }>().error.message).toMatch(/^items: /);
  });
});

describe('re-import without a body', () => {
  it('keeps the description when the source omits the body and clears it on an explicit empty body', async () => {
    const service = openService();
    const descriptionEvents = () =>
      service.getItem('TASK-0001', { history: true }).history!.filter((event) => event.field === 'description');
    // get_work_item carries the description; list_work_items has none (zereight/gitlab-mcp listWorkItems).
    await service.importItems({ source: 'gitlab', repo: 'acme/demo', payload: JSON.parse(fixture('gitlab-get-work-item.json')) }, ctx);
    const listed = await service.importItems({ source: 'gitlab', repo: 'acme/demo', payload: JSON.parse(fixture('gitlab-list-work-items.json')) }, ctx);
    expect(listed.updated).toContain('TASK-0001');
    expect(service.getItem('TASK-0001').item).toMatchObject({ description: 'Write the cart to localStorage on every change.', tags: [] });
    expect(descriptionEvents()).toEqual([]);

    const item = { external_id: 'acme/demo#2', url: 'https://gitlab.com/acme/demo/-/work_items/2', title: 'Persist the cart in local storage', state: 'open' };
    const withoutBody = await service.importItems({ source: 'gitlab', repo: 'acme/demo', items: [item] }, ctx);
    expect(withoutBody.unchanged).toEqual(['TASK-0001']);
    expect(service.getItem('TASK-0001').item.description).toBe('Write the cart to localStorage on every change.');

    const emptied = await service.importItems({ source: 'gitlab', repo: 'acme/demo', items: [{ ...item, body: '' }] }, ctx);
    expect(emptied.updated).toEqual(['TASK-0001']);
    expect(service.getItem('TASK-0001').item.description).toBe('');
    expect(descriptionEvents()).toMatchObject([{ action: 'update', old_value: 'Write the cart to localStorage on every change.', new_value: '' }]);
  });
});

describe('remote closures and deletions in payloads and the CLI (TASK-0021)', () => {
  it('maps GitHub state_reason and GraphQL stateReason so not planned and duplicate closures cancel (AC3)', async () => {
    const service = openService();
    const issues = [
      { number: 1, title: 'Dropped', state: 'CLOSED', state_reason: 'not_planned' },
      { number: 2, title: 'Same as #1', state: 'CLOSED', stateReason: 'DUPLICATE' },
      { number: 3, title: 'Shipped', state: 'closed', state_reason: 'completed', labels: [{ name: 'docs' }] },
    ];
    const result = await service.importItems({ source: 'github', repo: 'acme/demo', payload: { issues } }, ctx);
    expect(result.created).toEqual(['TASK-0001', 'TASK-0002', 'TASK-0003']);
    expect(result.created.map((id) => service.getItem(id).item.status)).toEqual(['cancelled', 'cancelled', 'done']);
  });

  it('passes "deleted" from the CLI object forms and prints the deleted items (AC2)', async () => {
    const repo = tempRepo();
    const list = JSON.parse(fixture('github-list-issues.json'));
    expect((await cli(repo, ['import', '-', '--source', 'github', '--repo', 'acme/demo', '--json'], fixture('github-list-issues.json'))).code).toBe(0);
    // TASK-0001 is acme/demo#9, BUG-0001 acme/demo#7.
    const alone = await cli(repo, ['import', '-', '--source', 'github', '--repo', 'acme/demo'], JSON.stringify({ deleted: ['acme/demo#9', 'acme/demo#404'] }));
    expect(alone.code).toBe(0);
    expect(alone.out).toBe('created: 0\nupdated: 0\nunchanged: 0\ndeleted: 1  TASK-0001\nwarning: acme/demo#404: deleted remotely but no item has this issue; nothing deleted.\n');

    const page = { ...list, issues: list.issues.filter((entry: { number: number }) => entry.number !== 7 && entry.number !== 9), deleted: ['acme/demo#7'] };
    const withPage = await cli(repo, ['import', '-', '--source', 'github', '--repo', 'acme/demo', '--json'], JSON.stringify(page));
    expect(withPage.json<ImportResult>()).toMatchObject({ created: [], updated: [], deleted: ['BUG-0001'], warnings: [] });

    const items = [{ external_id: 'acme/demo#20', url: 'https://github.com/acme/demo/issues/20', title: 'New', state: 'open' }];
    const withItems = await cli(repo, ['import', '-', '--source', 'github', '--repo', 'acme/demo', '--json'], JSON.stringify({ items, deleted: ['acme/demo#8'] }));
    expect(withItems.json<ImportResult>()).toMatchObject({ created: ['TASK-0002'], deleted: ['US-0001'] });
    expect(board(repo).map(([id]) => id)).toEqual(['EPIC-0001', 'TASK-0002']);
  });

  it('takes deleted in import_items, which is marked destructive (AC2)', async () => {
    const repo = tempRepo();
    const issue = { external_id: 'acme/demo#7', url: 'https://github.com/acme/demo/issues/7', title: 'Login fails', state: 'open' };
    expect((await mcpImport(repo, { source: 'github', repo: 'acme/demo', items: [issue] })).data.created).toEqual(['TASK-0001']);
    const deleted = await mcpImport(repo, { source: 'github', repo: 'acme/demo', items: [], deleted: ['acme/demo#7'] });
    expect(deleted).toMatchObject({ isError: false, data: { created: [], updated: [], unchanged: [], deleted: ['TASK-0001'], warnings: [] } });
    const { tools } = await clients[0]!.listTools();
    expect(tools.find((tool) => tool.name === 'import_items')!.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
  });
});

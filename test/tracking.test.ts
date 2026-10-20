import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { isOverseerError } from '../src/core/errors.js';
import { inspectTracking, type TrackingSetup } from '../src/core/tracking.js';
import { tempDir, tempUserConfig } from './helpers/tmp.js';

/*
 * Bundles in test/fixtures/tracking/ copy the text answers of the MCP tools that `overseer sync inspect` reads.
 * - github-bundle.json: github/github-mcp-server (https://github.com/github/github-mcp-server, main as of 2026-10-15):
 *   - list_label and get_label: pkg/github/labels.go, pkg/github/__toolsnaps__/list_label.snap and get_label.snap
 *     ({labels: [{name, color, description}], totalCount, pageInfo} and {name, color, description}).
 *   - list_issue_types: pkg/github/issues.go (ListIssueTypes) and __toolsnaps__/list_issue_types.snap
 *     ([{id, name, description, color, is_enabled}]), stored as the tool's JSON text.
 *   - ui_get method milestones: pkg/github/ui_tools.go and __toolsnaps__/ui_get.snap
 *     ({milestones: [{number, title, description, state, open_issues, due_on}], totalCount, has_more}); the only
 *     milestone tool, in the default context toolset with MCP Apps visibility "app".
 *   - issue_read method get_sub_issues: pkg/github/issues.go, __toolsnaps__/issue_read.snap and
 *     pkg/github/typed_consolidated_issue_outputs_test.go (REST sub-issues [{id, number, title, body, …}]); method get
 *     answers the issue with has_parent / has_children, method get_parent {parent: {…} | null}.
 *   - projects_list method list_projects: pkg/github/projects.go (listProjects) and __toolsnaps__/projects_list.snap
 *     ({projects: [MinimalProject {id, node_id, number, title, …}], pageInfo}).
 * - gitlab-bundle.json: zereight/gitlab-mcp (https://github.com/zereight/gitlab-mcp, main as of 2026-10-20):
 *   - list_labels: index.ts (listLabels, the REST project labels as JSON text) and schemas.ts GitLabLabelSchema;
 *     REST shape https://docs.gitlab.com/api/labels/.
 *   - list_milestones: index.ts (listProjectMilestones) and schemas.ts GitLabMilestonesSchema;
 *     https://docs.gitlab.com/api/milestones/.
 *   - list_work_item_statuses: index.ts (listIssueStatuses) → {work_item_type, statuses_available, statuses,
 *     supported_conversion_types?, allowed_child_types?, allowed_parent_types?}, one answer per work item type.
 *   - gitlab_api_request GET projects/<id>/boards: tools/gitlab-api-request.ts (the REST body as JSON text; explicit
 *     `api` toolset) with the boards answer of https://docs.gitlab.com/api/boards/ ([{id, name, project, milestone,
 *     lists}]); gitlab-mcp has no board tool.
 */
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'tracking', name), 'utf8');
const bundle = (name: string): Record<string, unknown> => JSON.parse(fixture(name));

async function cli(args: string[], options: { stdin?: string; cwd?: string; config?: string } = {}) {
  let out = '';
  const io = {
    stdout: { write: (chunk: string) => (out += chunk) },
    stderr: { write: () => true },
    stdin: Readable.from(options.stdin === undefined ? [] : [options.stdin]),
  };
  const cwd = options.cwd ?? tempDir();
  const code = await runCli(args, io, { env: { OVERSEER_CONFIG_DIR: options.config ?? tempUserConfig() }, cwd });
  return { code, out, json: <T,>(): T => JSON.parse(out) };
}

function invalidInput(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isOverseerError(error) && error.code === 'INVALID_INPUT') return error.message;
    throw error;
  }
  throw new Error('expected INVALID_INPUT');
}

/** The keys of github-bundle.json, with the values the order test shuffles. */
interface GithubFixture {
  list_label: { labels: unknown[] }[];
  get_label: unknown;
  list_issue_types: string;
  ui_get: { milestones: unknown[] };
  issue_read: unknown;
  projects_list: unknown;
}

const GITHUB_SETUP: TrackingSetup = {
  labels: ['bug', 'Documentation', 'enhancement', 'priority: high'],
  issue_types: ['Bug', 'Feature', 'Task'],
  milestones: ['v1.0', 'v1.1'],
  sub_issues: true,
  boards: ['Bug triage', 'Roadmap'],
  warnings: [],
};

const GITLAB_SETUP: TrackingSetup = {
  labels: ['bug', 'feature', 'workflow::doing'],
  issue_types: ['Incident', 'Issue', 'Task'],
  milestones: ['Sprint 1', 'Sprint 2'],
  sub_issues: true,
  boards: ['Development', 'Workflow'],
  warnings: [],
};

describe('sync inspect', () => {
  it('summarises piped github-mcp-server responses with names sorted and without duplicates', async () => {
    const run = await cli(['sync', 'inspect', '-', '--source', 'github', '--json'], { stdin: fixture('github-bundle.json') });
    expect(run.code).toBe(0);
    expect(run.json()).toEqual(GITHUB_SETUP);
    expect(Object.keys(run.json<object>())).toEqual(['labels', 'issue_types', 'milestones', 'sub_issues', 'boards', 'warnings']);

    // The disabled Initiative type cannot be set on issues, so it is not listed.
    expect(inspectTracking(bundle('github-bundle.json'), 'github').issue_types).not.toContain('Initiative');
  });

  it('reads the bundle from a file and prints it as fields', async () => {
    const cwd = tempDir();
    const file = join(cwd, 'bundle.json');
    writeFileSync(file, fixture('github-bundle.json'));
    const run = await cli(['sync', 'inspect', 'bundle.json', '--source', 'github'], { cwd });
    expect(run.code).toBe(0);
    expect(run.out).toBe(
      [
        'labels:       bug, Documentation, enhancement, priority: high',
        'issue_types:  Bug, Feature, Task',
        'milestones:   v1.0, v1.1',
        'sub_issues:   yes',
        'boards:       Bug triage, Roadmap',
        '',
      ].join('\n'),
    );
  });

  it('summarises zereight/gitlab-mcp responses, with work item types and parent/child support, in the same structure', async () => {
    const run = await cli(['sync', 'inspect', '-', '--source', 'gitlab', '--json'], { stdin: fixture('gitlab-bundle.json') });
    expect(run.code).toBe(0);
    expect(run.json()).toEqual(GITLAB_SETUP);
    expect(Object.keys(run.json<object>())).toEqual(Object.keys(GITHUB_SETUP));

    // Work item types without allowed parent or child types cannot nest.
    const flat = { work_item_type: 'Incident', statuses_available: false, statuses: [], supported_conversion_types: ['Issue'] };
    expect(inspectTracking({ list_work_item_statuses: flat }, 'gitlab')).toMatchObject({ issue_types: ['Incident', 'Issue'], sub_issues: false });
  });

  it('reports a missing part as null, not empty, with a warning naming the tool', async () => {
    const github = bundle('github-bundle.json');
    delete github.ui_get;
    const run = await cli(['sync', 'inspect', '-', '--source', 'github', '--json'], { stdin: JSON.stringify(github) });
    expect(run.code).toBe(0);
    expect(run.json()).toEqual({
      ...GITHUB_SETUP,
      milestones: null,
      warnings: ['milestones: unknown, the bundle has no ui_get (method milestones) response.'],
    });
    const text = await cli(['sync', 'inspect', '-', '--source', 'github'], { stdin: JSON.stringify(github) });
    expect(text.out).toContain('milestones:   unknown\n');
    expect(text.out).toContain('warning: milestones: unknown, the bundle has no ui_get (method milestones) response.');

    const { list_label, get_label, ...unlabelled } = bundle('github-bundle.json');
    expect([list_label, get_label]).not.toContain(undefined);
    expect(inspectTracking(unlabelled, 'github')).toMatchObject({
      labels: null,
      warnings: ['labels: unknown, the bundle has no list_label or get_label response.'],
    });
    // An answer without names is known and empty.
    expect(inspectTracking({ ...unlabelled, list_label: { labels: [], totalCount: 0, pageInfo: { hasNextPage: false, hasPreviousPage: false } } }, 'github').labels).toEqual([]);
    // issue_read get without hierarchy flags does not tell whether the repository has sub-issues.
    expect(inspectTracking({ ...bundle('github-bundle.json'), issue_read: { number: 1, title: 'One', state: 'open' } }, 'github')).toMatchObject({
      sub_issues: null,
      warnings: ['sub_issues: unknown, the issue_read responses do not say; add issue_read (method get_sub_issues).'],
    });
    expect(inspectTracking({ ...bundle('github-bundle.json'), issue_read: { parent: null } }, 'github').sub_issues).toBe(true);

    const { gitlab_api_request, list_work_item_statuses, ...gitlab } = bundle('gitlab-bundle.json');
    expect([gitlab_api_request, list_work_item_statuses]).not.toContain(undefined);
    expect(inspectTracking(gitlab, 'gitlab')).toEqual({
      ...GITLAB_SETUP,
      issue_types: null,
      sub_issues: null,
      boards: null,
      warnings: [
        'issue_types: unknown, the bundle has no list_work_item_statuses response.',
        'sub_issues: unknown, the bundle has no list_work_item_statuses response.',
        'boards: unknown, the bundle has no gitlab_api_request (GET projects/<id>/boards) response.',
      ],
    });
  });

  it('prints byte-for-byte the same output for the same data in any order', async () => {
    const github: GithubFixture = JSON.parse(fixture('github-bundle.json'));
    const reordered = {
      projects_list: github.projects_list,
      issue_read: github.issue_read,
      ui_get: { ...github.ui_get, milestones: [...github.ui_get.milestones].reverse() },
      list_issue_types: JSON.stringify([...JSON.parse(github.list_issue_types)].reverse()),
      get_label: github.get_label,
      list_label: [...github.list_label].reverse().map((page) => ({ ...page, labels: [...page.labels].reverse() })),
    };
    const args = ['sync', 'inspect', '-', '--source', 'github', '--json'];
    const first = await cli(args, { stdin: fixture('github-bundle.json') });
    const second = await cli(args, { stdin: JSON.stringify(reordered) });
    expect(second.out).toBe(first.out);

    const gitlab = bundle('gitlab-bundle.json');
    const gitlabReordered = Object.fromEntries(
      Object.entries(gitlab)
        .reverse()
        .map(([key, value]) => [key, Array.isArray(value) ? [...value].reverse() : value]),
    );
    const gitlabArgs = ['sync', 'inspect', '-', '--source', 'gitlab'];
    expect((await cli(gitlabArgs, { stdin: JSON.stringify(gitlabReordered) })).out).toBe((await cli(gitlabArgs, { stdin: fixture('gitlab-bundle.json') })).out);
  });

  it('answers INVALID_INPUT naming the accepted parts for an unknown format', async () => {
    const accepted =
      'accepted parts for github: list_label (labels), get_label (labels), list_issue_types (issue_types), ui_get (milestones), issue_read (sub_issues), projects_list (boards), projects_get (boards).';
    expect(invalidInput(() => inspectTracking({ list_labels: [] }, 'github'))).toBe(`Unknown part "list_labels"; ${accepted}`);
    expect(invalidInput(() => inspectTracking([{ name: 'bug' }], 'github'))).toBe(`The bundle must be a JSON object keyed by MCP tool name; ${accepted}`);
    expect(invalidInput(() => inspectTracking({}, 'github'))).toBe(`The bundle is empty; ${accepted}`);
    expect(invalidInput(() => inspectTracking({ ui_get: { labels: [] } }, 'github'))).toBe(
      `ui_get: not a ui_get (method milestones) response (expected {"milestones": [{"title"}], "totalCount", "has_more"}); ${accepted}`,
    );
    expect(invalidInput(() => inspectTracking({ list_issue_types: 'not json' }, 'github'))).toBe(`list_issue_types: the response is text but not JSON; ${accepted}`);

    // GitHub responses are not GitLab ones: the message lists the GitLab parts.
    const run = await cli(['sync', 'inspect', '-', '--source', 'gitlab', '--json'], { stdin: fixture('github-bundle.json') });
    expect(run.code).toBe(1);
    expect(run.json()).toEqual({
      error: {
        code: 'INVALID_INPUT',
        message:
          'Unknown parts "issue_read", "list_issue_types", "list_label", "projects_list", "ui_get"; accepted parts for gitlab: list_labels (labels), get_label (labels), list_milestones (milestones), list_group_milestones (milestones), get_milestone (milestones), list_work_item_statuses (issue_types, sub_issues), gitlab_api_request (boards).',
      },
    });
    expect(invalidInput(() => inspectTracking({ list_labels: { labels: [] } }, 'gitlab'))).toMatch(/^list_labels: not a list_labels response \(expected \[\{"name", "color", "description"\}\]\); accepted parts for gitlab: /);

    const notJson = await cli(['sync', 'inspect', '-', '--source', 'github', '--json'], { stdin: '{' });
    expect(notJson.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/^Bundle input is not valid JSON/) });
    const source = await cli(['sync', 'inspect', '-', '--source', 'jira', '--json'], { stdin: '{}' });
    expect(source.json()).toEqual({ error: { code: 'INVALID_INPUT', message: 'Invalid source "jira"; valid: github, gitlab.' } });
  });

  it('answers DISABLED in a project that is off', async () => {
    const run = await cli(['sync', 'inspect', '-', '--source', 'github', '--json'], { stdin: fixture('github-bundle.json'), config: tempUserConfig({}) });
    expect([run.code, run.json<{ error: { code: string } }>().error.code]).toEqual([1, 'DISABLED']);
  });
});

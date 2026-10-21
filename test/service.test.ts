import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeCoverage } from '../src/core/coverage.js';
import { VEC_TABLES } from '../src/core/migrations.js';
import { OverseerService, type CreatedResult } from '../src/core/service.js';
import type { CreateInput } from '../src/core/schema.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { ctx, openService } from './helpers/service.js';
import { tempRepo } from './helpers/tmp.js';

async function create(service: OverseerService, input: Omit<CreateInput, 'allow_duplicate'>) {
  const result = await service.createItem({ allow_duplicate: true, ...input }, ctx);
  expect(result.created).toBe(true);
  return (result as CreatedResult).item;
}

const req = (title: string, extra: Partial<CreateInput> = {}) =>
  ({ kind: 'requirement', title, description: `${title} description`, req_type: 'functional', ...extra }) as CreateInput;

describe('IDs', () => {
  it('allocates a padded sequence per kind', async () => {
    const service = openService();
    expect((await create(service, req('Alpha'))).id).toBe('REQ-0001');
    expect((await create(service, req('Beta'))).id).toBe('REQ-0002');
    expect((await create(service, { kind: 'epic', title: 'Accounts' })).id).toBe('EPIC-0001');
    expect((await create(service, { kind: 'story', title: 'Sign in' })).id).toBe('US-0001');
    expect((await create(service, { kind: 'task', title: 'Form' })).id).toBe('TASK-0001');
    expect((await create(service, { kind: 'bug', title: 'Crash' })).id).toBe('BUG-0001');
  });

  it('allocates inside the create transaction across connections', async () => {
    const root = tempRepo();
    const first = openService(root);
    const second = OverseerService.open({ root, create: false, embedder: new HashEmbedder() })!;
    expect((await create(first, req('From first'))).id).toBe('REQ-0001');
    expect((await create(second, req('From second'))).id).toBe('REQ-0002');
    expect((await create(first, req('First again'))).id).toBe('REQ-0003');
  });

  it('accepts lowercase and unpadded references', async () => {
    const service = openService();
    await create(service, req('Alpha'));
    expect(service.getItem('req-1').item.id).toBe('REQ-0001');
  });
});

describe('create defaults and validation', () => {
  it('applies S4 defaults', async () => {
    const service = openService();
    const item = await create(service, req('Password reset'));
    expect(item).toMatchObject({
      status: 'proposed',
      priority: 'should',
      in_backlog: false,
      asked_by: 'Test User',
      source: null,
      recorded_via: 'test',
      coverage: 'untracked',
      acceptance_criteria: [],
      tags: [],
    });
    expect(item.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  });

  it('requires req_type for requirements and rejects fields of other kinds', async () => {
    const service = openService();
    await expect(service.createItem({ kind: 'requirement', title: 'No type' }, ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.createItem({ kind: 'story', title: 'Typed', req_type: 'functional' }, ctx)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(service.createItem({ kind: 'task', title: 'Sev', severity: 'major' }, ctx)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(service.createItem({ ...req('Est'), estimate: 3 }, ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.createItem({ kind: 'story', title: 'x', bogus: 1 }, ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('validates statuses per kind', async () => {
    const service = openService();
    await expect(service.createItem({ ...req('Bad'), status: 'done' }, ctx)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
      message: expect.stringContaining('proposed, approved, implemented'),
    });
    const story = await create(service, { kind: 'story', title: 'Story' });
    await expect(service.updateItem({ id: story.id, status: 'approved' }, ctx)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    // any status → any status of the same kind
    for (const status of ['done', 'backlog', 'review', 'cancelled', 'ready']) {
      expect((await service.updateItem({ id: story.id, status }, ctx)).item.status).toBe(status);
    }
  });

  it('enforces parent rules', async () => {
    const service = openService();
    const epic = await create(service, { kind: 'epic', title: 'Epic' });
    const story = await create(service, { kind: 'story', title: 'Story', parent_id: epic.id });
    const task = await create(service, { kind: 'task', title: 'Task', parent_id: story.id });
    expect(task.parent_id).toBe(story.id);
    expect((await create(service, { kind: 'bug', title: 'Bug in epic', parent_id: epic.id })).parent_id).toBe(epic.id);
    expect((await create(service, { kind: 'bug', title: 'Bug in story', parent_id: story.id })).parent_id).toBe(story.id);
    const parentReq = await create(service, req('Parent requirement'));
    const childReq = await create(service, req('Child requirement', { parent_id: parentReq.id }));

    await expect(service.createItem({ kind: 'task', title: 'T', parent_id: epic.id }, ctx)).rejects.toMatchObject({ code: 'INVALID_PARENT' });
    await expect(service.createItem({ kind: 'story', title: 'S', parent_id: task.id }, ctx)).rejects.toMatchObject({ code: 'INVALID_PARENT' });
    await expect(service.createItem({ kind: 'epic', title: 'E', parent_id: epic.id }, ctx)).rejects.toMatchObject({ code: 'INVALID_PARENT' });
    await expect(service.createItem({ kind: 'bug', title: 'B', parent_id: task.id }, ctx)).rejects.toMatchObject({ code: 'INVALID_PARENT' });
    await expect(service.createItem({ kind: 'story', title: 'S', parent_id: 'EPIC-0099' }, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.updateItem({ id: parentReq.id, parent_id: childReq.id }, ctx)).rejects.toMatchObject({ code: 'INVALID_PARENT' });
  });

  it('enforces relation rules', async () => {
    const service = openService();
    const r1 = await create(service, req('Login'));
    const r2 = await create(service, req('Logout'));
    const story = await create(service, { kind: 'story', title: 'Story' });
    const task = await create(service, { kind: 'task', title: 'Task' });
    const bug = await create(service, { kind: 'bug', title: 'Bug' });
    const epic = await create(service, { kind: 'epic', title: 'Epic' });

    expect(service.link(story.id, 'implements', r1.id, ctx).linked).toBe(true);
    expect(service.link(task.id, 'implements', r1.id, ctx).linked).toBe(true);
    expect(service.link(bug.id, 'affects', r1.id, ctx).linked).toBe(true);
    expect(service.link(bug.id, 'affects', story.id, ctx).linked).toBe(true);
    expect(service.link(r2.id, 'refines', r1.id, ctx).linked).toBe(true);
    expect(service.link(r2.id, 'conflicts_with', r1.id, ctx).linked).toBe(true);
    expect(service.link(r2.id, 'supersedes', r1.id, ctx).linked).toBe(true);
    expect(service.link(r2.id, 'duplicates', r1.id, ctx).linked).toBe(true);
    expect(service.link(epic.id, 'depends_on', task.id, ctx).linked).toBe(true);
    expect(service.link(bug.id, 'relates_to', r2.id, ctx).linked).toBe(true);

    const invalid: [string, string, string][] = [
      [epic.id, 'implements', r1.id],
      [story.id, 'implements', task.id],
      [story.id, 'affects', r1.id],
      [bug.id, 'affects', task.id],
      [story.id, 'refines', r1.id],
      [story.id, 'duplicates', task.id],
      [r1.id, 'relates_to', r1.id],
    ];
    for (const [src, rel, dst] of invalid) {
      expect(() => service.link(src, rel as 'implements', dst, ctx)).toThrowError(expect.objectContaining({ code: 'INVALID_LINK' }));
    }
    expect(() => service.link(story.id, 'implements', 'REQ-0042', ctx)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('writes nothing when any part of a create is invalid', async () => {
    const service = openService();
    const r1 = await create(service, req('Existing'));
    const before = service.info().counts;
    await expect(
      service.createItem({ kind: 'story', title: 'Bad link', links: [{ rel: 'implements', to: r1.id }, { rel: 'implements', to: 'REQ-0077' }] }, ctx),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.createItem({ kind: 'story', title: 'Bad rel', links: [{ rel: 'affects', to: r1.id }] }, ctx),
    ).rejects.toMatchObject({ code: 'INVALID_LINK' });
    expect(service.info().counts).toEqual(before);
    expect(service.getItem(r1.id).item.in_backlog).toBe(false);
    expect(service.links()).toEqual([]);
    // the failed creates did not consume IDs
    expect((await create(service, { kind: 'story', title: 'Good' })).id).toBe('US-0001');
  });

  it('rejects changing kind', async () => {
    const service = openService();
    const item = await create(service, req('Immutable'));
    await expect(service.updateItem({ id: item.id, kind: 'story' }, ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('delivery and backlog', () => {
  it('sets delivered_at on delivered statuses and clears it when leaving them', async () => {
    const service = openService();
    const r = await create(service, req('Deliverable'));
    expect(r.delivered_at).toBeNull();
    const implemented = (await service.updateItem({ id: r.id, status: 'implemented' }, ctx)).item;
    expect(implemented.delivered_at).not.toBeNull();
    const verified = (await service.updateItem({ id: r.id, status: 'verified' }, ctx)).item;
    expect(verified.delivered_at).toBe(implemented.delivered_at);
    expect((await service.updateItem({ id: r.id, status: 'approved' }, ctx)).item.delivered_at).toBeNull();

    const story = await create(service, { kind: 'story', title: 'Story', status: 'done' });
    expect(story.delivered_at).not.toBeNull();
    expect((await service.updateItem({ id: story.id, status: 'cancelled' }, ctx)).item.delivered_at).toBeNull();
  });

  it('puts a requirement in the backlog when work implements it; unlinking keeps it', async () => {
    const service = openService();
    const r = await create(service, req('Tracked'));
    const story = await create(service, { kind: 'story', title: 'Story', links: [{ rel: 'implements', to: r.id }] });
    expect(service.getItem(r.id).item.in_backlog).toBe(true);
    const backlogEvents = service.history(r.id).filter((event) => event.field === 'in_backlog');
    expect(backlogEvents).toMatchObject([{ action: 'update', old_value: 'false', new_value: 'true' }]);
    service.link(story.id, 'implements', r.id, ctx, true);
    expect(service.getItem(r.id).item.in_backlog).toBe(true);
    expect(service.getItem(r.id).links.incoming).toEqual([]);
  });
});

describe('coverage', () => {
  it('derives every coverage state', async () => {
    const service = openService();
    const coverage = (id: string) => service.getItem(id).item.coverage;
    const r = await create(service, req('Coverage target'));
    expect(coverage(r.id)).toBe('untracked');
    await service.updateItem({ id: r.id, in_backlog: true }, ctx);
    expect(coverage(r.id)).toBe('tracked');

    const r2 = await create(service, req('Worked on'));
    const story = await create(service, { kind: 'story', title: 'S1', links: [{ rel: 'implements', to: r2.id }] });
    const task = await create(service, { kind: 'task', title: 'T1', links: [{ rel: 'implements', to: r2.id }] });
    expect(coverage(r2.id)).toBe('tracked');
    await service.updateItem({ id: task.id, status: 'review' }, ctx);
    expect(coverage(r2.id)).toBe('in_progress');
    await service.updateItem({ id: task.id, status: 'done' }, ctx);
    expect(coverage(r2.id)).toBe('tracked');
    await service.updateItem({ id: story.id, status: 'cancelled' }, ctx);
    expect(coverage(r2.id)).toBe('delivered');
    await service.updateItem({ id: story.id, status: 'in_progress' }, ctx);
    expect(coverage(r2.id)).toBe('in_progress');

    await service.updateItem({ id: r.id, status: 'implemented' }, ctx);
    expect(coverage(r.id)).toBe('delivered');
    await service.updateItem({ id: r.id, status: 'verified' }, ctx);
    expect(coverage(r.id)).toBe('verified');
    for (const status of ['deferred', 'rejected', 'obsolete']) {
      await service.updateItem({ id: r2.id, status }, ctx);
      expect(coverage(r2.id)).toBe('not_applicable');
    }
  });

  it('ignores cancelled work', () => {
    expect(computeCoverage('approved', false, [{ status: 'cancelled' }])).toBe('untracked');
    expect(computeCoverage('approved', true, [{ status: 'cancelled' }])).toBe('tracked');
  });

  it('reports each drift rule', async () => {
    const service = openService();
    const open = await create(service, req('Done but open', { status: 'approved' }));
    await create(service, { kind: 'story', title: 'S done', status: 'done', links: [{ rel: 'implements', to: open.id }] });
    const ahead = await create(service, req('Ahead of work', { status: 'implemented' }));
    await create(service, { kind: 'task', title: 'T open', links: [{ rel: 'implements', to: ahead.id }] });
    const unapproved = await create(service, req('Unapproved'));
    await create(service, { kind: 'story', title: 'S wip', status: 'in_progress', links: [{ rel: 'implements', to: unapproved.id }] });
    await create(service, req('Clean', { status: 'approved' }));

    const drift = service.report('drift').data;
    expect(drift.drift.map(({ id, rule }) => `${id}:${rule}`)).toEqual([
      `${open.id}:work_done_status_open`,
      `${ahead.id}:status_ahead_of_work`,
      `${unapproved.id}:unapproved_in_progress`,
    ]);
    expect(service.report('drift').markdown).toContain('work_done_status_open');
  });
});

describe('lint', () => {
  const rules = (warnings: { rule: string }[]) => warnings.map((warning) => warning.rule).sort();

  it('flags requirement quality issues without blocking', async () => {
    const service = openService();
    const result = await service.createItem(
      { kind: 'requirement', title: 'Fast API', description: 'The API shall be fast.', req_type: 'non_functional' },
      ctx,
    );
    expect(result.created).toBe(true);
    expect(rules((result as CreatedResult).warnings)).toEqual(['nfr_category_missing', 'nfr_not_measurable', 'vague_term']);

    const multi = await service.createItem(
      { ...req('Two statements'), description: 'The system shall log in. The system must log out.', status: 'approved' },
      ctx,
    );
    expect(rules((multi as CreatedResult).warnings)).toEqual(['missing_acceptance_criteria', 'multiple_requirements']);

    const long = await service.createItem({ ...req('x'.repeat(101)), description: 'El sistema deberá ser rápido y/o fácil' }, ctx);
    expect(rules((long as CreatedResult).warnings)).toEqual(['title_too_long', 'vague_term']);
    expect((long as CreatedResult).warnings.find((w) => w.rule === 'vague_term')!.message).toMatch(/rápido.*y\/o.*fácil|"rápido", "y\/o", "fácil"/);

    const measurable = await service.createItem(
      { ...req('Latency'), req_type: 'non_functional', nfr_category: 'performance_efficiency', description: 'p95 under 300 ms' },
      ctx,
    );
    expect((measurable as CreatedResult).warnings).toEqual([]);
  });

  it('checks story format and acceptance criteria on update', async () => {
    const service = openService();
    const story = await create(service, { kind: 'story', title: 'Reset', description: 'Reset the password' });
    const update = await service.updateItem({ id: story.id, status: 'ready' }, ctx);
    expect(rules(update.warnings)).toEqual(['missing_acceptance_criteria', 'story_format']);
    expect(update.warnings.find((w) => w.rule === 'story_format')!.severity).toBe('info');
    const fixed = await service.updateItem(
      { id: story.id, description: 'Como usuario quiero restablecer mi clave para recuperar el acceso', acceptance_criteria: ['Given…'] },
      ctx,
    );
    expect(fixed.warnings).toEqual([]);
    const english = await service.updateItem({ id: story.id, description: 'As an admin I want to reset passwords so that users regain access' }, ctx);
    expect(english.warnings).toEqual([]);
  });
});

describe('events', () => {
  it('records one event per changed field, status changes and comments', async () => {
    const service = openService();
    const r = await create(service, req('Audited', { tags: ['auth'] }));
    const result = await service.updateItem(
      { id: r.id, title: 'Audited requirement', priority: 'must', tags: ['auth'], rationale: 'Compliance', status: 'approved', comment: 'Agreed in standup' },
      ctx,
    );
    expect(result.changed_fields.sort()).toEqual(['priority', 'rationale', 'status', 'title']);
    const events = service.history(r.id).map(({ action, field, old_value, new_value, actor, via }) => ({ action, field, old_value, new_value, actor, via }));
    expect(events).toEqual([
      { action: 'create', field: null, old_value: null, new_value: 'Audited', actor: 'tester', via: 'test' },
      { action: 'update', field: 'title', old_value: 'Audited', new_value: 'Audited requirement', actor: 'tester', via: 'test' },
      { action: 'update', field: 'priority', old_value: 'should', new_value: 'must', actor: 'tester', via: 'test' },
      { action: 'update', field: 'rationale', old_value: null, new_value: 'Compliance', actor: 'tester', via: 'test' },
      { action: 'status', field: 'status', old_value: 'proposed', new_value: 'approved', actor: 'tester', via: 'test' },
      { action: 'comment', field: null, old_value: null, new_value: 'Agreed in standup', actor: 'tester', via: 'test' },
    ]);
    // no-op update records nothing
    await service.updateItem({ id: r.id, priority: 'must' }, ctx);
    expect(service.history(r.id)).toHaveLength(6);
    // clearing a nullable field
    await service.updateItem({ id: r.id, rationale: null }, ctx);
    expect(service.history(r.id).at(-1)).toMatchObject({ field: 'rationale', old_value: 'Compliance', new_value: null });
  });

  it('records link and unlink events visible from both ends', async () => {
    const service = openService();
    const r = await create(service, req('Linked'));
    const story = await create(service, { kind: 'story', title: 'Work' });
    service.link(story.id, 'implements', r.id, ctx);
    service.link(story.id, 'implements', r.id, ctx);
    service.link(story.id, 'implements', r.id, ctx, true);
    const storyEvents = service.history(story.id).filter((event) => event.action !== 'create');
    expect(storyEvents.map(({ action, field, old_value, new_value }) => [action, field, old_value, new_value])).toEqual([
      ['link', 'implements', null, r.id],
      ['unlink', 'implements', r.id, null],
    ]);
    expect(service.history(r.id).map((event) => event.action)).toEqual(['create', 'link', 'update', 'unlink']);
  });
});

describe('lists and reports', () => {
  it('filters by kind, status, coverage, tag and parent, hiding closed items', async () => {
    const service = openService();
    const r1 = await create(service, req('One', { tags: ['Auth'] }));
    const r2 = await create(service, req('Two', { status: 'rejected' }));
    const epic = await create(service, { kind: 'epic', title: 'Epic' });
    await create(service, { kind: 'story', title: 'S', parent_id: epic.id, links: [{ rel: 'implements', to: r1.id }] });

    expect(service.listItems({ kind: 'requirement' }).items.map((item) => item.id)).toEqual([r1.id]);
    expect(service.listItems({ kind: 'requirement', include_closed: true }).total).toBe(2);
    expect(service.listItems({ status: ['rejected'] }).items.map((item) => item.id)).toEqual([r2.id]);
    expect(service.listItems({ coverage: ['tracked'] }).items).toMatchObject([{ id: r1.id, coverage: 'tracked', in_backlog: true }]);
    expect(service.listItems({ tag: 'auth' }).items.map((item) => item.id)).toEqual([r1.id]);
    expect(service.listItems({ parent_id: epic.id }).items).toMatchObject([{ id: 'US-0001', parent_id: epic.id }]);
    expect(service.listItems({ limit: 2, offset: 1 })).toMatchObject({ total: 3, items: [{ id: 'REQ-0001' }, { id: 'US-0001' }] });
    expect(() => service.listItems({ status: ['nope'] })).toThrowError(expect.objectContaining({ code: 'INVALID_STATUS' }));
  });

  it('builds summary, coverage, board, lint and traceability reports', async () => {
    const service = openService();
    const r = await create(service, req('Traced', { status: 'approved' }));
    const story = await create(service, { kind: 'story', title: 'Story', status: 'in_progress', links: [{ rel: 'implements', to: r.id }] });
    await create(service, { kind: 'task', title: 'Child task', parent_id: story.id });
    await create(service, { kind: 'bug', title: 'Bug', severity: 'major', links: [{ rel: 'affects', to: r.id }] });

    const summary = service.report('summary').data;
    expect(summary.counts.requirement.approved).toBe(1);
    expect(summary.coverage.in_progress).toBe(1);
    expect(summary.open_bugs_by_severity.major).toBe(1);

    const coverage = service.report('coverage').data;
    expect(coverage.requirements[0]).toMatchObject({ id: r.id, coverage: 'in_progress', implemented_by: [{ id: story.id, status: 'in_progress' }] });

    const board = service.report('board').data;
    expect(board.columns.map((column) => column.status)).toEqual(['backlog', 'ready', 'in_progress', 'review', 'done']);
    expect(board.columns[2]!.items).toEqual([{ id: story.id, kind: 'story', title: 'Story', priority: 'should', assignee: null, implements: [r.id] }]);

    const trace = service.report('traceability').data;
    expect(trace.requirements[0]).toMatchObject({
      id: r.id,
      implemented_by: [{ id: story.id, children: [{ id: 'TASK-0001' }] }],
      affected_by: [{ id: 'BUG-0001', severity: 'major' }],
    });
    const lint = service.report('lint').data;
    expect(lint.warnings.map((w) => `${w.id}:${w.rule}`)).toEqual([`${r.id}:missing_acceptance_criteria`, `${story.id}:missing_acceptance_criteria`, `${story.id}:story_format`]);
  });
});

describe('item details', () => {
  async function fixture() {
    const service = openService();
    const r = await create(service, req('Login', { acceptance_criteria: ['Given a user, when they sign in, then they see the home page'] }));
    const other = await create(service, req('Audit'));
    const epic = await create(service, { kind: 'epic', title: 'Accounts' });
    const story = await create(service, { kind: 'story', title: 'Sign in', parent_id: epic.id, links: [{ rel: 'implements', to: r.id }] });
    const task = await create(service, {
      kind: 'task',
      title: 'Login form',
      parent_id: story.id,
      links: [
        { rel: 'implements', to: r.id },
        { rel: 'relates_to', to: other.id },
      ],
    });
    const bug = await create(service, { kind: 'bug', title: 'Login crash', parent_id: story.id, links: [{ rel: 'affects', to: other.id }] });
    return { service, r, other, epic, story, task, bug };
  }

  it('returns several items in request order as {items}', async () => {
    const { service, r, story, task } = await fixture();
    const { items } = service.getItems([task.id, 'req-1', story.id]);
    expect(items.map((detail) => detail.item.id)).toEqual([task.id, r.id, story.id]);
    expect(items[0]).toEqual(service.getItem(task.id));
  });

  it('context adds the parent summary, linked requirements with their AC, and summary links and children', async () => {
    const { service, r, other, epic, story, task, bug } = await fixture();
    const detail = service.getItem(story.id, { context: true });
    expect(detail.parent).toEqual({ id: epic.id, kind: 'epic', title: 'Accounts', status: epic.status });
    expect(detail.requirements).toEqual([
      { rel: 'implements', id: r.id, kind: 'requirement', title: 'Login', status: r.status, acceptance_criteria: ['Given a user, when they sign in, then they see the home page'] },
    ]);
    expect(detail.children).toEqual([
      { id: bug.id, kind: 'bug', title: 'Login crash', status: bug.status },
      { id: task.id, kind: 'task', title: 'Login form', status: task.status },
    ]);

    const [taskDetail, bugDetail, epicDetail] = service.getItems([task.id, bug.id, epic.id], { context: true }).items;
    expect(taskDetail!.parent).toEqual({ id: story.id, kind: 'story', title: 'Sign in', status: story.status });
    // relates_to is a link, not a requirement the task works against
    expect(taskDetail!.requirements!.map((link) => link.id)).toEqual([r.id]);
    expect(taskDetail!.links.outgoing).toEqual([
      { rel: 'implements', id: r.id, kind: 'requirement', title: 'Login', status: r.status },
      { rel: 'relates_to', id: other.id, kind: 'requirement', title: 'Audit', status: other.status },
    ]);
    expect(bugDetail!.requirements).toEqual([{ rel: 'affects', id: other.id, kind: 'requirement', title: 'Audit', status: other.status, acceptance_criteria: [] }]);
    expect(epicDetail!.parent).toBeNull();
    expect(epicDetail!.requirements).toEqual([]);
  });

  it('keeps the single-item shape without context', async () => {
    const { service, story } = await fixture();
    expect(Object.keys(service.getItem(story.id))).toEqual(['item', 'links', 'children']);
    expect(Object.keys(service.getItem('REQ-0001'))).toEqual(['item', 'coverage', 'links', 'children']);
  });

  it('NOT_FOUND names every unknown ID', async () => {
    const { service, story } = await fixture();
    expect(() => service.getItems(['REQ-0099', story.id, 'task-77', 'REQ-0099'])).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND', message: 'No items with ids REQ-0099, TASK-0077.' }),
    );
    expect(() => service.getItems([story.id, 'REQ-0099'])).toThrow(expect.objectContaining({ code: 'NOT_FOUND', message: 'No item with id REQ-0099.' }));
  });

  it('rejects an empty list or more than 50 IDs', async () => {
    const { service, story } = await fixture();
    expect(() => service.getItems([])).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => service.getItems(Array.from({ length: 51 }, () => story.id))).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(service.getItems(Array.from({ length: 50 }, () => story.id)).items).toHaveLength(50);
  });
});

describe('delete', () => {
  const count = (service: OverseerService, sql: string, ...params: (string | number | bigint)[]) =>
    Number(service.db.prepare(`SELECT count(*) AS n FROM ${sql}`).get(...params)!.n);

  async function fixture() {
    const service = openService();
    const r = await create(service, req('Login'));
    const story = await create(service, { kind: 'story', title: 'Sign in', links: [{ rel: 'implements', to: r.id }] });
    const task = await create(service, { kind: 'task', title: 'Session cookie', links: [{ rel: 'depends_on', to: story.id }] });
    await service.semantic.embedPending();
    return { service, r, story, task };
  }

  it('removes the item, its links both ways, embeddings, vectors and search row, and keeps a tombstone and a delete event', async () => {
    const { service, r, story, task } = await fixture();
    const rid = service.requireRow(story.id).rid;
    service.db.exec(`UPDATE items SET external_ref = 'github:acme/app#7', external_url = 'https://github.com/acme/app/issues/7' WHERE id = '${story.id}'`);
    service.db.exec(`INSERT INTO connections(id, host, repository, created_at) VALUES (1, 'gitlab', 'acme/app', '2026-10-01T10:00:00-03:00')`);
    service.db.exec(`INSERT INTO item_remote_refs(item_id, connection_id, external_ref, url) VALUES ('${story.id}', 1, 'acme/app#3', 'https://gitlab.com/acme/app/-/issues/3')`);
    expect(count(service, 'item_embeddings WHERE rid = ?', rid)).toBe(1);
    expect(count(service, 'items_fts WHERE rowid = ?', rid)).toBe(1);
    if (service.vecAvailable) for (const table of VEC_TABLES) expect(count(service, `${table} WHERE rid = ?`, BigInt(rid))).toBe(1);

    const result = service.deleteItem('us-1', { via: 'test', actor: 'remover' });
    expect(result).toEqual({
      deleted: true,
      id: story.id,
      kind: 'story',
      title: 'Sign in',
      external_refs: [
        { connection_id: null, external_ref: 'github:acme/app#7', url: 'https://github.com/acme/app/issues/7' },
        { connection_id: 1, external_ref: 'acme/app#3', url: 'https://gitlab.com/acme/app/-/issues/3' },
      ],
      deleted_at: expect.any(String),
      actor: 'remover',
    });
    expect(count(service, 'items WHERE id = ?', story.id)).toBe(0);
    expect(count(service, 'links WHERE src = ? OR dst = ?', story.id, story.id)).toBe(0);
    expect(count(service, 'item_embeddings WHERE rid = ?', rid)).toBe(0);
    expect(count(service, 'items_fts WHERE rowid = ?', rid)).toBe(0);
    expect(count(service, 'item_remote_refs WHERE item_id = ?', story.id)).toBe(0);
    if (service.vecAvailable) {
      for (const table of VEC_TABLES) {
        expect(count(service, `${table} WHERE rid = ?`, BigInt(rid))).toBe(0);
        // The stored running sum equals the sum of the vectors left.
        const stored = JSON.parse(String(service.getMeta(`vec_sum:${table}`))) as { n: number; sum: string };
        const bytes = Buffer.from(stored.sum, 'base64');
        const sum = new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        const rows = service.db.prepare(`SELECT embedding FROM ${table}`).all() as { embedding: Uint8Array }[];
        expect(stored.n).toBe(rows.length);
        const expected = new Float64Array(sum.length);
        for (const row of rows) new Float32Array(row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength)).forEach((value, i) => (expected[i]! += value));
        sum.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 5));
      }
    }
    expect(service.db.prepare('SELECT * FROM tombstones').all()).toEqual([
      {
        item_id: story.id,
        kind: 'story',
        title: 'Sign in',
        external_refs: JSON.stringify(result.external_refs),
        deleted_at: result.deleted_at,
        actor: 'remover',
      },
    ]);
    const history = service.history(story.id).map(({ item_id, action, field, old_value, new_value, actor }) => [item_id, action, field, old_value, new_value, actor]);
    expect(history).toEqual([
      [story.id, 'create', null, null, 'Sign in', 'tester'],
      [story.id, 'link', 'implements', null, r.id, 'tester'],
      [task.id, 'link', 'depends_on', null, story.id, 'tester'],
      [task.id, 'unlink', 'depends_on', story.id, null, 'remover'],
      [story.id, 'unlink', 'implements', r.id, null, 'remover'],
      [story.id, 'delete', null, 'Sign in', null, 'remover'],
    ]);
    expect(service.getItem(r.id).links.incoming).toEqual([]);
    expect(service.getItem(task.id).links.outgoing).toEqual([]);
    expect((await service.search('Sign in')).results.map((hit) => hit.id)).not.toContain(story.id);
  });

  it('refuses an item with children with CONFLICT listing them and deletes nothing', async () => {
    const service = openService();
    const epic = await create(service, { kind: 'epic', title: 'Accounts' });
    await create(service, { kind: 'story', title: 'Sign in', parent_id: epic.id });
    await create(service, { kind: 'bug', title: 'Login crash', parent_id: epic.id });
    const events = count(service, 'events');
    expect(() => service.deleteItem(epic.id, ctx)).toThrow(
      expect.objectContaining({
        code: 'CONFLICT',
        message: 'EPIC-0001 has children: BUG-0001, US-0001. Delete them or give them another parent first; nothing was deleted.',
      }),
    );
    expect(service.getItem(epic.id).children.map((child) => child.id)).toEqual(['BUG-0001', 'US-0001']);
    expect(count(service, 'tombstones')).toBe(0);
    expect(count(service, 'events')).toBe(events);
  });

  it('answers NOT_FOUND with the deletion time, keeps the events in history and exports, and never reuses the ID', async () => {
    const { service, story, task } = await fixture();
    const { deleted_at } = service.deleteItem(task.id, ctx);
    expect(() => service.getItem(task.id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND', message: `Item ${task.id} was deleted on ${deleted_at}.` }));
    expect(() => service.getItems([story.id, task.id])).toThrow(expect.objectContaining({ message: `Item ${task.id} was deleted on ${deleted_at}.` }));
    expect(() => service.getItems([task.id, 'TASK-0099'])).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND', message: `No items with ids ${task.id} (deleted on ${deleted_at}), TASK-0099.` }),
    );
    await expect(service.updateItem({ id: task.id, title: 'Back' }, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(() => service.deleteItem(task.id, ctx)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));

    expect(service.history(task.id).map((event) => event.action)).toEqual(['create', 'link', 'unlink', 'delete']);
    service.exportReports({ only: ['history', 'json'] });
    const history = readFileSync(join(service.root, 'docs/overseer/history.md'), 'utf8');
    expect(history).toMatch(new RegExp(`\\| ${deleted_at} \\| ${task.id} \\| delete \\|`));
    const exported = JSON.parse(readFileSync(join(service.root, 'docs/overseer/overseer.json'), 'utf8')) as { events: { item_id: string; action: string }[] };
    expect(exported.events.filter((event) => event.item_id === task.id).map((event) => event.action)).toEqual(['create', 'link', 'unlink', 'delete']);

    expect((await create(service, { kind: 'task', title: 'Next task' })).id).toBe('TASK-0002');
    expect(task.id).toBe('TASK-0001');
  });
});

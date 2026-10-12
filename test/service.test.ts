import { describe, expect, it } from 'vitest';
import { computeCoverage } from '../src/core/coverage.js';
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

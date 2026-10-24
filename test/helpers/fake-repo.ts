import type { PushResult } from '../../src/core/sync-confirm.js';
import type { PushOp } from '../../src/core/sync-plan.js';

export type FakeHost = 'github' | 'gitlab';

/** One issue as the fake repository keeps it. */
export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  /** GitHub close reason (`completed`, `not_planned`); null while open. */
  state_reason: string | null;
  assignee: string | null;
  milestone: string | null;
  created_at: string;
  updated_at: string;
}

/** An MCP tool call the skill would make for a push op, with the arguments it sets. */
export interface McpCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Issue fields a person can change in the repository. */
export type IssueEdit = Partial<Pick<FakeIssue, 'title' | 'body' | 'labels' | 'assignee' | 'milestone'>>;

const START = Date.UTC(2026, 9, 1);

/**
 * An in-memory GitHub or GitLab repository for end-to-end sync tests: no network. It renders its issues as the raw MCP
 * listings `sync start`, `sync plan` and `sync pull` take (the shapes of test/fixtures/import/: GitHub `list_issues`
 * `{issues, totalCount, pageInfo}` of MinimalIssue, GitLab `list_work_items` `{items, pageInfo}` without descriptions)
 * and applies `sync plan` push ops the way the overseer-sync skill's MCP calls would (GitHub `issue_write`, GitLab
 * `create_issue` / `update_issue`: only the op's `fields`, from its `issue`; a closed create is closed by a second
 * call), returning the results `sync confirm` takes. Milestones are kept by title (the real servers take their number
 * or id). Timestamps come from a logical clock, one minute per change, so listings are deterministic.
 */
export class FakeRepository {
  /** Every MCP call `push` made, in order. */
  readonly calls: McpCall[] = [];
  /** Push ops whose call failed (the issue is gone): they give no result. */
  readonly failed: PushOp[] = [];
  private readonly issues = new Map<number, FakeIssue>();
  private next = 1;
  private tick = 0;

  constructor(
    readonly host: FakeHost,
    readonly repository: string,
  ) {}

  /** `owner/repo#N`, the issue's `external_id` in overseer. */
  ref(number: number): string {
    return `${this.repository}#${number}`;
  }

  url(number: number): string {
    return this.host === 'github' ? `https://github.com/${this.repository}/issues/${number}` : `https://gitlab.com/${this.repository}/-/issues/${number}`;
  }

  /** A copy of issue `number`; throws when the repository has no such issue. */
  issue(number: number): FakeIssue {
    return structuredClone(this.require(number));
  }

  /** Issue numbers, ascending. */
  numbers(): number[] {
    return [...this.issues.keys()].sort((a, b) => a - b);
  }

  /** A person opens an issue in the repository; returns its number. */
  open(fields: IssueEdit & { title: string }): number {
    const at = this.now();
    const number = this.next++;
    this.issues.set(number, {
      number,
      title: fields.title,
      body: fields.body ?? '',
      labels: fields.labels ?? [],
      state: 'open',
      state_reason: null,
      assignee: fields.assignee ?? null,
      milestone: fields.milestone ?? null,
      created_at: at,
      updated_at: at,
    });
    return number;
  }

  /** A person edits issue fields in the repository. */
  edit(number: number, fields: IssueEdit): void {
    Object.assign(this.require(number), fields, { updated_at: this.now() });
  }

  close(number: number, reason = 'completed'): void {
    Object.assign(this.require(number), { state: 'closed', state_reason: reason, updated_at: this.now() });
  }

  reopen(number: number): void {
    Object.assign(this.require(number), { state: 'open', state_reason: null, updated_at: this.now() });
  }

  /** A person deletes the issue: listings no longer have it. Returns its `external_id`. */
  remove(number: number): string {
    this.require(number);
    this.issues.delete(number);
    return this.ref(number);
  }

  /** Every issue, open and closed, as one page of the host's raw MCP listing. */
  listing(): unknown {
    const issues = this.numbers().map((number) => this.issues.get(number)!);
    if (this.host === 'github') {
      return {
        issues: issues.map((issue) => ({
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
          ...(issue.state_reason ? { state_reason: issue.state_reason.toUpperCase() } : {}),
          html_url: this.url(issue.number),
          user: { login: 'octocat' },
          labels: issue.labels,
          assignees: issue.assignee ? [issue.assignee] : [],
          ...(issue.milestone ? { milestone: issue.milestone } : {}),
          comments: 0,
          created_at: issue.created_at,
          updated_at: issue.updated_at,
        })),
        totalCount: issues.length,
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    }
    return {
      items: issues.map((issue) => ({
        iid: String(issue.number),
        title: issue.title,
        state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
        type: 'Issue',
        webUrl: this.url(issue.number),
        labels: issue.labels,
        assignees: issue.assignee ? [issue.assignee] : [],
        milestone: issue.milestone,
      })),
      pageInfo: { hasNextPage: false, endCursor: null },
    };
  }

  /**
   * Runs `sync plan` push ops as the skill's MCP calls would and returns one `sync confirm` result per successful op
   * (`seqs`, `item_id`, `external_id`, `url`, `state`, `fields`, and `overwritten` as is when the op has one). An op
   * on an issue the repository no longer has fails: no result, listed in `failed`.
   */
  push(ops: readonly PushOp[]): PushResult[] {
    const results: PushResult[] = [];
    for (const op of ops) {
      let number: number;
      if (op.op === 'create') {
        number = this.open({ title: op.issue.title, body: op.issue.body ?? '', labels: op.issue.labels ?? [], assignee: op.issue.assignee, milestone: op.issue.milestone });
        this.calls.push({ tool: this.host === 'github' ? 'issue_write' : 'create_issue', args: { method: 'create', ...this.args(op, op.fields.filter((field) => field !== 'state')) } });
        if (op.issue.state === 'closed') {
          this.close(number);
          this.calls.push({ tool: this.host === 'github' ? 'issue_write' : 'update_issue', args: { method: 'update', number, ...this.args(op, ['state']) } });
        }
      } else {
        number = Number(op.external_ref!.slice(op.external_ref!.lastIndexOf('#') + 1));
        if (!op.external_ref!.startsWith(`${this.repository}#`) || !this.issues.has(number)) {
          this.failed.push(op);
          continue;
        }
        this.calls.push({ tool: this.host === 'github' ? 'issue_write' : 'update_issue', args: { method: 'update', number, ...this.args(op, op.fields) } });
        const issue = this.require(number);
        for (const field of op.fields) {
          if (field === 'state') {
            if (op.issue.state === 'closed' && issue.state === 'open') Object.assign(issue, { state: 'closed', state_reason: 'completed' });
            else if (op.issue.state === 'open' && issue.state === 'closed') Object.assign(issue, { state: 'open', state_reason: null });
          } else if (field === 'assignee') issue.assignee = op.issue.assignee;
          else if (field === 'milestone') issue.milestone = op.issue.milestone;
          else if (field === 'title') issue.title = op.issue.title;
          else if (field === 'body') issue.body = op.issue.body ?? '';
          else issue.labels = [...(op.issue.labels ?? [])];
        }
        issue.updated_at = this.now();
      }
      results.push({
        seqs: [op.seq],
        item_id: op.item_id,
        external_id: this.ref(number),
        url: this.url(number),
        state: this.issues.get(number)!.state,
        fields: op.fields,
        ...(op.overwritten ? { overwritten: op.overwritten } : {}),
      });
    }
    return results;
  }

  /** The host's argument names for `fields` of the op's issue. */
  private args(op: PushOp, fields: readonly string[]): Record<string, unknown> {
    const { issue } = op;
    const github = this.host === 'github';
    const args: Record<string, unknown> = {};
    for (const field of fields) {
      if (field === 'title') args.title = issue.title;
      else if (field === 'body') args[github ? 'body' : 'description'] = issue.body;
      else if (field === 'labels') args.labels = issue.labels;
      else if (field === 'assignee') args[github ? 'assignees' : 'assignee_usernames'] = issue.assignee ? [issue.assignee] : [];
      else if (field === 'milestone') args.milestone = issue.milestone;
      else if (github) args.state = issue.state;
      else args.state_event = issue.state === 'closed' ? 'close' : 'reopen';
    }
    return args;
  }

  private require(number: number): FakeIssue {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`${this.ref(number)} does not exist`);
    return issue;
  }

  private now(): string {
    return new Date(START + ++this.tick * 60_000).toISOString().replace('.000Z', 'Z');
  }
}

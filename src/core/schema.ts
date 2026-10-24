import { z } from 'zod';
import { OverseerError } from './errors.js';

/** `<field path>: <problem>` per issue of a failed parse. */
export function issueTexts(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'input'}: ${issue.message}`);
}

/** Validates `raw` against `schema`; INVALID_INPUT listing every issue otherwise. */
export function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  throw new OverseerError('INVALID_INPUT', issueTexts(result.error).join('; '));
}

export const KINDS = ['requirement', 'epic', 'story', 'task', 'bug'] as const;
export type Kind = (typeof KINDS)[number];

export const ID_PREFIX: Record<Kind, string> = {
  requirement: 'REQ',
  epic: 'EPIC',
  story: 'US',
  task: 'TASK',
  bug: 'BUG',
};

const WORK_STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'done', 'cancelled'] as const;

/** Allowed statuses per kind; the first one is the default. */
export const STATUSES: Record<Kind, readonly string[]> = {
  requirement: ['proposed', 'approved', 'implemented', 'verified', 'deferred', 'rejected', 'obsolete'],
  epic: ['open', 'in_progress', 'done', 'cancelled'],
  story: WORK_STATUSES,
  task: WORK_STATUSES,
  bug: WORK_STATUSES,
};

/** Hidden from lists unless `include_closed`. */
export const CLOSED_STATUSES: Record<Kind, readonly string[]> = {
  requirement: ['rejected', 'obsolete'],
  epic: ['cancelled'],
  story: ['cancelled'],
  task: ['cancelled'],
  bug: ['cancelled'],
};

/** Entering one of these sets `delivered_at`. */
export const DELIVERED_STATUSES: Record<Kind, readonly string[]> = {
  requirement: ['implemented', 'verified'],
  epic: ['done'],
  story: ['done'],
  task: ['done'],
  bug: ['done'],
};

export const PRIORITIES = ['must', 'should', 'could', 'wont'] as const;
export const REQ_TYPES = ['functional', 'non_functional'] as const;
export const NFR_CATEGORIES = [
  'performance_efficiency',
  'compatibility',
  'interaction_capability',
  'reliability',
  'security',
  'maintainability',
  'flexibility',
  'safety',
] as const;
export const VERIFICATION_METHODS = ['test', 'inspection', 'analysis', 'demonstration'] as const;
export const SEVERITIES = ['critical', 'major', 'minor', 'trivial'] as const;
export const RELATIONS = [
  'implements',
  'affects',
  'refines',
  'conflicts_with',
  'supersedes',
  'duplicates',
  'depends_on',
  'relates_to',
] as const;
export const COVERAGE_STATES = ['untracked', 'tracked', 'in_progress', 'delivered', 'verified', 'not_applicable'] as const;
export const REPORT_KINDS = ['summary', 'coverage', 'board', 'drift', 'lint', 'traceability'] as const;
export const EXPORT_PARTS = ['summary', 'requirements', 'backlog', 'history', 'json'] as const;
export const IMPORT_SOURCES = ['github', 'gitlab'] as const;

export type Priority = (typeof PRIORITIES)[number];
export type ReqType = (typeof REQ_TYPES)[number];
export type Relation = (typeof RELATIONS)[number];
export type CoverageState = (typeof COVERAGE_STATES)[number];
export type ReportKind = (typeof REPORT_KINDS)[number];
export type ExportPart = (typeof EXPORT_PARTS)[number];
export type ImportSource = (typeof IMPORT_SOURCES)[number];
export type EventAction = 'create' | 'update' | 'status' | 'link' | 'unlink' | 'comment' | 'import' | 'delete';

export const bugDetailsSchema = z.object({
  steps: z.array(z.string()),
  expected: z.string(),
  actual: z.string(),
  environment: z.string().optional(),
});
export type BugDetails = z.infer<typeof bugDetailsSchema>;

/** Item wire shape (service / MCP / board API / export): every column but `rid`. */
export interface Item {
  id: string;
  kind: Kind;
  title: string;
  description: string;
  status: string;
  priority: Priority;
  req_type: ReqType | null;
  nfr_category: string | null;
  rationale: string | null;
  acceptance_criteria: string[];
  fit_criterion: string | null;
  verification_method: string | null;
  asked_by: string | null;
  source: string | null;
  recorded_via: string;
  in_backlog: boolean;
  parent_id: string | null;
  assignee: string | null;
  estimate: number | null;
  milestone: string | null;
  severity: string | null;
  bug_details: BugDetails | null;
  component: string | null;
  tags: string[];
  code_refs: string[];
  external_ref: string | null;
  external_url: string | null;
  external_state: string | null;
  external_synced_at: string | null;
  delivered_at: string | null;
  delivered_in: string | null;
  created_at: string;
  updated_at: string;
  status_changed_at: string;
  coverage?: CoverageState;
}

export interface ItemRef {
  id: string;
  kind: Kind;
  title: string;
  status: string;
}

export interface LinkRef extends ItemRef {
  rel: Relation;
}

export interface ItemEvent {
  seq: number;
  item_id: string;
  at: string;
  actor: string;
  via: string;
  action: EventAction;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
}

export interface LintWarning {
  rule: string;
  severity: 'warn' | 'info';
  message: string;
}

/** Who records a change: `via` = MCP client name, `cli`, `web` or `import:<source>`. */
export interface Ctx {
  via: string;
  actor?: string;
  /** Connection whose remote changes this write applies (an import of its issues): the sync outbox skips it. */
  origin_connection?: number;
  /** Seqs of the sync outbox entries this write queued, collected for its `sync_pending` (shared by nested writes). */
  queued?: Set<number>;
}

const title = z.string().trim().min(1, 'title must not be empty').max(500);
const shortText = z.string().max(2000);
const longText = z.string().max(20000);
const stringList = z.array(z.string().max(2000)).max(200);

/** Editable item fields (S4) shared by create and update; update additionally accepts `null` for nullable ones. */
export const itemFieldsShape = {
  title,
  description: longText,
  priority: z.enum(PRIORITIES),
  req_type: z.enum(REQ_TYPES),
  nfr_category: z.enum(NFR_CATEGORIES),
  rationale: longText,
  acceptance_criteria: stringList,
  fit_criterion: shortText,
  verification_method: z.enum(VERIFICATION_METHODS),
  asked_by: shortText,
  source: shortText,
  in_backlog: z.boolean(),
  parent_id: shortText,
  assignee: shortText,
  estimate: z.number().nonnegative(),
  milestone: shortText,
  severity: z.enum(SEVERITIES),
  bug_details: bugDetailsSchema,
  component: shortText,
  tags: stringList,
  code_refs: stringList,
  delivered_in: shortText,
};

const itemFields = z.object(itemFieldsShape);
export type ItemField = keyof typeof itemFieldsShape;

export const linkInputSchema = z.object({ rel: z.enum(RELATIONS), to: z.string().min(1) });

export const createInputSchema = itemFields
  .partial()
  .extend({
    kind: z.enum(KINDS),
    title,
    status: z.string().optional(),
    links: z.array(linkInputSchema).max(50).optional(),
    allow_duplicate: z.boolean().optional(),
  })
  .strict();

/** Update: every field optional; these may also be cleared with `null`. */
export const updateInputSchema = itemFields
  .extend({
    nfr_category: itemFieldsShape.nfr_category.nullable(),
    rationale: itemFieldsShape.rationale.nullable(),
    fit_criterion: itemFieldsShape.fit_criterion.nullable(),
    verification_method: itemFieldsShape.verification_method.nullable(),
    asked_by: itemFieldsShape.asked_by.nullable(),
    source: itemFieldsShape.source.nullable(),
    parent_id: itemFieldsShape.parent_id.nullable(),
    assignee: itemFieldsShape.assignee.nullable(),
    estimate: itemFieldsShape.estimate.nullable(),
    milestone: itemFieldsShape.milestone.nullable(),
    severity: itemFieldsShape.severity.nullable(),
    bug_details: itemFieldsShape.bug_details.nullable(),
    component: itemFieldsShape.component.nullable(),
    delivered_in: itemFieldsShape.delivered_in.nullable(),
  })
  .partial()
  .extend({
    id: z.string().min(1),
    status: z.string().optional(),
    comment: z.string().trim().min(1).max(20000).optional(),
  })
  .strict();

export type CreateInput = z.infer<typeof createInputSchema>;
export type UpdateInput = z.infer<typeof updateInputSchema>;

/** Fields restricted to some kinds (S4); `INVALID_INPUT` when set on another kind. */
export const FIELD_KINDS: Partial<Record<ItemField, readonly Kind[]>> = {
  req_type: ['requirement'],
  nfr_category: ['requirement'],
  fit_criterion: ['requirement'],
  verification_method: ['requirement'],
  severity: ['bug'],
  bug_details: ['bug'],
  estimate: ['story', 'task', 'bug'],
};

/** Allowed parent kinds per child kind (S3). */
export const PARENT_KINDS: Record<Kind, readonly Kind[]> = {
  requirement: ['requirement'],
  epic: [],
  story: ['epic'],
  task: ['story'],
  bug: ['epic', 'story'],
};

/** Allowed (src kinds, dst kinds) per relation; `same` = both ends of the same kind (S3). */
export const RELATION_RULES: Record<Relation, { src: readonly Kind[]; dst: readonly Kind[]; same?: boolean }> = {
  implements: { src: ['story', 'task'], dst: ['requirement'] },
  affects: { src: ['bug'], dst: ['requirement', 'story'] },
  refines: { src: ['requirement'], dst: ['requirement'] },
  conflicts_with: { src: ['requirement'], dst: ['requirement'] },
  supersedes: { src: ['requirement'], dst: ['requirement'] },
  duplicates: { src: KINDS, dst: KINDS, same: true },
  depends_on: { src: KINDS, dst: KINDS },
  relates_to: { src: KINDS, dst: KINDS },
};

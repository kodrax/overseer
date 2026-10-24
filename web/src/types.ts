// Wire shapes mirroring the board HTTP API (contracts §2–3).

export type Kind = 'requirement' | 'epic' | 'story' | 'task' | 'bug';
export type Priority = 'must' | 'should' | 'could' | 'wont';
export type ReqType = 'functional' | 'non_functional';
export type Relation =
  | 'implements'
  | 'affects'
  | 'refines'
  | 'conflicts_with'
  | 'supersedes'
  | 'duplicates'
  | 'depends_on'
  | 'relates_to';
export type CoverageState = 'untracked' | 'tracked' | 'in_progress' | 'delivered' | 'verified' | 'not_applicable';
export type MatchClass = 'duplicate' | 'related' | 'weak';

export interface BugDetails {
  steps: string[];
  expected: string;
  actual: string;
  environment?: string;
}

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

export type ListedItem = Item & { implements: string[] };

export interface ItemRef {
  id: string;
  kind: Kind;
  title: string;
  status: string;
}

export type LinkRef = ItemRef & { rel: Relation };

export interface ItemEvent {
  seq: number;
  item_id: string;
  at: string;
  actor: string;
  via: string;
  action: 'create' | 'update' | 'status' | 'link' | 'unlink' | 'comment' | 'import' | 'delete' | 'overwrite';
  field: string | null;
  old_value: string | null;
  new_value: string | null;
}

export interface LintWarning {
  rule: string;
  severity: 'warn' | 'info';
  message: string;
}

export type SimilarMatch = ItemRef & {
  similarity: number | null;
  match: MatchClass | null;
  coverage?: CoverageState;
};

export interface Enums {
  kinds: Kind[];
  statuses: Record<Kind, string[]>;
  closed_statuses: Record<Kind, string[]>;
  priorities: Priority[];
  req_types: ReqType[];
  nfr_categories: string[];
  verification_methods: string[];
  severities: string[];
  relations: Relation[];
  coverage_states: CoverageState[];
}

export interface ProjectInfo {
  initialized: true;
  root: string;
  project_name: string;
  version: string;
  schema_version: string;
  vec_available: boolean;
  counts: Record<string, Record<string, number>>;
  enums: Enums;
}

export interface ListItemsQuery {
  kind?: Kind;
  status?: string[];
  req_type?: ReqType;
  coverage?: CoverageState[];
  tag?: string;
  parent_id?: string;
  include_closed?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListItemsResult {
  total: number;
  items: ListedItem[];
}

export interface ItemDetail {
  item: Item;
  coverage?: CoverageState;
  links: { outgoing: LinkRef[]; incoming: LinkRef[] };
  children: ItemRef[];
  history?: ItemEvent[];
}

/** Fields accepted by POST /api/items (besides the create-only ones) and PATCH /api/items/:id. */
export interface ItemFields {
  title?: string;
  description?: string;
  status?: string;
  priority?: Priority;
  req_type?: ReqType | null;
  nfr_category?: string | null;
  rationale?: string | null;
  acceptance_criteria?: string[];
  fit_criterion?: string | null;
  verification_method?: string | null;
  asked_by?: string | null;
  source?: string | null;
  in_backlog?: boolean;
  parent_id?: string | null;
  assignee?: string | null;
  estimate?: number | null;
  milestone?: string | null;
  severity?: string | null;
  bug_details?: BugDetails | null;
  component?: string | null;
  tags?: string[];
  code_refs?: string[];
  delivered_in?: string | null;
}

export type CreateItemInput = ItemFields & {
  kind: Kind;
  title: string;
  links?: { rel: Relation; to: string }[];
  allow_duplicate?: boolean;
};

export type UpdateItemInput = ItemFields & { comment?: string };

export type CreateItemResult =
  | { created: true; item: Item; warnings: LintWarning[]; similar: SimilarMatch[] }
  | { created: false; reason: 'possible_duplicate'; candidates: SimilarMatch[] };

export interface UpdateItemResult {
  item: Item;
  changed_fields: string[];
  warnings: LintWarning[];
}

export interface LinkInput {
  src: string;
  rel: Relation;
  dst: string;
}

export interface LinkResult extends LinkInput {
  linked: boolean;
}

export type SearchResult = ItemRef & { score: number; similarity: number | null; fts_rank: number | null };

export interface SearchResponse {
  semantic: boolean;
  warning?: string;
  results: SearchResult[];
}

export interface SimilarResponse {
  semantic: boolean;
  warning?: string;
  verdict: 'duplicate' | 'related' | 'new' | 'unknown';
  matches: SimilarMatch[];
}

export type ReportKind = 'summary' | 'coverage' | 'board' | 'drift' | 'lint' | 'traceability';

export interface SummaryData {
  project_name: string;
  root: string;
  initialized: boolean;
  counts: Record<string, Record<string, number>>;
  coverage: Partial<Record<CoverageState, number>>;
  open_bugs_by_severity: Record<string, number>;
  drift_count: number;
  last_imports: { source: string; repo: string; at: string }[];
  vec_available: boolean;
}

export interface CoverageReportData {
  requirements: {
    id: string;
    title: string;
    req_type: ReqType;
    priority: Priority;
    status: string;
    coverage: CoverageState;
    implemented_by: ItemRef[];
  }[];
}

export interface BoardReportData {
  columns: {
    status: string;
    items: { id: string; kind: Kind; title: string; priority: Priority; assignee: string | null; implements: string[] }[];
  }[];
}

export type DriftRule = 'work_done_status_open' | 'status_ahead_of_work' | 'unapproved_in_progress';

export interface DriftReportData {
  drift: {
    id: string;
    title: string;
    status: string;
    coverage: CoverageState;
    rule: DriftRule;
    message: string;
    work: ItemRef[];
  }[];
}

export interface LintReportData {
  warnings: { id: string; kind: Kind; title: string; rule: string; severity: 'warn' | 'info'; message: string }[];
}

export interface TraceabilityReportData {
  requirements: {
    id: string;
    title: string;
    status: string;
    coverage: CoverageState;
    implemented_by: (ItemRef & { children: ItemRef[] })[];
    affected_by: (ItemRef & { severity: string | null })[];
  }[];
}

export interface ReportDataMap {
  summary: SummaryData;
  coverage: CoverageReportData;
  board: BoardReportData;
  drift: DriftReportData;
  lint: LintReportData;
  traceability: TraceabilityReportData;
}

export interface ReportResponse<K extends ReportKind = ReportKind> {
  kind: K;
  markdown: string;
  data: ReportDataMap[K];
}

export type ExportPart = 'summary' | 'requirements' | 'backlog' | 'history' | 'json';

export interface ExportInput {
  only?: ExportPart[];
  since?: string;
}

export interface ExportResult {
  out_dir: string;
  files: string[];
}

import { DRIFT_MESSAGES, type DriftRule, driftRules } from './coverage.js';
import { lintItem } from './lint.js';
import {
  CLOSED_STATUSES,
  COVERAGE_STATES,
  type CoverageState,
  type Item,
  type ItemRef,
  KINDS,
  type Kind,
  type Relation,
  type ReportKind,
  SEVERITIES,
  STATUSES,
} from './schema.js';

export interface LinkRow {
  src: string;
  rel: Relation;
  dst: string;
  created_at: string;
}

export interface LastImport {
  source: string;
  repo: string;
  at: string;
}

/** Everything a report needs, loaded once by the service (items in ID order, requirements carry `coverage`). */
export interface ReportSnapshot {
  projectName: string;
  root: string;
  vecAvailable: boolean;
  items: Item[];
  links: LinkRow[];
  implementers: Map<string, ItemRef[]>;
  lastImports: LastImport[];
}

export interface Report<T = unknown> {
  kind: ReportKind;
  markdown: string;
  data: T;
}

export const BOARD_COLUMNS = ['backlog', 'ready', 'in_progress', 'review', 'done'] as const;
const WORK_KINDS: readonly Kind[] = ['story', 'task', 'bug'];

type Cell = string | number | boolean | null | undefined;

function cell(value: Cell): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** GitHub-flavoured Markdown table; `_None._` when there are no rows. */
export function mdTable(headers: readonly string[], rows: readonly Cell[][]): string {
  if (rows.length === 0) return '_None._';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

export function refLabel(ref: ItemRef): string {
  return `${ref.id} (${ref.status})`;
}

const toRef = (item: ItemRef): ItemRef => ({ id: item.id, kind: item.kind, title: item.title, status: item.status });

function implementsOf(snapshot: ReportSnapshot, id: string): string[] {
  return snapshot.links.filter((link) => link.src === id && link.rel === 'implements').map((link) => link.dst);
}

// ---- summary ---------------------------------------------------------------------------------

export interface SummaryData {
  project_name: string;
  root: string;
  initialized: true;
  counts: Record<Kind, Record<string, number>>;
  coverage: Record<CoverageState, number>;
  open_bugs_by_severity: Record<string, number>;
  drift_count: number;
  last_imports: LastImport[];
  vec_available: boolean;
}

export function countsByKind(items: readonly Pick<Item, 'kind' | 'status'>[]): Record<Kind, Record<string, number>> {
  const counts = Object.fromEntries(
    KINDS.map((kind) => [kind, Object.fromEntries(STATUSES[kind].map((status) => [status, 0]))]),
  ) as Record<Kind, Record<string, number>>;
  for (const item of items) counts[item.kind][item.status] = (counts[item.kind][item.status] ?? 0) + 1;
  return counts;
}

export function summaryData(snapshot: ReportSnapshot): SummaryData {
  const coverage = Object.fromEntries(COVERAGE_STATES.map((state) => [state, 0])) as Record<CoverageState, number>;
  for (const item of snapshot.items) if (item.coverage) coverage[item.coverage] += 1;
  const bugs: Record<string, number> = Object.fromEntries([...SEVERITIES, 'unspecified'].map((severity) => [severity, 0]));
  for (const item of snapshot.items) {
    if (item.kind === 'bug' && item.status !== 'done' && item.status !== 'cancelled') bugs[item.severity ?? 'unspecified']! += 1;
  }
  return {
    project_name: snapshot.projectName,
    root: snapshot.root,
    initialized: true,
    counts: countsByKind(snapshot.items),
    coverage,
    open_bugs_by_severity: bugs,
    drift_count: driftData(snapshot).drift.length,
    last_imports: snapshot.lastImports,
    vec_available: snapshot.vecAvailable,
  };
}

export function countsMarkdown(counts: Record<Kind, Record<string, number>>): string {
  return mdTable(
    ['Kind', 'Total', 'By status'],
    KINDS.map((kind) => {
      const entries = Object.entries(counts[kind]);
      const total = entries.reduce((sum, [, count]) => sum + count, 0);
      const breakdown = entries.filter(([, count]) => count > 0).map(([status, count]) => `${status} ${count}`);
      return [kind, total, breakdown.join(', ') || '–'];
    }),
  );
}

function summaryReport(snapshot: ReportSnapshot): Report<SummaryData> {
  const data = summaryData(snapshot);
  const markdown = [
    `# overseer summary: ${data.project_name}`,
    '',
    `Root: \`${data.root}\`  `,
    `Search: ${data.vec_available ? 'semantic + keyword' : 'keyword only (sqlite-vec unavailable)'}`,
    '',
    '## Items',
    '',
    countsMarkdown(data.counts),
    '',
    '## Requirement coverage',
    '',
    mdTable(['Coverage', 'Requirements'], COVERAGE_STATES.map((state) => [state, data.coverage[state]])),
    '',
    '## Open bugs by severity',
    '',
    mdTable(['Severity', 'Open bugs'], Object.entries(data.open_bugs_by_severity)),
    '',
    `## Drift`,
    '',
    data.drift_count === 0 ? 'No drift between requirement statuses and work items.' : `${data.drift_count} drift issue(s); run \`report drift\`.`,
    '',
    '## Last imports',
    '',
    data.last_imports.length === 0
      ? '_None._'
      : mdTable(['Source', 'Repository', 'At'], data.last_imports.map((entry) => [entry.source, entry.repo, entry.at])),
  ].join('\n');
  return { kind: 'summary', markdown, data };
}

// ---- coverage --------------------------------------------------------------------------------

export interface CoverageRow {
  id: string;
  title: string;
  req_type: string | null;
  priority: string;
  status: string;
  coverage: CoverageState;
  implemented_by: ItemRef[];
}

export function coverageData(snapshot: ReportSnapshot): { requirements: CoverageRow[] } {
  return {
    requirements: snapshot.items
      .filter((item) => item.kind === 'requirement')
      .map((item) => ({
        id: item.id,
        title: item.title,
        req_type: item.req_type,
        priority: item.priority,
        status: item.status,
        coverage: item.coverage!,
        implemented_by: snapshot.implementers.get(item.id) ?? [],
      })),
  };
}

function coverageReport(snapshot: ReportSnapshot): Report<{ requirements: CoverageRow[] }> {
  const data = coverageData(snapshot);
  const markdown = [
    '# Requirement coverage',
    '',
    mdTable(
      ['ID', 'Title', 'Type', 'Priority', 'Status', 'Coverage', 'Implemented by'],
      data.requirements.map((row) => [
        row.id,
        row.title,
        row.req_type,
        row.priority,
        row.status,
        row.coverage,
        row.implemented_by.map(refLabel).join(', '),
      ]),
    ),
  ].join('\n');
  return { kind: 'coverage', markdown, data };
}

// ---- board -----------------------------------------------------------------------------------

export interface BoardCard {
  id: string;
  kind: Kind;
  title: string;
  priority: string;
  assignee: string | null;
  implements: string[];
}

export interface BoardData {
  columns: { status: string; items: BoardCard[] }[];
}

export function boardData(snapshot: ReportSnapshot): BoardData {
  const work = snapshot.items.filter((item) => WORK_KINDS.includes(item.kind));
  return {
    columns: BOARD_COLUMNS.map((status) => ({
      status,
      items: work
        .filter((item) => item.status === status)
        .map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          priority: item.priority,
          assignee: item.assignee,
          implements: implementsOf(snapshot, item.id),
        })),
    })),
  };
}

export function boardColumnsMarkdown(data: BoardData, heading = '##'): string {
  return data.columns
    .map((column) =>
      [
        `${heading} ${column.status} (${column.items.length})`,
        '',
        mdTable(
          ['ID', 'Kind', 'Title', 'Priority', 'Assignee', 'Implements'],
          column.items.map((card) => [card.id, card.kind, card.title, card.priority, card.assignee, card.implements.join(', ')]),
        ),
      ].join('\n'),
    )
    .join('\n\n');
}

function boardReport(snapshot: ReportSnapshot): Report<BoardData> {
  const data = boardData(snapshot);
  return { kind: 'board', markdown: `# Board\n\n${boardColumnsMarkdown(data)}`, data };
}

// ---- drift -----------------------------------------------------------------------------------

export interface DriftEntry {
  id: string;
  title: string;
  status: string;
  coverage: CoverageState;
  rule: DriftRule;
  message: string;
  work: ItemRef[];
}

export function driftData(snapshot: ReportSnapshot): { drift: DriftEntry[] } {
  const drift: DriftEntry[] = [];
  for (const item of snapshot.items) {
    if (item.kind !== 'requirement') continue;
    const work = snapshot.implementers.get(item.id) ?? [];
    for (const rule of driftRules(item.status, work)) {
      drift.push({
        id: item.id,
        title: item.title,
        status: item.status,
        coverage: item.coverage!,
        rule,
        message: DRIFT_MESSAGES[rule],
        work: work.filter((ref) => ref.status !== 'cancelled'),
      });
    }
  }
  return { drift };
}

export function driftMarkdown(data: { drift: DriftEntry[] }): string {
  return mdTable(
    ['ID', 'Title', 'Status', 'Rule', 'Work', 'Action'],
    data.drift.map((entry) => [entry.id, entry.title, entry.status, entry.rule, entry.work.map(refLabel).join(', '), entry.message]),
  );
}

function driftReport(snapshot: ReportSnapshot): Report<{ drift: DriftEntry[] }> {
  const data = driftData(snapshot);
  return { kind: 'drift', markdown: `# Drift\n\n${driftMarkdown(data)}`, data };
}

// ---- lint ------------------------------------------------------------------------------------

export interface LintEntry {
  id: string;
  kind: Kind;
  title: string;
  rule: string;
  severity: 'warn' | 'info';
  message: string;
}

function lintReport(snapshot: ReportSnapshot): Report<{ warnings: LintEntry[] }> {
  const warnings: LintEntry[] = [];
  for (const item of snapshot.items) {
    if (CLOSED_STATUSES[item.kind].includes(item.status)) continue;
    for (const warning of lintItem(item)) warnings.push({ id: item.id, kind: item.kind, title: item.title, ...warning });
  }
  const markdown = [
    '# Lint',
    '',
    mdTable(
      ['ID', 'Title', 'Rule', 'Severity', 'Message'],
      warnings.map((entry) => [entry.id, entry.title, entry.rule, entry.severity, entry.message]),
    ),
  ].join('\n');
  return { kind: 'lint', markdown, data: { warnings } };
}

// ---- traceability ----------------------------------------------------------------------------

export interface TraceRow {
  id: string;
  title: string;
  status: string;
  coverage: CoverageState;
  implemented_by: (ItemRef & { children: ItemRef[] })[];
  affected_by: (ItemRef & { severity: string | null })[];
}

export function traceabilityData(snapshot: ReportSnapshot): { requirements: TraceRow[] } {
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  return {
    requirements: snapshot.items
      .filter((item) => item.kind === 'requirement')
      .map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        coverage: item.coverage!,
        implemented_by: (snapshot.implementers.get(item.id) ?? []).map((ref) => ({
          ...ref,
          children: snapshot.items.filter((child) => child.parent_id === ref.id).map(toRef),
        })),
        affected_by: snapshot.links
          .filter((link) => link.rel === 'affects' && link.dst === item.id)
          .map((link) => byId.get(link.src)!)
          .map((bug) => ({ ...toRef(bug), severity: bug.severity })),
      })),
  };
}

function traceabilityReport(snapshot: ReportSnapshot): Report<{ requirements: TraceRow[] }> {
  const data = traceabilityData(snapshot);
  const sections = data.requirements.map((row) => {
    const lines = [`## ${row.id} — ${row.title} (${row.status}, ${row.coverage})`, ''];
    if (row.implemented_by.length === 0) lines.push('- No implementing stories or tasks.');
    for (const work of row.implemented_by) {
      lines.push(`- ${work.id} ${work.title} (${work.kind}, ${work.status})`);
      for (const child of work.children) lines.push(`  - ${child.id} ${child.title} (${child.kind}, ${child.status})`);
    }
    for (const bug of row.affected_by) lines.push(`- Bug ${bug.id} ${bug.title} (${bug.status}${bug.severity ? `, ${bug.severity}` : ''})`);
    return lines.join('\n');
  });
  return { kind: 'traceability', markdown: ['# Traceability', '', ...(sections.length ? sections : ['_None._'])].join('\n\n'), data };
}

export interface ReportDataMap {
  summary: SummaryData;
  coverage: { requirements: CoverageRow[] };
  board: BoardData;
  drift: { drift: DriftEntry[] };
  lint: { warnings: LintEntry[] };
  traceability: { requirements: TraceRow[] };
}

const BUILDERS: { [K in ReportKind]: (snapshot: ReportSnapshot) => Report<ReportDataMap[K]> } = {
  summary: summaryReport,
  coverage: coverageReport,
  board: boardReport,
  drift: driftReport,
  lint: lintReport,
  traceability: traceabilityReport,
};

export function buildReport<K extends ReportKind>(kind: K, snapshot: ReportSnapshot): Report<ReportDataMap[K]> {
  return BUILDERS[kind](snapshot);
}

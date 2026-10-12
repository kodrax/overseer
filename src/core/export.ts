import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { nowIso } from './db.js';
import { OverseerError } from './errors.js';
import { compareIds } from './ids.js';
import { packageVersion } from './paths.js';
import {
  boardColumnsMarkdown,
  boardData,
  countsMarkdown,
  driftData,
  driftMarkdown,
  mdTable,
  type ReportSnapshot,
  summaryData,
} from './reports.js';
import { COVERAGE_STATES, EXPORT_PARTS, type ExportPart, type Item, type ItemEvent } from './schema.js';
import type { OverseerService } from './service.js';

export interface ExportOptions {
  outDir?: string;
  only?: ExportPart[];
  since?: string;
}

export interface ExportResult {
  /** Relative to the project root. */
  out_dir: string;
  /** Written files, relative to the project root. */
  files: string[];
}

const FILE_BY_PART: Record<ExportPart, string> = {
  summary: 'README.md',
  requirements: 'requirements.md',
  backlog: 'backlog.md',
  history: 'history.md',
  json: 'overseer.json',
};

const RECENT_DAYS = 14;
const VALUE_MAX = 120;

/** Parses an ISO date (local midnight) or date-time; INVALID_INPUT otherwise. */
export function parseSince(since: string): number {
  const text = /^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T00:00:00` : since;
  const time = Date.parse(text);
  if (Number.isNaN(time)) throw new OverseerError('INVALID_INPUT', `Invalid date for since: "${since}" (use YYYY-MM-DD or ISO date-time).`);
  return time;
}

function short(value: string | null): string {
  if (value === null) return '';
  const flat = value.replace(/\s+/g, ' ');
  return flat.length > VALUE_MAX ? `${flat.slice(0, VALUE_MAX - 1)}…` : flat;
}

function change(event: ItemEvent): string {
  if (event.old_value === null && event.new_value === null) return '';
  return `${short(event.old_value)} → ${short(event.new_value)}`.trim();
}

function eventsTable(events: ItemEvent[], withItem: boolean): string {
  return mdTable(
    withItem ? ['At', 'Item', 'Action', 'Field', 'From → To', 'By', 'Via'] : ['At', 'Action', 'Field', 'From → To', 'By', 'Via'],
    events.map((event) => [
      event.at,
      ...(withItem ? [event.item_id] : []),
      event.action,
      event.field,
      change(event),
      event.actor,
      event.via,
    ]),
  );
}

const yesNo = (value: boolean) => (value ? 'yes' : 'no');

function readmeMarkdown(snapshot: ReportSnapshot, events: ItemEvent[], linkedFiles: string[]): string {
  const summary = summaryData(snapshot);
  const cutoff = Date.now() - RECENT_DAYS * 86_400_000;
  const lastChange = new Map<string, string>();
  for (const event of events) if (Date.parse(event.at) >= cutoff) lastChange.set(event.item_id, event.at);
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  const recent = [...lastChange.entries()]
    .filter(([id]) => byId.has(id))
    .sort(([a], [b]) => compareIds(a, b))
    .map(([id, at]) => {
      const item = byId.get(id)!;
      return [id, item.kind, item.title, item.status, at];
    });
  return [
    `# ${summary.project_name}: requirements and board`,
    '',
    linkedFiles.length > 0 ? `Files: ${linkedFiles.map((file) => `[${file}](${file})`).join(' · ')}` : '',
    '',
    '## Items',
    '',
    countsMarkdown(summary.counts),
    '',
    '## Requirement coverage',
    '',
    mdTable(['Coverage', 'Requirements'], COVERAGE_STATES.map((state) => [state, summary.coverage[state]])),
    '',
    '## Open bugs by severity',
    '',
    mdTable(['Severity', 'Open bugs'], Object.entries(summary.open_bugs_by_severity)),
    '',
    '## Drift',
    '',
    driftMarkdown(driftData(snapshot)),
    '',
    `## Changed in the last ${RECENT_DAYS} days`,
    '',
    mdTable(['ID', 'Kind', 'Title', 'Status', 'Last change'], recent),
  ].join('\n');
}

function requirementSection(item: Item, snapshot: ReportSnapshot, events: ItemEvent[]): string {
  const outgoing = snapshot.links.filter((link) => link.src === item.id);
  const incoming = snapshot.links.filter((link) => link.dst === item.id);
  const byId = new Map(snapshot.items.map((entry) => [entry.id, entry]));
  const fields: [string, string | null | undefined][] = [
    ['Type', item.req_type],
    ['NFR category', item.nfr_category],
    ['Priority', item.priority],
    ['Status', item.status],
    ['Coverage', item.coverage],
    ['In backlog', yesNo(item.in_backlog)],
    ['Asked by', item.asked_by],
    ['Source', item.source],
    ['Recorded via', item.recorded_via],
    ['Verification', item.verification_method],
    ['Parent', item.parent_id],
    ['Component', item.component],
    ['Tags', item.tags.join(', ')],
    ['Code refs', item.code_refs.join(', ')],
    ['Assignee', item.assignee],
    ['Milestone', item.milestone],
    ['External', item.external_url ?? item.external_ref],
    ['Delivered', item.delivered_at ? `${item.delivered_at}${item.delivered_in ? ` in ${item.delivered_in}` : ''}` : item.delivered_in],
    ['Created', item.created_at],
    ['Updated', item.updated_at],
    ['Status changed', item.status_changed_at],
  ];
  const linkLine = (direction: '→' | '←', rel: string, id: string) => {
    const other = byId.get(id);
    return `- ${rel} ${direction} ${other ? `${other.id} ${other.title} (${other.kind}, ${other.status})` : id}`;
  };
  return [
    `### ${item.id} — ${item.title}`,
    '',
    mdTable(['Field', 'Value'], fields.filter(([, value]) => value !== null && value !== undefined && value !== '')),
    '',
    '**Statement**',
    '',
    item.description || '_None._',
    ...(item.rationale ? ['', '**Rationale**', '', item.rationale] : []),
    '',
    '**Acceptance criteria**',
    '',
    item.acceptance_criteria.length > 0 ? item.acceptance_criteria.map((criterion) => `- [ ] ${criterion}`).join('\n') : '_None._',
    ...(item.fit_criterion ? ['', `**Fit criterion:** ${item.fit_criterion}`] : []),
    '',
    '**Links**',
    '',
    outgoing.length + incoming.length > 0
      ? [...outgoing.map((link) => linkLine('→', link.rel, link.dst)), ...incoming.map((link) => linkLine('←', link.rel, link.src))].join('\n')
      : '_None._',
    '',
    '**History**',
    '',
    eventsTable(
      events.filter(
        (event) =>
          event.item_id === item.id ||
          ((event.action === 'link' || event.action === 'unlink') && (event.new_value === item.id || event.old_value === item.id)),
      ),
      true,
    ),
  ].join('\n');
}

function requirementsMarkdown(snapshot: ReportSnapshot, events: ItemEvent[]): string {
  const requirements = snapshot.items.filter((item) => item.kind === 'requirement');
  return [
    `# Requirements: ${snapshot.projectName}`,
    '',
    mdTable(
      ['ID', 'Title', 'Type', 'NFR category', 'Priority', 'Status', 'Coverage', 'In backlog', 'Asked by', 'Created'],
      requirements.map((item) => [
        item.id,
        item.title,
        item.req_type,
        item.nfr_category,
        item.priority,
        item.status,
        item.coverage,
        yesNo(item.in_backlog),
        item.asked_by,
        item.created_at,
      ]),
    ),
    ...requirements.flatMap((item) => ['', requirementSection(item, snapshot, events)]),
  ].join('\n');
}

function backlogMarkdown(snapshot: ReportSnapshot): string {
  const label = (item: Item) => `${item.id} ${item.title} (${item.status})`;
  const childrenOf = (id: string, kind: Item['kind']) => snapshot.items.filter((item) => item.parent_id === id && item.kind === kind);
  const tree: string[] = [];
  for (const epic of snapshot.items.filter((item) => item.kind === 'epic')) {
    tree.push(`- ${label(epic)}`);
    for (const story of childrenOf(epic.id, 'story')) {
      tree.push(`  - ${label(story)}`);
      for (const task of childrenOf(story.id, 'task')) tree.push(`    - ${label(task)}`);
    }
  }
  const orphanStories = snapshot.items.filter((item) => item.kind === 'story' && !item.parent_id);
  if (orphanStories.length > 0) {
    tree.push('- Stories without epic');
    for (const story of orphanStories) {
      tree.push(`  - ${label(story)}`);
      for (const task of childrenOf(story.id, 'task')) tree.push(`    - ${label(task)}`);
    }
  }
  const orphanTasks = snapshot.items.filter((item) => item.kind === 'task' && !item.parent_id);
  if (orphanTasks.length > 0) {
    tree.push('- Tasks without story');
    for (const task of orphanTasks) tree.push(`  - ${label(task)}`);
  }
  const bugs = snapshot.items.filter((item) => item.kind === 'bug');
  return [
    `# Backlog: ${snapshot.projectName}`,
    '',
    '## Board',
    '',
    boardColumnsMarkdown(boardData(snapshot), '###'),
    '',
    '## Epics',
    '',
    tree.length > 0 ? tree.join('\n') : '_None._',
    '',
    '## Bugs',
    '',
    mdTable(
      ['ID', 'Title', 'Severity', 'Status', 'Affects'],
      bugs.map((bug) => [
        bug.id,
        bug.title,
        bug.severity,
        bug.status,
        snapshot.links
          .filter((link) => link.src === bug.id && link.rel === 'affects')
          .map((link) => link.dst)
          .join(', '),
      ]),
    ),
  ].join('\n');
}

function historyMarkdown(snapshot: ReportSnapshot, events: ItemEvent[], since?: string): string {
  return [
    `# History: ${snapshot.projectName}`,
    '',
    since ? `Events since ${since}, newest first.` : 'All events, newest first.',
    '',
    eventsTable([...events].reverse(), true),
  ].join('\n');
}

/** Writes the selected export files (S9) into `<root>/<outDir | meta.export_dir>`. */
export function exportReports(service: OverseerService, options: ExportOptions = {}): ExportResult {
  const only = options.only && options.only.length > 0 ? options.only : [...EXPORT_PARTS];
  for (const part of only) {
    if (!(EXPORT_PARTS as readonly string[]).includes(part)) {
      throw new OverseerError('INVALID_INPUT', `Unknown export part "${part}"; valid: ${EXPORT_PARTS.join(', ')}.`);
    }
  }
  const sinceTime = options.since === undefined ? undefined : parseSince(options.since);
  const outDir = options.outDir || service.getMeta('export_dir') || 'docs/overseer';
  const absoluteDir = service.resolveInside(outDir);

  const snapshot = service.snapshot();
  const events = service.db.prepare('SELECT * FROM events ORDER BY seq').all() as unknown as ItemEvent[];
  const plainEvents = events.map((event) => ({ ...event }));
  const historyEvents = sinceTime === undefined ? plainEvents : plainEvents.filter((event) => Date.parse(event.at) >= sinceTime);
  const header = `<!-- Generated by overseer-cli ${packageVersion()} on ${nowIso()}. Do not edit; run "overseer export" to regenerate. -->`;

  mkdirSync(absoluteDir, { recursive: true });
  const linkedFiles = EXPORT_PARTS.filter((part) => part !== 'summary')
    .map((part) => FILE_BY_PART[part])
    .filter((file) => only.some((part) => FILE_BY_PART[part] === file) || existsSync(join(absoluteDir, file)));

  const contents: Record<ExportPart, () => string> = {
    summary: () => `${header}\n${readmeMarkdown(snapshot, plainEvents, linkedFiles)}\n`,
    requirements: () => `${header}\n${requirementsMarkdown(snapshot, plainEvents)}\n`,
    backlog: () => `${header}\n${backlogMarkdown(snapshot)}\n`,
    history: () => `${header}\n${historyMarkdown(snapshot, historyEvents, options.since)}\n`,
    json: () =>
      `${JSON.stringify(
        {
          format: 'overseer-export/1',
          generated_at: nowIso(),
          project: { name: snapshot.projectName, root_name: basename(service.root) },
          items: snapshot.items,
          links: snapshot.links,
          events: plainEvents,
        },
        null,
        2,
      )}\n`,
  };

  const files: string[] = [];
  for (const part of EXPORT_PARTS) {
    if (!only.includes(part)) continue;
    const file = join(absoluteDir, FILE_BY_PART[part]);
    writeFileSync(file, contents[part]());
    files.push(relative(service.root, file));
  }
  return { out_dir: relative(service.root, absoluteDir), files };
}

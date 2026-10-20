import type { Command } from 'commander';
import { OverseerError } from '../../core/errors.js';
import {
  type BugDetails,
  COVERAGE_STATES,
  type ItemEvent,
  KINDS,
  type LintWarning,
  RELATIONS,
  REQ_TYPES,
} from '../../core/schema.js';
import type { SimilarMatch } from '../../core/search.js';
import { type CreateResult, type ItemDetail, type LinkResult, type ListResult, MAX_ITEM_IDS, type UpdateResult } from '../../core/service.js';
import { fields, list, similarity, table } from '../format.js';
import { collect, collectList, oneOf, parseInteger, parseNumber } from '../options.js';
import type { CliRuntime } from '../runtime.js';

interface FieldOptions {
  title?: string;
  description?: string;
  type?: string;
  nfrCategory?: string;
  priority?: string;
  status?: string;
  rationale?: string;
  ac?: string[];
  fit?: string;
  verification?: string;
  askedBy?: string;
  source?: string;
  parent?: string;
  assignee?: string;
  estimate?: number;
  milestone?: string;
  severity?: string;
  steps?: string[];
  expected?: string;
  actual?: string;
  environment?: string;
  tag?: string[];
  component?: string;
  codeRef?: string[];
  inBacklog?: boolean;
  json?: boolean;
}

interface AddOptions extends FieldOptions {
  link?: string[];
  implements?: string[];
  allowDuplicate?: boolean;
}

interface UpdateOptions extends FieldOptions {
  comment?: string;
  deliveredIn?: string;
  clear?: string[];
}

interface ListOptions {
  kind?: string;
  status?: string[];
  type?: string;
  coverage?: string[];
  tag?: string;
  parent?: string;
  all?: boolean;
  limit?: number;
  offset?: number;
  json?: boolean;
}

/** `--clear <field>` targets: nullable columns become null, list columns become []. */
const CLEAR_TO_NULL = [
  'nfr_category',
  'rationale',
  'fit_criterion',
  'verification_method',
  'asked_by',
  'source',
  'parent_id',
  'assignee',
  'estimate',
  'milestone',
  'severity',
  'bug_details',
  'component',
  'delivered_in',
] as const;
const CLEAR_TO_EMPTY = ['acceptance_criteria', 'tags', 'code_refs'] as const;
const CLEARABLE: readonly string[] = [...CLEAR_TO_NULL, ...CLEAR_TO_EMPTY];

/** Item field flags shared by `add` and `update`. */
function addFieldOptions(command: Command): Command {
  return command
    .option('--description <text>', 'statement (requirements: EARS "When <trigger>, the <system> shall <response>")')
    .option('--type <type>', 'requirement type: functional | non_functional')
    .option('--nfr-category <category>', 'ISO 25010 category of a non-functional requirement')
    .option('--priority <priority>', 'must | should | could | wont')
    .option('--status <status>', 'status of the item kind')
    .option('--rationale <text>', 'why it exists')
    .option('--ac <text>', 'acceptance criterion (repeatable)', collect)
    .option('--fit <text>', 'fit criterion: measurable target')
    .option('--verification <method>', 'test | inspection | analysis | demonstration')
    .option('--asked-by <name>', 'who asked for it')
    .option('--source <text>', 'provenance: conversation, file path, meeting, URL')
    .option('--parent <id>', 'parent item id')
    .option('--assignee <name>', 'assignee')
    .option('--estimate <points>', 'estimate in story points', parseNumber)
    .option('--milestone <name>', 'sprint or release')
    .option('--severity <severity>', 'bug severity: critical | major | minor | trivial')
    .option('--steps <text>', 'bug reproduction step (repeatable)', collect)
    .option('--expected <text>', 'bug: expected behaviour')
    .option('--actual <text>', 'bug: actual behaviour')
    .option('--environment <text>', 'bug: environment')
    .option('--tag <tag>', 'tag (repeatable)', collect)
    .option('--component <name>', 'component')
    .option('--code-ref <ref>', 'code reference (repeatable)', collect)
    .option('--in-backlog', 'mark as tracked in the backlog');
}

function fieldInput(options: FieldOptions): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const entries: [string, unknown][] = [
    ['title', options.title],
    ['description', options.description],
    ['req_type', options.type],
    ['nfr_category', options.nfrCategory],
    ['priority', options.priority],
    ['status', options.status],
    ['rationale', options.rationale],
    ['acceptance_criteria', options.ac],
    ['fit_criterion', options.fit],
    ['verification_method', options.verification],
    ['asked_by', options.askedBy],
    ['source', options.source],
    ['parent_id', options.parent],
    ['assignee', options.assignee],
    ['estimate', options.estimate],
    ['milestone', options.milestone],
    ['severity', options.severity],
    ['tags', options.tag],
    ['component', options.component],
    ['code_refs', options.codeRef],
    ['in_backlog', options.inBacklog],
  ];
  for (const [key, value] of entries) if (value !== undefined) input[key] = value;
  return input;
}

/** Bug flags merged over the stored details (`base`, read only when a bug flag is given); undefined without bug flags. */
function bugDetails(options: FieldOptions, base: () => BugDetails | null): BugDetails | undefined {
  if ([options.steps, options.expected, options.actual, options.environment].every((value) => value === undefined)) return undefined;
  const stored = base();
  const environment = options.environment ?? stored?.environment;
  return {
    steps: options.steps ?? stored?.steps ?? [],
    expected: options.expected ?? stored?.expected ?? '',
    actual: options.actual ?? stored?.actual ?? '',
    ...(environment !== undefined ? { environment } : {}),
  };
}

function parseLink(spec: string): { rel: string; to: string } {
  const separator = spec.indexOf(':');
  if (separator <= 0 || separator === spec.length - 1) {
    throw new OverseerError('INVALID_INPUT', `Invalid --link "${spec}"; use <rel>:<id> with rel one of ${RELATIONS.join(', ')}.`);
  }
  return { rel: spec.slice(0, separator), to: spec.slice(separator + 1) };
}

function warningLines(warnings: readonly LintWarning[]): string[] {
  return warnings.map((warning) => `${warning.severity === 'warn' ? 'warning' : 'info'}: [${warning.rule}] ${warning.message}`);
}

export function matchesTable(matches: readonly SimilarMatch[]): string {
  return table(
    ['ID', 'Kind', 'Status', 'Match', 'Similarity', 'Coverage', 'Title'],
    matches.map((match) => [match.id, match.kind, match.status, match.match, similarity(match.similarity), match.coverage, match.title]),
  );
}

function formatCreate(result: CreateResult): string {
  if (!result.created) {
    return [
      'Not created: possible duplicate of existing items.',
      matchesTable(result.candidates),
      'Update the existing item, link it (e.g. --link refines:<id>), or pass --allow-duplicate to create it anyway.',
    ].join('\n');
  }
  const lines = [`Created ${result.item.id}  ${result.item.title}`, ...warningLines(result.warnings)];
  for (const match of result.similar) lines.push(`similar: ${match.id} (${match.match ?? 'match'} ${similarity(match.similarity)})  ${match.title}`);
  return lines.join('\n');
}

function formatUpdate(result: UpdateResult): string {
  const head =
    result.changed_fields.length > 0 ? `Updated ${result.item.id}: ${result.changed_fields.join(', ')}` : `No field changes to ${result.item.id}`;
  return [head, ...warningLines(result.warnings)].join('\n');
}

function formatHistory(history: readonly ItemEvent[], id: string): string {
  return table(
    ['At', 'Action', 'Field', 'From', 'To', 'By', 'Via'],
    history.map((event) => [
      event.at,
      event.item_id === id ? event.action : `${event.action} (${event.item_id})`,
      event.field,
      event.old_value,
      event.new_value,
      event.actor,
      event.via,
    ]),
  );
}

function formatDetail(detail: ItemDetail): string {
  const { item } = detail;
  const sections = [
    `${item.id}  ${item.title}`,
    fields([
      ['kind', item.kind],
      ['status', item.status],
      ['priority', item.priority],
      ['type', item.req_type],
      ['nfr category', item.nfr_category],
      ['coverage', item.coverage],
      ['in backlog', item.kind === 'requirement' ? item.in_backlog : undefined],
      ['parent', item.parent_id],
      ['asked by', item.asked_by],
      ['source', item.source],
      ['recorded via', item.recorded_via],
      ['assignee', item.assignee],
      ['estimate', item.estimate],
      ['milestone', item.milestone],
      ['severity', item.severity],
      ['component', item.component],
      ['tags', item.tags.length > 0 ? item.tags.join(', ') : undefined],
      ['code refs', item.code_refs.length > 0 ? item.code_refs.join(', ') : undefined],
      ['fit criterion', item.fit_criterion],
      ['verification', item.verification_method],
      ['external', item.external_ref],
      ['external url', item.external_url],
      ['delivered at', item.delivered_at],
      ['delivered in', item.delivered_in],
      ['created', item.created_at],
      ['updated', item.updated_at],
    ]),
  ];
  if (item.description) sections.push(`Description:\n  ${item.description.replace(/\n/g, '\n  ')}`);
  if (item.rationale) sections.push(`Rationale:\n  ${item.rationale.replace(/\n/g, '\n  ')}`);
  if (item.acceptance_criteria.length > 0) sections.push(`Acceptance criteria:\n${item.acceptance_criteria.map((ac) => `  - ${ac}`).join('\n')}`);
  if (item.bug_details) {
    const bug = item.bug_details;
    sections.push(
      [
        'Bug details:',
        ...bug.steps.map((step, index) => `  ${index + 1}. ${step}`),
        `  expected: ${bug.expected || '-'}`,
        `  actual: ${bug.actual || '-'}`,
        ...(bug.environment ? [`  environment: ${bug.environment}`] : []),
      ].join('\n'),
    );
  }
  const links = [
    ...detail.links.outgoing.map((link) => [`→ ${link.rel}`, link.id, link.kind, link.status, link.title]),
    ...detail.links.incoming.map((link) => [`← ${link.rel}`, link.id, link.kind, link.status, link.title]),
  ];
  if (links.length > 0) sections.push(`Links:\n${table(['Rel', 'ID', 'Kind', 'Status', 'Title'], links)}`);
  if (detail.children.length > 0) {
    sections.push(`Children:\n${table(['ID', 'Kind', 'Status', 'Title'], detail.children.map((child) => [child.id, child.kind, child.status, child.title]))}`);
  }
  if (detail.parent) sections.push(`Parent:\n${table(['ID', 'Kind', 'Status', 'Title'], [[detail.parent.id, detail.parent.kind, detail.parent.status, detail.parent.title]])}`);
  if (detail.requirements && detail.requirements.length > 0) {
    const requirements = detail.requirements.map((requirement) =>
      [
        `  ${requirement.rel} ${requirement.id}  ${requirement.title} (${requirement.status})`,
        ...requirement.acceptance_criteria.map((ac) => `    - ${ac}`),
      ].join('\n'),
    );
    sections.push(`Requirements:\n${requirements.join('\n')}`);
  }
  if (detail.history) sections.push(`History:\n${formatHistory(detail.history, item.id)}`);
  return sections.join('\n\n');
}

function formatList(result: ListResult): string {
  if (result.items.length === 0) return result.total > 0 ? `No items on this page (${result.total} total).` : 'No items.';
  const withCoverage = result.items.some((item) => item.coverage !== undefined);
  const headers = ['ID', 'Kind', 'Status', 'Priority', ...(withCoverage ? ['Coverage'] : []), 'Parent', 'Title'];
  const rows = result.items.map((item) => [
    item.id,
    item.kind,
    item.status,
    item.priority,
    ...(withCoverage ? [item.coverage] : []),
    item.parent_id,
    item.title,
  ]);
  return `${table(headers, rows)}\n${result.items.length} of ${result.total} items`;
}

export function registerItemCommands(program: Command, rt: CliRuntime): void {
  addFieldOptions(
    program
      .command('add')
      .description('record a requirement, epic, story, task or bug')
      .argument('<kind>', `item kind: ${KINDS.join(' | ')}`)
      .requiredOption('--title <title>', 'short title (≤100 chars)'),
  )
    .option('--link <rel:id>', 'link to another item, e.g. refines:REQ-0002 (repeatable)', collect)
    .option('--implements <id>', 'requirement this item implements (repeatable)', collect)
    .option('--allow-duplicate', 'create even when a possible duplicate exists')
    .option('--json', 'print JSON')
    .action(async (kind: string, options: AddOptions, command: Command) => {
      await rt.withService(command, 'write', async (service) => {
        const input: Record<string, unknown> = { kind, ...fieldInput(options) };
        const bug = bugDetails(options, () => null);
        if (bug) input.bug_details = bug;
        const links = [...(options.link ?? []).map(parseLink), ...(options.implements ?? []).map((to) => ({ rel: 'implements', to }))];
        if (links.length > 0) input.links = links;
        if (options.allowDuplicate) input.allow_duplicate = true;
        rt.emit(options.json, await service.createItem(input, rt.ctx), formatCreate);
      });
    });

  addFieldOptions(program.command('update').description('change fields or the status of an item').argument('<id>', 'item id').option('--title <title>', 'new title'))
    .option('--no-in-backlog', 'unmark as tracked in the backlog')
    .option('--comment <text>', 'add a comment to the history')
    .option('--delivered-in <ref>', 'release, PR or commit that delivered it')
    .option('--clear <field>', `clear a field (repeatable): ${CLEARABLE.join(', ')}`, collect)
    .option('--json', 'print JSON')
    .action(async (id: string, options: UpdateOptions, command: Command) => {
      await rt.withService(command, 'write', async (service) => {
        const input: Record<string, unknown> = { id, ...fieldInput(options) };
        if (options.comment !== undefined) input.comment = options.comment;
        if (options.deliveredIn !== undefined) input.delivered_in = options.deliveredIn;
        const bug = bugDetails(options, () => service.getItem(id).item.bug_details);
        if (bug) input.bug_details = bug;
        for (const field of options.clear ?? []) {
          oneOf(CLEARABLE, field, '--clear field');
          if (input[field] !== undefined) throw new OverseerError('INVALID_INPUT', `Cannot both set and clear "${field}".`);
          input[field] = (CLEAR_TO_EMPTY as readonly string[]).includes(field) ? [] : null;
        }
        rt.emit(options.json, await service.updateItem(input, rt.ctx), formatUpdate);
      });
    });

  program
    .command('show')
    .description('show items with their links, children and (optionally) context and history')
    .argument('<ids...>', `item ids (up to ${MAX_ITEM_IDS}); several print {items:[…]} with --json`)
    .option('--context', 'add the parent and the linked requirements with their acceptance criteria')
    .option('--history', 'include the change history')
    .option('--json', 'print JSON')
    .action(async (ids: string[], options: { context?: boolean; history?: boolean; json?: boolean }, command: Command) => {
      await rt.withService(command, 'read', (service) => {
        const detailOptions = { history: options.history === true, context: options.context === true };
        if (ids.length === 1) {
          rt.emit(options.json, service.getItem(ids[0]!, detailOptions), formatDetail);
          return;
        }
        rt.emit(options.json, service.getItems(ids, detailOptions), (result) => result.items.map(formatDetail).join(`\n\n${'─'.repeat(60)}\n\n`));
      });
    });

  program
    .command('list')
    .description('list items (closed ones hidden unless --all)')
    .option('--kind <kind>', `item kind: ${KINDS.join(' | ')}`)
    .option('--status <status>', 'status filter (repeatable or comma list)', collectList)
    .option('--type <type>', 'requirement type: functional | non_functional')
    .option('--coverage <state>', `coverage filter (repeatable or comma list): ${COVERAGE_STATES.join(', ')}`, collectList)
    .option('--tag <tag>', 'items carrying this tag')
    .option('--parent <id>', 'children of this item')
    .option('--all', 'include closed items')
    .option('--limit <n>', 'page size (default 50)', parseInteger)
    .option('--offset <n>', 'page offset', parseInteger)
    .option('--json', 'print JSON')
    .action(async (options: ListOptions, command: Command) => {
      await rt.withService(command, 'read', (service) => {
        const result = service.listItems({
          ...(options.kind !== undefined ? { kind: oneOf(KINDS, options.kind, 'kind') } : {}),
          ...(options.status ? { status: options.status } : {}),
          ...(options.type !== undefined ? { req_type: oneOf(REQ_TYPES, options.type, 'type') } : {}),
          ...(options.coverage ? { coverage: options.coverage.map((state) => oneOf(COVERAGE_STATES, state, 'coverage')) } : {}),
          ...(options.tag !== undefined ? { tag: options.tag } : {}),
          ...(options.parent !== undefined ? { parent_id: options.parent } : {}),
          include_closed: options.all === true,
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
          ...(options.offset !== undefined ? { offset: options.offset } : {}),
        });
        rt.emit(options.json, result, formatList);
      });
    });

  for (const [name, remove] of [
    ['link', false],
    ['unlink', true],
  ] as const) {
    program
      .command(name)
      .description(remove ? 'remove a relation between two items' : `relate two items (${RELATIONS.join(', ')})`)
      .argument('<src>', 'source item id')
      .argument('<rel>', `relation: ${RELATIONS.join(' | ')}`)
      .argument('<dst>', 'target item id')
      .option('--json', 'print JSON')
      .action(async (src: string, rel: string, dst: string, options: { json?: boolean }, command: Command) => {
        await rt.withService(command, 'write', (service) => {
          rt.emit(options.json, service.link(src, oneOf(RELATIONS, rel, 'relation'), dst, rt.ctx, remove), (result: LinkResult) =>
            `${result.linked ? 'Linked' : 'Unlinked'} ${result.src} ${result.rel} ${result.dst}`,
          );
        });
      });
  }
}

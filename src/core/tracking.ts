import { z } from 'zod';
import { OverseerError } from './errors.js';
import type { ImportSource } from './schema.js';

/** The parts of a repository's tracking setup that `overseer sync inspect` reports, in output order. */
export const TRACKING_PARTS = ['labels', 'issue_types', 'milestones', 'sub_issues', 'boards'] as const;
export type TrackingPart = (typeof TRACKING_PARTS)[number];

/**
 * A repository's tracking setup. Name lists are sorted and without duplicates; `sub_issues` says whether issues can
 * have parent and child issues. `null` means unknown (the bundle lacked the tool that answers it), never empty.
 */
export interface TrackingSetup {
  labels: string[] | null;
  issue_types: string[] | null;
  milestones: string[] | null;
  sub_issues: boolean | null;
  boards: string[] | null;
  /** One entry per unknown part, naming the tool that answers it. */
  warnings: string[];
}

type NamePart = Exclude<TrackingPart, 'sub_issues'>;
/** What one response says: names per part, and `sub_issues` true/false (undefined: the response does not tell). */
type Finding = Partial<Record<NamePart, string[]>> & { sub_issues?: boolean };

interface ToolReader {
  /** Bundle key: the MCP tool's name. */
  tool: string;
  /** The parts its responses answer. */
  parts: readonly TrackingPart[];
  /** How to call it, for warnings: `ui_get (method milestones)`. */
  call: string;
  /** The response is a JSON array, so several responses come as an array of arrays. */
  array: boolean;
  /** Expected shape, for INVALID_INPUT messages. */
  shape: string;
  schema: z.ZodType<Finding, unknown>;
}

const titles = (key: string) => z.object({ [key]: z.string() }).transform((value) => value[key]!);

/** GitHub REST sub-issue (issue_read get_sub_issues answers an array of them). */
const githubSubIssue = z.object({ number: z.number().nullish(), title: z.string().nullish() });
/** issue_read get_parent: `{"parent": {number, title, …}}`, or `{"parent": null}` for an issue without a parent. */
const githubParent = z.object({ number: z.number(), title: z.string() }).nullable();

const GITHUB: readonly ToolReader[] = [
  {
    tool: 'list_label',
    parts: ['labels'],
    call: 'list_label',
    array: false,
    shape: '{"labels": [{"name"}], "totalCount", "pageInfo"}',
    schema: z.object({ labels: z.array(titles('name')).nullable() }).transform(({ labels }) => ({ labels: labels ?? [] })),
  },
  {
    tool: 'get_label',
    parts: ['labels'],
    call: 'get_label',
    array: false,
    shape: '{"name", "color", "description"}',
    schema: titles('name').transform((name) => ({ labels: [name] })),
  },
  {
    tool: 'list_issue_types',
    parts: ['issue_types'],
    call: 'list_issue_types',
    array: true,
    shape: '[{"name", "is_enabled"}]',
    // Disabled issue types cannot be set on issues.
    schema: z
      .array(z.object({ name: z.string().nullish(), is_enabled: z.boolean().nullish() }).nullable())
      .nullable()
      .transform((types) => ({
        issue_types: (types ?? []).flatMap((type) => (type?.name && type.is_enabled !== false ? [type.name] : [])),
      })),
  },
  {
    tool: 'ui_get',
    parts: ['milestones'],
    call: 'ui_get (method milestones)',
    array: false,
    shape: '{"milestones": [{"title"}], "totalCount", "has_more"}',
    schema: z.object({ milestones: z.array(titles('title')).nullable() }).transform(({ milestones }) => ({ milestones: milestones ?? [] })),
  },
  {
    tool: 'issue_read',
    parts: ['sub_issues'],
    call: 'issue_read (method get_sub_issues)',
    array: true,
    shape:
      'the get_sub_issues answer [{"number", "title"}] (or {"sub_issues": [...]}), the get_parent answer {"parent"}, or the get answer {"number", "title", "has_parent", "has_children"}',
    schema: z.union([
      // get_sub_issues answered: the repository has sub-issues, even when this issue has none.
      z.array(githubSubIssue.nullable()).transform((): Finding => ({ sub_issues: true })),
      z.object({ sub_issues: z.array(githubSubIssue.nullable()).nullable() }).transform((): Finding => ({ sub_issues: true })),
      // get answered: its best-effort hierarchy flags are set only when the hierarchy could be read.
      z
        .object({
          number: z.number(),
          title: z.string(),
          has_parent: z.boolean().nullish(),
          has_children: z.boolean().nullish(),
          parent: z.unknown().optional(),
          sub_issues_summary: z.unknown().optional(),
        })
        .transform((issue): Finding => {
          const known = [issue.has_parent, issue.has_children].some((flag) => typeof flag === 'boolean');
          const linked = [issue.parent, issue.sub_issues_summary].some((value) => value !== undefined && value !== null);
          return known || linked ? { sub_issues: true } : {};
        }),
      // get_parent answered, with or without a parent: the repository has sub-issues.
      z.object({ parent: githubParent }).transform((): Finding => ({ sub_issues: true })),
    ]),
  },
  {
    tool: 'projects_list',
    parts: ['boards'],
    call: 'projects_list (method list_projects)',
    array: false,
    shape: '{"projects": [{"title", "number"}], "pageInfo"}',
    schema: z.object({ projects: z.array(titles('title')).nullable() }).transform(({ projects }) => ({ boards: projects ?? [] })),
  },
  {
    tool: 'projects_get',
    parts: ['boards'],
    call: 'projects_get (method get_project)',
    array: false,
    shape: '{"title", "number"} or {"project": {"title"}}',
    schema: z
      .union([z.object({ project: titles('title') }).transform(({ project }) => project), z.object({ title: z.string(), number: z.number() }).transform(({ title }) => title)])
      .transform((title) => ({ boards: [title] })),
  },
];

/**
 * list_work_item_statuses (index.ts listIssueStatuses): one work item type, the types it converts to (the other types the
 * namespace offers) and, from the hierarchy widget, the types it nests under and holds. Without either list the type
 * cannot have parent or child items.
 */
const gitlabWorkItemType = z
  .object({
    work_item_type: z.string(),
    supported_conversion_types: z.array(z.string()).nullish(),
    allowed_child_types: z.array(z.string()).nullish(),
    allowed_parent_types: z.array(z.string()).nullish(),
  })
  .transform((type): Finding => {
    const children = type.allowed_child_types ?? [];
    const parents = type.allowed_parent_types ?? [];
    return {
      issue_types: [type.work_item_type, ...(type.supported_conversion_types ?? [])],
      sub_issues: children.length > 0 || parents.length > 0,
    };
  });

const GITLAB: readonly ToolReader[] = [
  {
    tool: 'list_labels',
    parts: ['labels'],
    call: 'list_labels',
    array: true,
    shape: '[{"name", "color", "description"}]',
    schema: z.array(titles('name')).transform((labels) => ({ labels })),
  },
  {
    tool: 'get_label',
    parts: ['labels'],
    call: 'get_label',
    array: false,
    shape: '{"name", "color", "description"}',
    schema: titles('name').transform((name) => ({ labels: [name] })),
  },
  {
    tool: 'list_milestones',
    parts: ['milestones'],
    call: 'list_milestones',
    array: true,
    shape: '[{"title", "state"}]',
    schema: z.array(titles('title')).transform((milestones) => ({ milestones })),
  },
  {
    tool: 'list_group_milestones',
    parts: ['milestones'],
    call: 'list_group_milestones',
    array: true,
    shape: '[{"title", "state"}]',
    schema: z.array(titles('title')).transform((milestones) => ({ milestones })),
  },
  {
    tool: 'get_milestone',
    parts: ['milestones'],
    call: 'get_milestone',
    array: false,
    shape: '{"title", "state"}',
    schema: titles('title').transform((title) => ({ milestones: [title] })),
  },
  {
    tool: 'list_work_item_statuses',
    parts: ['issue_types', 'sub_issues'],
    call: 'list_work_item_statuses',
    array: false,
    shape: '{"work_item_type", "statuses", "supported_conversion_types", "allowed_child_types", "allowed_parent_types"}',
    schema: gitlabWorkItemType,
  },
  {
    tool: 'gitlab_api_request',
    parts: ['boards'],
    call: 'gitlab_api_request (GET projects/<id>/boards)',
    array: true,
    shape: 'the boards endpoint answer [{"id", "name", "lists"}]',
    schema: z.array(z.object({ name: z.string(), lists: z.array(z.unknown()).nullish() })).transform((boards) => ({ boards: boards.map((board) => board.name) })),
  },
];

const READERS: Readonly<Record<ImportSource, readonly ToolReader[]>> = { github: GITHUB, gitlab: GITLAB };

/** The bundle keys a source accepts, each with the parts it answers: `list_label (labels), get_label (labels), …`. */
export function bundleKeys(source: ImportSource): string {
  return READERS[source].map((reader) => `${reader.tool} (${reader.parts.join(', ')})`).join(', ');
}

/** INVALID_INPUT message tail. */
function acceptedParts(source: ImportSource): string {
  return `accepted parts for ${source}: ${bundleKeys(source)}`;
}

/** A string value is the tool's JSON text; anything else is already parsed. */
function parseText(value: unknown, tool: string, source: ImportSource): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new OverseerError('INVALID_INPUT', `${tool}: the response is text but not JSON; ${acceptedParts(source)}.`);
  }
}

/** The responses under one bundle key: a response, or an array of them (an array of arrays for array answers). */
function responsesOf(reader: ToolReader, value: unknown, source: ImportSource): unknown[] {
  const data = parseText(value, reader.tool, source);
  if (!Array.isArray(data)) return [data];
  const entries = data.map((entry) => (typeof entry === 'string' ? parseText(entry, reader.tool, source) : entry));
  if (!reader.array) return entries;
  // An array answer holds objects, so an array inside the array is one of several answers.
  return entries.some((entry) => Array.isArray(entry)) ? entries : [entries];
}

/** Locale-independent order: case-insensitive first, then by code unit, so equal input always sorts the same. */
function compareNames(a: string, b: string): number {
  const [left, right] = [a.toLowerCase(), b.toLowerCase()];
  if (left !== right) return left < right ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Summarises a bundle of raw GitHub (github/github-mcp-server) or GitLab (zereight/gitlab-mcp) MCP responses: a JSON
 * object keyed by tool name, each value the tool's answer (object or JSON text) or an array of answers. Pure: the
 * same responses in any order give the same result. A part no tool in the bundle answers is null with a warning
 * naming the tool; an unknown key or shape is INVALID_INPUT naming the accepted parts.
 */
export function inspectTracking(bundle: unknown, source: ImportSource): TrackingSetup {
  const readers = READERS[source];
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) {
    throw new OverseerError('INVALID_INPUT', `The bundle must be a JSON object keyed by MCP tool name; ${acceptedParts(source)}.`);
  }
  if (Object.keys(bundle).length === 0) throw new OverseerError('INVALID_INPUT', `The bundle is empty; ${acceptedParts(source)}.`);
  const entries = Object.entries(bundle as Record<string, unknown>);
  const unknown = entries.map(([key]) => key).filter((key) => !readers.some((reader) => reader.tool === key));
  if (unknown.length > 0) {
    throw new OverseerError('INVALID_INPUT', `Unknown part${unknown.length > 1 ? 's' : ''} ${unknown.sort().map((key) => `"${key}"`).join(', ')}; ${acceptedParts(source)}.`);
  }

  const names: Record<NamePart, Set<string> | null> = { labels: null, issue_types: null, milestones: null, boards: null };
  const evidence: boolean[] = [];
  for (const reader of readers) {
    if (!(reader.tool in bundle)) continue;
    for (const response of responsesOf(reader, (bundle as Record<string, unknown>)[reader.tool], source)) {
      const parsed = reader.schema.safeParse(response);
      if (!parsed.success) {
        throw new OverseerError('INVALID_INPUT', `${reader.tool}: not a ${reader.call} response (expected ${reader.shape}); ${acceptedParts(source)}.`);
      }
      for (const part of reader.parts) {
        if (part === 'sub_issues') {
          if (parsed.data.sub_issues !== undefined) evidence.push(parsed.data.sub_issues);
          continue;
        }
        const found = (names[part] ??= new Set());
        for (const name of parsed.data[part] ?? []) if (name.trim()) found.add(name.trim());
      }
    }
  }

  const sorted = (found: Set<string> | null) => (found ? [...found].sort(compareNames) : null);
  const setup: TrackingSetup = {
    labels: sorted(names.labels),
    issue_types: sorted(names.issue_types),
    milestones: sorted(names.milestones),
    sub_issues: evidence.includes(true) ? true : evidence.includes(false) ? false : null,
    boards: sorted(names.boards),
    warnings: [],
  };
  for (const part of TRACKING_PARTS) {
    if (setup[part] !== null) continue;
    const tools = readers.filter((reader) => reader.parts.includes(part));
    const calls = tools.map((reader) => reader.call).join(' or ');
    const asked = tools.filter((reader) => reader.tool in bundle).map((reader) => reader.tool);
    setup.warnings.push(
      asked.length > 0
        ? `${part}: unknown, the ${asked.join(' and ')} responses do not say; add ${calls}.`
        : `${part}: unknown, the bundle has no ${calls} response.`,
    );
  }
  return setup;
}

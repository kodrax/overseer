import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OverseerError } from './errors.js';
import { templatesDir } from './paths.js';
import { git, resolveProjectRoot } from './project.js';
import type { ItemDetail } from './service.js';

/** Conventional Commit types allowed in branch names and pull request titles (CONTRIBUTING.md). */
export const PR_TYPES = ['feat', 'fix', 'docs', 'test', 'ci', 'refactor', 'perf', 'build', 'chore'] as const;
export type PrType = (typeof PR_TYPES)[number];

/** Repository templates, in lookup order, relative to the checkout. */
export const REPO_TEMPLATES = ['.github/pull_request_template.md', '.gitlab/merge_request_templates/Default.md'] as const;
export const DEFAULT_TEMPLATE = 'pull_request_template.md';

const TITLE_MAX = 100;

export interface PrDraft {
  title: string;
  body: string;
}

/** Type from the branch name when it is `<type>/<id>-…`, else undefined. */
export function typeFromBranch(branch: string | undefined, id: string): PrType | undefined {
  if (!branch) return undefined;
  const match = /^([a-z]+)\/(.+)$/.exec(branch);
  if (!match || !(PR_TYPES as readonly string[]).includes(match[1]!) || !match[2]!.startsWith(`${id}-`)) return undefined;
  return match[1] as PrType;
}

/**
 * Checkout the draft reads its branch and template from: the git toplevel of `cwd` when it belongs to the project
 * (linked worktrees included), else the project root.
 */
export function checkoutDir(root: string, cwd: string): string {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  return top && resolveProjectRoot(cwd) === root ? top : root;
}

/** The repository's pull/merge request template, else overseer's default from `templates/`. */
export function readPrTemplate(dir: string): string {
  for (const rel of REPO_TEMPLATES) {
    const path = join(dir, rel);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  return readFileSync(join(templatesDir(), DEFAULT_TEMPLATE), 'utf8');
}

// Imperative summaries: inflected forms of common commit verbs → base form.
const VERBS = [
  'add', 'allow', 'avoid', 'build', 'bump', 'change', 'check', 'clean', 'clear', 'create', 'deprecate', 'detect',
  'disable', 'document', 'draft', 'drop', 'enable', 'ensure', 'expose', 'extract', 'fix', 'handle', 'hide', 'implement',
  'import', 'improve', 'include', 'introduce', 'keep', 'link', 'list', 'load', 'make', 'merge', 'migrate', 'move',
  'open', 'parse', 'prevent', 'print', 'read', 'record', 'reduce', 'refactor', 'remove', 'rename', 'render', 'replace',
  'report', 'require', 'reset', 'restore', 'return', 'rewrite', 'run', 'save', 'send', 'set', 'show', 'simplify',
  'skip', 'sort', 'speed', 'split', 'stop', 'store', 'support', 'sync', 'track', 'update', 'upgrade', 'use',
  'validate', 'write',
];
const IRREGULAR: Record<string, string> = {
  built: 'build', dropped: 'drop', dropping: 'drop', kept: 'keep', made: 'make', ran: 'run', running: 'run', sent: 'send',
  setting: 'set', shown: 'show', skipped: 'skip', skipping: 'skip', sped: 'speed', splitting: 'split', stopped: 'stop',
  stopping: 'stop', wrote: 'write', written: 'write',
};

function inflections(verb: string): string[] {
  const consonantY = /[^aeiou]y$/.test(verb);
  const third = /(s|x|z|ch|sh)$/.test(verb) ? `${verb}es` : consonantY ? `${verb.slice(0, -1)}ies` : `${verb}s`;
  const past = verb.endsWith('e') ? `${verb}d` : consonantY ? `${verb.slice(0, -1)}ied` : `${verb}ed`;
  const ing = verb.endsWith('e') && !verb.endsWith('ee') ? `${verb.slice(0, -1)}ing` : `${verb}ing`;
  return [third, past, ing];
}

const BASE_FORM = new Map<string, string>(Object.entries(IRREGULAR));
for (const verb of VERBS) for (const form of inflections(verb)) if (!BASE_FORM.has(form)) BASE_FORM.set(form, verb);

/**
 * Item title → lowercase-first imperative summary: drops a leading Conventional Commit prefix and trailing period,
 * turns inflected leading verbs ("Adds", "Fixed", "Adding") into the base form and lowercases the first letter unless
 * the first word is an acronym or mixed-case name ("README", "OpenCode").
 */
export function imperativeSummary(title: string): string {
  let text = title.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  text = text.replace(new RegExp(`^(?:${PR_TYPES.join('|')})(?:\\([^)]*\\))?!?:\\s*`, 'i'), '');
  const match = /^(\S+)(.*)$/.exec(text);
  if (!match) return text;
  const [, first, rest] = match as unknown as [string, string, string];
  const base = BASE_FORM.get(first.toLowerCase());
  if (base) return `${base}${rest}`;
  return /^[A-Z][^A-Z]*$/.test(first) ? `${first[0]!.toLowerCase()}${first.slice(1)}${rest}` : text;
}

/** `<type>: <summary> (<ID>)`, the summary cut at a word boundary so the title stays within 100 characters. */
export function prTitle(type: PrType, summary: string, id: string): string {
  const fixed = `${type}:  (${id})`.length;
  let text = summary;
  if (fixed + text.length > TITLE_MAX) {
    text = text.slice(0, TITLE_MAX - fixed + 1);
    const space = text.lastIndexOf(' ');
    text = (space > 0 ? text.slice(0, space) : text.slice(0, TITLE_MAX - fixed)).replace(/[\s,;:.-]+$/, '');
  }
  return `${type}: ${text} (${id})`;
}

/** `Closes owner/repo#12` for an imported GitHub/GitLab issue (`external_ref` = `<source>:<owner/repo>#<n>`). */
export function closingRef(externalRef: string | null): string | undefined {
  const match = externalRef ? /^(?:github|gitlab):(.+#\d+)$/.exec(externalRef) : null;
  return match ? `Closes ${match[1]}` : undefined;
}

interface Section {
  /** Heading line; null for the text before the first heading. */
  heading: string | null;
  title: string;
  level: number;
  lines: string[];
}

const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const ITEM_LINE = /^(\s*(?:[-*]\s+)?\**Item\**:\**)(.*)$/i;

/** Splits Markdown at headings, ignoring `#` lines inside code fences and HTML comments. */
function parseSections(text: string): Section[] {
  const sections: Section[] = [{ heading: null, title: '', level: 0, lines: [] }];
  let fence = false;
  let comment = false;
  for (const line of text.split('\n')) {
    const heading = !fence && !comment ? HEADING.exec(line) : null;
    if (heading) sections.push({ heading: line, title: heading[2]!, level: heading[1]!.length, lines: [] });
    else sections.at(-1)!.lines.push(line);
    if (!comment && /^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence) {
      const open = line.lastIndexOf('<!--');
      const close = line.lastIndexOf('-->');
      if (open >= 0 && open > close) comment = true;
      else if (close >= 0) comment = false;
    }
  }
  return sections;
}

/** Section body framed like the template's: a blank line after the heading and before the next one. */
function body(content: string): string[] {
  return ['', ...content.split('\n'), ''];
}

/** Removes standalone HTML comment lines matching `pattern` (multi-line comments included). */
function dropComments(lines: string[], pattern: RegExp): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trimStart().startsWith('<!--')) {
      out.push(lines[i]!);
      continue;
    }
    let end = i;
    while (end < lines.length - 1 && !lines[end]!.includes('-->')) end++;
    const block = lines.slice(i, end + 1);
    if (!pattern.test(block.join('\n')) || !block.at(-1)!.trimEnd().endsWith('-->')) out.push(...block);
    i = end;
  }
  return out;
}

function why(detail: ItemDetail): string {
  const parts: string[] = [];
  const description = detail.item.description.trim();
  if (description) parts.push(description);
  const seen = new Set<string>();
  const requirements = detail.links.outgoing.filter((link) => link.kind === 'requirement' && !seen.has(link.id) && seen.add(link.id));
  if (requirements.length > 0) parts.push(['Requirements:', ...requirements.map((req) => `- ${req.id}: ${req.title}`)].join('\n'));
  return parts.join('\n\n');
}

/**
 * Fills a pull request template for an item: the `Item:` line, a closing reference for imported issues, the Why
 * section (description and linked requirements) and the acceptance criteria as a checklist. Why and acceptance
 * sections missing from the template are added; every other section keeps its HTML comment for the author.
 */
export function fillPrTemplate(template: string, detail: ItemDetail): string {
  const { item } = detail;
  const sections = parseSections(template.replace(/\r\n/g, '\n'));
  const level = sections.find((section) => section.heading !== null)?.level ?? 2;
  const find = (pattern: RegExp) => sections.findIndex((section) => section.heading !== null && pattern.test(section.title));
  const insertAfter = (index: number, title: string, content: string): number => {
    const previous = sections[index]!.lines;
    if (previous.length > 0 && previous.at(-1)!.trim() !== '') previous.push('');
    sections.splice(index + 1, 0, { heading: `${'#'.repeat(level)} ${title}`, title, level, lines: body(content) });
    return index + 1;
  };

  // Item line: replace the template's `Item: …`, else add one at the top of the Item section, else add that section.
  let itemIndex = find(/^items?\b/i);
  let lineIndex = -1;
  for (const index of itemIndex >= 0 ? [itemIndex, ...sections.keys()] : sections.keys()) {
    lineIndex = sections[index]!.lines.findIndex((line) => ITEM_LINE.test(line));
    if (lineIndex >= 0) {
      itemIndex = index;
      break;
    }
  }
  if (lineIndex >= 0) {
    const lines = sections[itemIndex]!.lines;
    lines[lineIndex] = lines[lineIndex]!.replace(ITEM_LINE, (_, prefix: string) => `${prefix} ${item.id}`);
  } else if (itemIndex >= 0) {
    const section = sections[itemIndex]!;
    lineIndex = section.lines.findIndex((line) => line.trim() !== '');
    if (lineIndex >= 0) section.lines.splice(lineIndex, 0, `Item: ${item.id}`);
    else [section.lines, lineIndex] = [body(`Item: ${item.id}`), 1];
  } else {
    itemIndex = insertAfter(0, 'Item', `Item: ${item.id}`);
    lineIndex = 1;
  }

  const closes = closingRef(item.external_ref);
  if (closes) {
    const section = sections[itemIndex]!;
    const itemLine = section.lines[lineIndex]!;
    section.lines = dropComments(section.lines, /\b(closes|fixes|resolves)\b/i);
    section.lines.splice(section.lines.indexOf(itemLine) + 1, 0, closes);
  }

  const whyText = why(detail);
  let whyIndex = find(/^(why|motivation|context|background|problem|rationale)\b/i);
  if (whyText) {
    if (whyIndex >= 0) sections[whyIndex]!.lines = body(whyText);
    else whyIndex = insertAfter(itemIndex, 'Why', whyText);
  }

  if (item.acceptance_criteria.length > 0) {
    const criteria = item.acceptance_criteria.map((criterion) => `- [ ] ${criterion.trim().split('\n').join('\n  ')}`).join('\n');
    const acIndex = find(/acceptance/i);
    if (acIndex >= 0) sections[acIndex]!.lines = body(criteria);
    else insertAfter(Math.max(whyIndex, itemIndex), 'Acceptance criteria', criteria);
  }

  return sections.flatMap((section) => (section.heading === null ? section.lines : [section.heading, ...section.lines])).join('\n');
}

/**
 * Title and body for a task or bug. Type: `type`, else the branch's when it is `<type>/<ID>-…`, else fix for bugs
 * and feat for tasks. Same item, template and branch → same draft.
 */
export function draftPullRequest(detail: ItemDetail, template: string, options: { type?: PrType; branch?: string } = {}): PrDraft {
  const { kind, id, title } = detail.item;
  if (kind !== 'task' && kind !== 'bug') {
    throw new OverseerError('INVALID_INPUT', `${id} is a ${kind}; pull requests are drafted for tasks and bugs.`);
  }
  const type = options.type ?? typeFromBranch(options.branch, id) ?? (kind === 'bug' ? 'fix' : 'feat');
  return { title: prTitle(type, imperativeSummary(title), id), body: fillPrTemplate(template, detail) };
}

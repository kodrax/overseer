import { SHALL_TERMS, VAGUE_TERMS } from './lint-terms.js';
import type { Item, LintWarning } from './schema.js';

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const wordPattern = (terms: readonly string[]) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(escapeRegex).join('|')})(?![\\p{L}\\p{N}])`, 'giu');

const VAGUE_RE = wordPattern(VAGUE_TERMS);
const SHALL_RE = wordPattern(SHALL_TERMS);
const STORY_RES = [/as an? .+ i want .+ so that/is, /como .+ quiero .+ para/is];

export const TITLE_MAX = 100;

type LintableItem = Pick<
  Item,
  'kind' | 'title' | 'description' | 'status' | 'req_type' | 'nfr_category' | 'fit_criterion' | 'acceptance_criteria'
>;

/** Quality warnings for requirements and stories (S5); never blocks a write. */
export function lintItem(item: LintableItem): LintWarning[] {
  if (item.kind !== 'requirement' && item.kind !== 'story') return [];
  const warnings: LintWarning[] = [];
  const text = `${item.title}\n${item.description}`;

  const vague = [...new Set([...text.matchAll(VAGUE_RE)].map((match) => match[0].toLowerCase()))];
  if (vague.length > 0) {
    warnings.push({
      rule: 'vague_term',
      severity: 'warn',
      message: `Vague term${vague.length > 1 ? 's' : ''} ${vague.map((term) => `"${term}"`).join(', ')}: replace with measurable, testable wording.`,
    });
  }

  if (item.kind === 'requirement') {
    const modals = [...item.description.matchAll(SHALL_RE)].length;
    if (modals > 1) {
      warnings.push({
        rule: 'multiple_requirements',
        severity: 'warn',
        message: `The description contains ${modals} shall/must statements; record one requirement per item.`,
      });
    }
    if (item.req_type === 'non_functional') {
      if (!item.fit_criterion && !/\d/.test(item.description)) {
        warnings.push({
          rule: 'nfr_not_measurable',
          severity: 'warn',
          message: 'Non-functional requirement without a measurable target: add a fit criterion (e.g. "p95 < 300 ms at 100 rps").',
        });
      }
      if (!item.nfr_category) {
        warnings.push({
          rule: 'nfr_category_missing',
          severity: 'warn',
          message: 'Non-functional requirement without an ISO/IEC 25010 category (nfr_category).',
        });
      }
    }
  }

  const needsCriteria = item.kind === 'requirement' ? item.status !== 'proposed' : item.status !== 'backlog';
  if (needsCriteria && item.acceptance_criteria.length === 0) {
    warnings.push({
      rule: 'missing_acceptance_criteria',
      severity: 'warn',
      message: `No acceptance criteria while status is "${item.status}": add Given/When/Then criteria.`,
    });
  }

  if (item.kind === 'story' && !STORY_RES.some((re) => re.test(item.description))) {
    warnings.push({
      rule: 'story_format',
      severity: 'info',
      message: 'Story description does not follow "As a <role>, I want <goal> so that <benefit>" (or "Como <rol>, quiero <objetivo> para <beneficio>").',
    });
  }

  if (item.title.length > TITLE_MAX) {
    warnings.push({
      rule: 'title_too_long',
      severity: 'warn',
      message: `Title has ${item.title.length} characters; keep it under ${TITLE_MAX}.`,
    });
  }
  return warnings;
}

import type { Command } from 'commander';
import { KINDS, REPORT_KINDS } from '../../core/schema.js';
import type { SearchResult, SimilarResult } from '../../core/search.js';
import type { CoverageCheck } from '../../core/service.js';
import { list, similarity, table } from '../format.js';
import { oneOf, parseInteger } from '../options.js';
import type { CliRuntime } from '../runtime.js';
import { matchesTable } from './items.js';

/** Trailing notice when semantic search is unavailable. */
function degraded(result: { semantic: boolean; warning?: string }): string[] {
  return result.semantic ? [] : [`note: keyword search only${result.warning ? ` (${result.warning})` : ''}`];
}

function formatSearch(result: SearchResult): string {
  const body =
    result.results.length === 0
      ? 'No matches.'
      : table(
          ['ID', 'Kind', 'Status', 'Score', 'Similarity', 'Title'],
          result.results.map((hit) => [hit.id, hit.kind, hit.status, hit.score.toFixed(4), similarity(hit.similarity), hit.title]),
        );
  return [body, ...degraded(result)].join('\n');
}

function formatSimilar(result: SimilarResult): string {
  return [`verdict: ${result.verdict}`, ...(result.matches.length > 0 ? [matchesTable(result.matches)] : []), ...degraded(result)].join('\n');
}

function formatCoverage(result: CoverageCheck): string {
  const rows = result.requirements.map((req) => [
    req.id,
    req.status,
    req.coverage,
    similarity(req.similarity),
    list(req.implemented_by.map((work) => `${work.id} (${work.status})`)),
    req.title,
  ]);
  return [
    `verdict: ${result.verdict}`,
    ...(rows.length > 0 ? [table(['ID', 'Status', 'Coverage', 'Similarity', 'Implemented by', 'Title'], rows)] : []),
    ...degraded(result),
  ].join('\n');
}

export function registerQueryCommands(program: Command, rt: CliRuntime): void {
  program
    .command('search')
    .description('hybrid keyword + semantic search over all items')
    .argument('<query>', 'search text')
    .option('--kind <kind>', `item kind: ${KINDS.join(' | ')}`)
    .option('--limit <n>', 'maximum results (default 10)', parseInteger)
    .option('--json', 'print JSON')
    .action(async (query: string, options: { kind?: string; limit?: number; json?: boolean }, command: Command) => {
      await rt.withService(command, 'read', async (service) => {
        const result = await service.search(query, {
          ...(options.kind !== undefined ? { kind: oneOf(KINDS, options.kind, 'kind') } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        });
        rt.emit(options.json, result, formatSearch);
      });
    });

  program
    .command('similar')
    .description('find existing items similar to a text (duplicate check)')
    .argument('<text>', 'text to compare')
    .option('--kind <kind>', `item kind: ${KINDS.join(' | ')}`)
    .option('--json', 'print JSON')
    .action(async (text: string, options: { kind?: string; json?: boolean }, command: Command) => {
      await rt.withService(command, 'read', async (service) => {
        const result = await service.findSimilar(text, options.kind !== undefined ? { kind: oneOf(KINDS, options.kind, 'kind') } : {});
        rt.emit(options.json, result, formatSimilar);
      });
    });

  program
    .command('coverage')
    .description('is this already covered, tracked or delivered by a requirement?')
    .argument('<text>', 'what to check')
    .option('--json', 'print JSON')
    .action(async (text: string, options: { json?: boolean }, command: Command) => {
      await rt.withService(command, 'read', async (service) => {
        rt.emit(options.json, await service.checkCoverage(text), formatCoverage);
      });
    });

  program
    .command('report')
    .description(`print a report: ${REPORT_KINDS.join(' | ')}`)
    .argument('<kind>', `report kind: ${REPORT_KINDS.join(' | ')}`)
    .option('--json', 'print JSON')
    .action(async (kind: string, options: { json?: boolean }, command: Command) => {
      await rt.withService(command, 'read', (service) => {
        rt.emit(options.json, service.report(oneOf(REPORT_KINDS, kind, 'report kind')), (report) => report.markdown);
      });
    });
}

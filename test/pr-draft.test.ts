import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { packageRoot } from '../src/core/paths.js';
import { draftPullRequest, fillPrTemplate, imperativeSummary, prTitle, typeFromBranch } from '../src/core/pr-draft.js';
import type { ItemDetail } from '../src/core/service.js';
import { ctx, openService } from './helpers/service.js';

const repoTemplate = readFileSync(`${packageRoot()}/.github/pull_request_template.md`, 'utf8');

/** Task TASK-0001 implementing REQ-0001 (plus a relates_to REQ-0002), with two acceptance criteria. */
async function taskDetail(): Promise<ItemDetail> {
  const service = openService();
  await service.createItem({ kind: 'requirement', title: 'Password reset by email', req_type: 'functional', status: 'approved', allow_duplicate: true }, ctx);
  await service.createItem({ kind: 'requirement', title: 'Answers within 300 ms', req_type: 'non_functional', status: 'approved', allow_duplicate: true }, ctx);
  await service.createItem(
    {
      kind: 'task',
      title: 'Adds the reset email sender.',
      description: 'Users locked out cannot get back in.',
      acceptance_criteria: ['A reset link is emailed', 'The link expires after\n30 minutes'],
      links: [
        { rel: 'implements', to: 'REQ-0001' },
        { rel: 'relates_to', to: 'REQ-0002' },
        { rel: 'relates_to', to: 'REQ-0001' },
      ],
      allow_duplicate: true,
    },
    ctx,
  );
  const detail = service.getItem('TASK-0001');
  service.close();
  return detail;
}

/** Section bodies of a filled template by heading, trimmed. */
function sections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of body.split(/^## /m).slice(1)) {
    const [heading, ...rest] = part.split('\n');
    out[heading!] = rest.join('\n').trim();
  }
  return out;
}

describe('pr draft body', () => {
  it("fills this repository's template and keeps the comments of sections it cannot fill", async () => {
    const detail = await taskDetail();
    const body = fillPrTemplate(repoTemplate, detail);
    const filled = sections(body);

    expect(Object.keys(filled)).toEqual(['Item', 'Why', 'Acceptance criteria', 'What changed', 'How it was verified', 'Risk', 'Checklist']);
    expect(filled.Item).toBe('Item: TASK-0001\n<!-- Once the item is synced, close its issue: Closes #123 -->');
    expect(filled.Why).toBe(
      'Users locked out cannot get back in.\n\nRequirements:\n- REQ-0001: Password reset by email\n- REQ-0002: Answers within 300 ms',
    );
    expect(filled['Acceptance criteria']).toBe('- [ ] A reset link is emailed\n- [ ] The link expires after\n  30 minutes');
    for (const heading of ['What changed', 'How it was verified', 'Risk']) expect(filled[heading]).toMatch(/^<!--[^]*-->$/);
    expect(body.startsWith(repoTemplate.slice(0, repoTemplate.indexOf('## Item')))).toBe(true);
    expect(body.endsWith(repoTemplate.slice(repoTemplate.indexOf('## What changed')))).toBe(true);
    expect(fillPrTemplate(repoTemplate, detail)).toBe(body);
  });

  it('adds a closing reference for an imported issue in place of the hint comment', async () => {
    const service = openService();
    await service.importItems(
      { source: 'github', repo: 'acme/demo', items: [{ external_id: 'acme/demo#12', url: 'https://github.com/acme/demo/issues/12', title: 'Login crashes', state: 'open', labels: ['bug'] }] },
      ctx,
    );
    const detail = service.getItem('BUG-0001');
    service.close();

    const draft = draftPullRequest(detail, repoTemplate);
    expect(draft.title).toBe('fix: login crashes (BUG-0001)');
    expect(sections(draft.body).Item).toBe('Item: BUG-0001\nCloses acme/demo#12');
    // Nothing to say why: the section keeps its comment; no criteria: no section is added.
    expect(sections(draft.body).Why).toMatch(/^<!--[^]*-->$/);
    expect(draft.body).not.toContain('## Acceptance criteria');
  });

  it('fills a template without Item, Why or acceptance sections by adding them after the preamble', async () => {
    const detail = await taskDetail();
    const body = fillPrTemplate('<!-- intro -->\n\n### Changes\n\n<!-- what -->\n', detail);
    expect(body).toBe(
      [
        '<!-- intro -->',
        '',
        '### Item',
        '',
        'Item: TASK-0001',
        '',
        '### Why',
        '',
        'Users locked out cannot get back in.',
        '',
        'Requirements:',
        '- REQ-0001: Password reset by email',
        '- REQ-0002: Answers within 300 ms',
        '',
        '### Acceptance criteria',
        '',
        '- [ ] A reset link is emailed',
        '- [ ] The link expires after',
        '  30 minutes',
        '',
        '### Changes',
        '',
        '<!-- what -->',
        '',
      ].join('\n'),
    );
  });

  it('ignores headings inside HTML comments and code fences', async () => {
    const detail = await taskDetail();
    const template = '<!--\n## Why\n-->\n## Notes\n\n```md\n## Why\n```\n';
    const body = fillPrTemplate(template, detail);
    // The commented and fenced headings stay as they were; Item, Why and acceptance criteria are added before Notes.
    expect(body.startsWith('<!--\n## Why\n-->\n\n## Item\n\nItem: TASK-0001\n\n## Why\n\nUsers locked out')).toBe(true);
    expect(body.endsWith('- [ ] A reset link is emailed\n- [ ] The link expires after\n  30 minutes\n\n## Notes\n\n```md\n## Why\n```\n')).toBe(true);
  });

  it('refuses items that are not tasks or bugs', async () => {
    const service = openService();
    await service.createItem({ kind: 'story', title: 'Reset password', allow_duplicate: true }, ctx);
    const detail = service.getItem('US-0001');
    service.close();
    expect(() => draftPullRequest(detail, repoTemplate)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

describe('pr draft title', () => {
  it.each([
    ['Adds the reset email sender.', 'add the reset email sender'],
    ['Fixed crash on login', 'fix crash on login'],
    ['Updating dependencies', 'update dependencies'],
    ['Wrote the ship skill', 'write the ship skill'],
    ['Draft and open pull requests', 'draft and open pull requests'],
    ['README gaps', 'README gaps'],
    ['OpenCode support', 'OpenCode support'],
    ['feat(cli): Add pr draft', 'add pr draft'],
    ['Process  imports   faster', 'process imports faster'],
  ])('%s → %s', (title, summary) => {
    expect(imperativeSummary(title)).toBe(summary);
  });

  it('cuts long summaries at a word boundary within 100 characters', () => {
    const title = prTitle('refactor', `split ${'service '.repeat(20)}into modules`, 'TASK-0123');
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title).toMatch(/^refactor: split( service)+ \(TASK-0123\)$/);
    expect(prTitle('feat', 'short', 'TASK-0001')).toBe('feat: short (TASK-0001)');
  });

  it('takes the type from <type>/<ID>- branches only', () => {
    expect(typeFromBranch('docs/TASK-0058-pr-draft', 'TASK-0058')).toBe('docs');
    expect(typeFromBranch('docs/TASK-00581-pr-draft', 'TASK-0058')).toBeUndefined();
    expect(typeFromBranch('docs/TASK-0059-pr-draft', 'TASK-0058')).toBeUndefined();
    expect(typeFromBranch('style/TASK-0058-pr-draft', 'TASK-0058')).toBeUndefined();
    expect(typeFromBranch('TASK-0058-pr-draft', 'TASK-0058')).toBeUndefined();
    expect(typeFromBranch(undefined, 'TASK-0058')).toBeUndefined();
  });
});

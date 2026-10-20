import { describe, expect, it } from 'vitest';
import { MODEL_REGISTRY } from '../src/core/embeddings.js';
import { ftsQuery } from '../src/core/search.js';
import { OverseerService, type CreatedResult } from '../src/core/service.js';
import type { CreateInput } from '../src/core/schema.js';
import { HASH_MODEL, HashEmbedder } from './helpers/hash-embedder.js';
import { ctx, openService } from './helpers/service.js';
import { tempRepo } from './helpers/tmp.js';

const OTHER_MODEL = 'test/hash-embedder-v2';
MODEL_REGISTRY[OTHER_MODEL] = { ...MODEL_REGISTRY[HASH_MODEL]! };

const CENTERED_MODEL = 'test/hash-embedder-centered';
const ZEROS = new Float32Array(384);
MODEL_REGISTRY[CENTERED_MODEL] = {
  ...MODEL_REGISTRY[HASH_MODEL]!,
  centering: { reference: { items_vec: ZEROS, items_title_vec: ZEROS, items_statement_vec: ZEROS }, prior: 1 },
};

async function add(service: OverseerService, input: CreateInput) {
  const result = await service.createItem({ allow_duplicate: true, ...input }, ctx);
  return (result as CreatedResult).item;
}

const requirement = (title: string, description: string): CreateInput => ({
  kind: 'requirement',
  title,
  description,
  req_type: 'functional',
});

describe('ftsQuery', () => {
  it('quotes unicode word tokens and drops punctuation, quotes and 1-char tokens', () => {
    expect(ftsQuery('He said "reset" — a ñandú, OK?')).toBe('"He" OR "said" OR "reset" OR "ñandú" OR "OK"');
    expect(ftsQuery('"" ; ! a b')).toBeUndefined();
    expect(ftsQuery('')).toBeUndefined();
  });
});

describe('search', () => {
  it('fuses FTS and KNN ranks with RRF', async () => {
    const service = openService();
    await add(service, requirement('Password reset by email', 'Users receive a reset link by email'));
    await add(service, requirement('Email newsletter', 'Marketing email subscription settings'));
    await add(service, requirement('Dark mode', 'Theme toggle for the interface'));
    await add(service, requirement('Reset sessions', 'Admins can reset active sessions'));

    const result = await service.search('password reset email', { limit: 10 });
    expect(result.semantic).toBe(true);
    expect(result.results[0]!.id).toBe('REQ-0001');
    const knnOrder = [...result.results].sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0)).map((hit) => hit.id);
    for (const hit of result.results) {
      const expected = (hit.fts_rank ? 1 / (60 + hit.fts_rank) : 0) + 1 / (60 + knnOrder.indexOf(hit.id) + 1);
      expect(hit.score).toBeCloseTo(expected, 5);
    }
    const scores = result.results.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    // Dark mode shares no keyword: present through KNN only
    expect(result.results.find((hit) => hit.id === 'REQ-0003')).toMatchObject({ fts_rank: null });
  });

  it('matches accents both ways and survives queries without searchable tokens', async () => {
    const service = openService(undefined, null);
    await add(service, requirement('Contraseña olvidada', 'Restablecer la contraseña'));
    expect((await service.search('contrasena')).results.map((hit) => hit.id)).toEqual(['REQ-0001']);
    await add(service, requirement('Resume upload', 'Candidates upload a resume'));
    expect((await service.search('résumé')).results.map((hit) => hit.id)).toEqual(['REQ-0002']);
    expect((await service.search('?! "')).results).toEqual([]);
  });

  it('filters by kind', async () => {
    const service = openService();
    await add(service, requirement('Export invoices', 'Export invoices as PDF'));
    await add(service, { kind: 'story', title: 'Export invoices', description: 'As an accountant I want to export invoices so that I can file taxes' });
    const result = await service.search('export invoices', { kind: 'story' });
    expect(result.results.map((hit) => hit.kind)).toEqual(['story']);
  });
});

describe('degradation', () => {
  it('falls back to FTS without an embedder', async () => {
    const service = openService(undefined, null);
    await add(service, requirement('Audit log', 'Record every admin action in an audit log'));
    const search = await service.search('audit');
    expect(search).toMatchObject({ semantic: false, warning: expect.any(String), results: [{ id: 'REQ-0001', similarity: null, fts_rank: 1 }] });
    const similar = await service.findSimilar('audit log for admins');
    expect(similar).toMatchObject({ semantic: false, verdict: 'unknown', matches: [{ id: 'REQ-0001', similarity: null, match: null }] });
    expect(await service.checkCoverage('audit log')).toMatchObject({ semantic: false, verdict: 'unknown', requirements: [{ id: 'REQ-0001' }] });
  });

  it('compact creates report verdict unknown with the keyword hits as candidates', async () => {
    const service = openService(undefined, null);
    await add(service, requirement('Audit log', 'Record every admin action in an audit log'));
    expect(await service.createItemCompact(requirement('Audit log export', 'Export the audit log as CSV'), ctx)).toEqual({
      created: true,
      id: 'REQ-0002',
      title: 'Audit log export',
      status: 'proposed',
      verdict: 'unknown',
      candidates: [{ id: 'REQ-0001', title: 'Audit log', similarity: null, match: null }],
      warnings: [],
    });
  });

  it('falls back to FTS when the model fails, and never blocks creates', async () => {
    const embedder = new HashEmbedder();
    embedder.fail = true;
    const service = openService(undefined, embedder);
    const first = await service.createItem(requirement('Rate limiting', 'Limit API calls per key'), ctx);
    const second = await service.createItem(requirement('Rate limiting', 'Limit API calls per key'), ctx);
    expect(first.created && second.created).toBe(true);
    expect((second as CreatedResult).similar.map((match) => match.id)).toEqual(['REQ-0001']);
    expect(await service.search('rate limiting')).toMatchObject({ semantic: false });
  });
});

describe('embeddings maintenance', () => {
  it('embeds lazily, re-embeds stale items only, and re-embeds everything on a model change', async () => {
    const root = tempRepo();
    const embedder = new HashEmbedder();
    const service = openService(root, embedder);
    await add(service, requirement('Two factor auth', 'Users can enable TOTP'));
    await add(service, requirement('Session timeout', 'Sessions expire after inactivity'));
    await service.search('auth');
    // Item texts end with "\n" (title\ndescription\n + no AC); duplicate-guard queries do not.
    const itemTexts = (log: string[]) => log.filter((text) => text.endsWith('\n'));
    expect(itemTexts(embedder.embedded)).toHaveLength(2);

    embedder.embedded.length = 0;
    await service.updateItem({ id: 'REQ-0002', description: 'Sessions expire after 30 minutes of inactivity' }, ctx);
    await service.updateItem({ id: 'REQ-0001', status: 'approved' }, ctx);
    await service.search('session');
    expect(itemTexts(embedder.embedded)).toEqual([
      'query: Session timeout\nSessions expire after 30 minutes of inactivity\n',
    ]);
    service.close();

    const other = new HashEmbedder(OTHER_MODEL);
    const reopened = OverseerService.open({ root, create: false, embedder: other })!;
    await reopened.search('session');
    expect(itemTexts(other.embedded)).toHaveLength(2);
    expect(reopened.getMeta('embed_model')).toBe(OTHER_MODEL);
    const models = reopened.db.prepare('SELECT DISTINCT model FROM item_embeddings').all();
    expect(models).toEqual([expect.objectContaining({ model: OTHER_MODEL })]);
  });

  it('reindex rebuilds FTS rows and all embeddings', async () => {
    const embedder = new HashEmbedder();
    const service = openService(undefined, embedder);
    await add(service, requirement('CSV import', 'Import contacts from CSV'));
    await service.search('csv');
    service.db.exec('DELETE FROM items_fts');
    expect((await service.search('contacts')).results.find((hit) => hit.fts_rank !== null)).toBeUndefined();
    embedder.embedded.length = 0;
    expect(await service.reindex()).toEqual({ items: 1, semantic: true });
    expect(embedder.embedded).toEqual([
      'query: CSV import\nImport contacts from CSV\n',
      'query: CSV import',
      'query: CSV import\nImport contacts from CSV',
    ]);
    expect((await service.search('contacts')).results[0]).toMatchObject({ id: 'REQ-0001', fts_rank: 1 });
  });
});

describe('similarity and duplicates', () => {
  it('classifies matches and blocks likely duplicates unless allowed', async () => {
    const service = openService();
    await add(service, requirement('Password reset by email', 'Send a single-use reset link by email'));
    const similar = await service.findSimilar('Password reset by email\nSend a single-use reset link by email', { kind: 'requirement' });
    expect(similar).toMatchObject({ semantic: true, verdict: 'duplicate', matches: [{ id: 'REQ-0001', match: 'duplicate', coverage: 'untracked' }] });

    const blocked = await service.createItem(requirement('Password reset by email', 'Send a single-use reset link by email'), ctx);
    expect(blocked).toMatchObject({ created: false, reason: 'possible_duplicate', candidates: [{ id: 'REQ-0001', match: 'duplicate' }] });
    expect(service.listItems().total).toBe(1);

    const allowed = await service.createItem(
      { ...requirement('Password reset by email', 'Send a single-use reset link by email'), allow_duplicate: true },
      ctx,
    );
    expect(allowed).toMatchObject({ created: true, similar: [{ id: 'REQ-0001' }] });
    const unrelated = await service.findSimilar('Dark theme colors');
    expect(unrelated.verdict).toBe('new');
  });

  it('answers coverage questions with implementing work', async () => {
    const service = openService();
    const r = await add(service, requirement('Password reset by email', 'Send a single-use reset link by email'));
    await add(service, { kind: 'story', title: 'Reset flow', status: 'in_progress', links: [{ rel: 'implements', to: r.id }] });
    const check = await service.checkCoverage('password reset by email single-use link');
    expect(check).toMatchObject({
      semantic: true,
      verdict: 'partially',
      requirements: [{ id: r.id, coverage: 'in_progress', implemented_by: [{ id: 'US-0001', kind: 'story', status: 'in_progress' }] }],
    });
    expect((await service.checkCoverage('Password reset by email\nSend a single-use reset link by email')).verdict).toBe('covered');
    expect((await service.checkCoverage('Kubernetes autoscaling')).verdict).toBe('not_found');
  });

  it('does not class distinct items sharing a domain vocabulary as duplicates once centered (BUG-0001)', async () => {
    const domain = Array.from({ length: 40 }, (_, i) => `term${i}`).join(' ');
    const items = Array.from({ length: 8 }, (_, i) => requirement(`alpha${i} beta${i} gamma${i}`, `${domain} delta${i}`));
    const plain = openService(undefined, new HashEmbedder());
    const centered = openService(undefined, new HashEmbedder(CENTERED_MODEL));
    for (const service of [plain, centered]) for (const input of items.slice(0, 7)) await add(service, input);

    // Plain cosine: the shared vocabulary alone puts the new item above the duplicate threshold.
    expect(await plain.createItem(items[7]!, ctx)).toMatchObject({ created: false, reason: 'possible_duplicate' });
    expect(await centered.createItem(items[7]!, ctx)).toMatchObject({ created: true });
    expect(await centered.createItem(items[0]!, ctx)).toMatchObject({
      created: false,
      candidates: [{ id: 'REQ-0001', match: 'duplicate', similarity: 1 }],
    });
  });

  it('gives the same centered similarities after in-place re-embeds, a sum rebuild and a reindex', async () => {
    const service = openService(undefined, new HashEmbedder(CENTERED_MODEL));
    await add(service, requirement('Two factor auth', 'Users can enable TOTP'));
    await add(service, requirement('Session timeout', 'Sessions expire after inactivity'));
    await add(service, requirement('Password reset', 'Reset links expire after one hour'));
    await service.updateItem({ id: 'REQ-0002', description: 'Sessions expire after 30 minutes of inactivity' }, ctx);
    await service.updateItem({ id: 'REQ-0003', title: 'Password reset by email' }, ctx);
    const query = 'Session expiry after inactivity';
    const incremental = await service.findSimilar(query);
    expect(incremental.matches[0]).toMatchObject({ id: 'REQ-0002' });

    // Databases whose vectors were stored before the running sums existed.
    service.db.exec("DELETE FROM meta WHERE key LIKE 'vec_sum:%'");
    expect(await service.findSimilar(query)).toEqual(incremental);
    await service.reindex();
    expect(await service.findSimilar(query)).toEqual(incremental);
  });
});

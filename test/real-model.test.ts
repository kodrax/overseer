import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, MODEL_REGISTRY, TransformersEmbedder } from '../src/core/embeddings.js';
import { OverseerService } from '../src/core/service.js';
import { pairSimilarities, REGISTRY } from './helpers/pairs.js';
import { ctx } from './helpers/service.js';
import { tempRepo } from './helpers/tmp.js';

// Runs only with OVERSEER_REAL_MODEL=1 (needs the downloaded model).
describe.skipIf(process.env.OVERSEER_REAL_MODEL !== '1')('real embedding model', () => {
  const embedder = new TransformersEmbedder(DEFAULT_MODEL);
  const { duplicate, related } = MODEL_REGISTRY[DEFAULT_MODEL]!;

  it('tells duplicates from look-alike requirements of one registry (BUG-0001)', async () => {
    const service = OverseerService.open({ root: tempRepo(), create: true, embedder })!;
    for (const item of REGISTRY.items) {
      const { id, component, fit_criterion, ...fields } = item;
      const input = { kind: 'requirement', req_type: 'functional', component, ...fields, ...(fit_criterion ? { fit_criterion } : {}) };
      const result = await service.createItem({ ...input, allow_duplicate: true }, ctx);
      expect(result).toMatchObject({ created: true, item: { id } });
    }
    const statement = (id: string) => {
      const { title, description } = service.getItem(id).item;
      return `${title}\n${description}`;
    };

    for (const [query, stored] of REGISTRY.not_duplicates) {
      const similar = await service.findSimilar(statement(query), { kind: 'requirement', limit: 10 });
      expect(similar.matches[0]).toMatchObject({ id: query, match: 'duplicate' });
      expect(similar.matches.find((match) => match.id === stored)?.match).not.toBe('duplicate');
    }

    let duplicateNeighbours = 0;
    for (const { id } of REGISTRY.items) {
      const [, nearest] = (await service.findSimilar(statement(id), { kind: 'requirement', limit: 2 })).matches;
      if (nearest!.match === 'duplicate') duplicateNeighbours++;
    }
    expect(duplicateNeighbours / REGISTRY.items.length).toBeLessThanOrEqual(0.05);

    for (const rewording of REGISTRY.duplicates) {
      const similar = await service.findSimilar(`${rewording.title}\n${rewording.description}`, { kind: 'requirement' });
      expect(similar.matches[0]).toMatchObject({ id: rewording.of, match: expect.stringMatching(/^(duplicate|related)$/) });
    }
    service.close();
  }, 600_000);

  it('classes every fixture duplicate at least related and nearly every unrelated pair weak', async () => {
    const results = await pairSimilarities(embedder);
    const of = (cls: string) => results.filter(({ pair }) => pair.class === cls).map(({ similarity }) => similarity);
    expect(of('duplicate').every((similarity) => similarity >= related)).toBe(true);
    expect(of('duplicate').filter((similarity) => similarity >= duplicate).length / of('duplicate').length).toBeGreaterThanOrEqual(2 / 3);
    expect(of('unrelated').filter((similarity) => similarity >= related).length / of('unrelated').length).toBeLessThanOrEqual(0.05);
  }, 600_000);

  it('finds a Spanish requirement from an English query', async () => {
    const service = OverseerService.open({ root: tempRepo(), create: true, embedder })!;
    await service.createItem(
      {
        kind: 'requirement',
        title: 'Restablecer la contraseña por correo',
        description: 'Cuando un usuario solicita restablecer su contraseña, el sistema deberá enviar un enlace de un solo uso.',
        req_type: 'functional',
      },
      ctx,
    );
    const similar = await service.findSimilar('Password reset by email: the system sends a single-use reset link', {
      kind: 'requirement',
    });
    expect(similar.semantic).toBe(true);
    expect(similar.matches[0]).toMatchObject({ id: 'REQ-0001' });
    expect(['duplicate', 'related']).toContain(similar.matches[0]!.match);
    service.close();
  }, 600_000);

  it('answers short and cross-language questions against a full requirement statement', async () => {
    const service = OverseerService.open({ root: tempRepo(), create: true, embedder })!;
    await service.createItem(
      {
        kind: 'requirement',
        title: 'Password reset by email',
        description: 'When a user requests a password reset, the system shall email a single-use link that expires after 30 minutes.',
        req_type: 'functional',
      },
      ctx,
    );
    expect((await service.checkCoverage('password reset')).verdict).toBe('covered');
    const spanish = await service.findSimilar('Restablecer la contraseña mediante un enlace enviado por correo');
    expect(spanish.matches[0]).toMatchObject({ id: 'REQ-0001', match: expect.stringMatching(/^(duplicate|related)$/) });
    expect((await service.checkCoverage('dark mode theme toggle')).verdict).toBe('not_found');
    service.close();
  }, 600_000);
});

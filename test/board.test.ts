import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBoardApp } from '../src/board/server.js';
import { OverseerService } from '../src/core/service.js';
import { HashEmbedder } from './helpers/hash-embedder.js';
import { ctx, openService } from './helpers/service.js';
import { tempDir, tempRepo } from './helpers/tmp.js';

const TOKEN = 'test-token';
const HOST = '127.0.0.1:4477';

function webAssets(): string {
  const dir = tempDir('ovs-web-');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<html><head><!--OVERSEER_BOOT--></head><body></body></html>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  return dir;
}

function setup(service = openService()) {
  const { app, dispose } = createBoardApp(service, { token: TOKEN, port: () => 4477, webDir: webAssets(), pollMs: 20 });
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: {
        host: HOST,
        ...(method === 'GET' ? {} : { 'x-overseer-token': TOKEN }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { app, dispose, request, service };
}

describe('board security', () => {
  it('rejects foreign Host headers and mutations without the token', async () => {
    const { app, request } = setup();
    const foreign = await app.request('/api/project', { headers: { host: 'evil.example:4477' } });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect((await app.request('/api/project', { headers: { host: 'localhost:4477' } })).status).toBe(200);
    expect((await app.request('/api/project', { headers: { host: '127.0.0.1:9999' } })).status).toBe(403);

    const created = await request('POST', '/api/items', { kind: 'task', title: 'Wire the form' });
    expect(created.status).toBe(200);
    const noToken = await app.request('/api/items/TASK-0001', {
      method: 'PATCH',
      headers: { host: HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(noToken.status).toBe(403);
    const wrongToken = await request('PATCH', '/api/items/TASK-0001', { status: 'done' }, { 'x-overseer-token': 'nope' });
    expect(wrongToken.status).toBe(403);
    expect((await request('PATCH', '/api/items/TASK-0001', { status: 'done' })).status).toBe(200);
  });

  it('serves the SPA with the per-start token and refuses path traversal', async () => {
    const { request } = setup();
    const index = await request('GET', '/');
    expect(await index.text()).toBe(`<html><head><script>window.__OVERSEER__={token:"${TOKEN}"}</script></head><body></body></html>`);
    const asset = await request('GET', '/assets/app.js');
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(await asset.text()).toBe('console.log(1)');
    const traversal = await request('GET', '/assets/%2e%2e/%2e%2e/etc/passwd');
    expect(await traversal.text()).not.toContain('root:');
  });
});

describe('board API', () => {
  it('exposes project, items, links, search, similar, reports and export', async () => {
    const { request } = setup();
    const project = await (await request('GET', '/api/project')).json();
    expect(project).toMatchObject({ initialized: true, version: '0.1.0', enums: { statuses: { story: expect.arrayContaining(['backlog', 'done']) } } });

    const requirement = await request('POST', '/api/items', {
      kind: 'requirement',
      title: 'Password reset by email',
      description: 'Send a single-use reset link by email',
      req_type: 'functional',
    });
    expect(await requirement.json()).toMatchObject({ created: true, item: { id: 'REQ-0001', recorded_via: 'web' } });
    const duplicate = await request('POST', '/api/items', {
      kind: 'requirement',
      title: 'Password reset by email',
      description: 'Send a single-use reset link by email',
      req_type: 'functional',
    });
    expect(await duplicate.json()).toMatchObject({ created: false, reason: 'possible_duplicate' });
    const invalid = await request('POST', '/api/items', { kind: 'requirement', title: 'No type' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });

    await request('POST', '/api/items', { kind: 'story', title: 'Reset flow', links: [{ rel: 'implements', to: 'REQ-0001' }] });
    const items = await (await request('GET', '/api/items?kind=story')).json();
    expect(items).toMatchObject({ total: 1, items: [{ id: 'US-0001', implements: ['REQ-0001'], status: 'backlog' }] });
    const byCoverage = await (await request('GET', '/api/items?coverage=tracked,in_progress')).json();
    expect(byCoverage).toMatchObject({ total: 1, items: [{ id: 'REQ-0001' }] });
    expect((await request('GET', '/api/items?kind=widget')).status).toBe(400);

    const patched = await (await request('PATCH', '/api/items/US-0001', { status: 'in_progress', comment: 'Started' })).json();
    expect(patched).toMatchObject({ item: { status: 'in_progress' }, changed_fields: ['status'] });
    const detail = await (await request('GET', '/api/items/REQ-0001?history=1')).json();
    expect(detail).toMatchObject({
      coverage: 'in_progress',
      links: { incoming: [{ rel: 'implements', id: 'US-0001' }] },
      history: expect.arrayContaining([expect.objectContaining({ action: 'create' })]),
    });
    expect((await request('GET', '/api/items/REQ-0042')).status).toBe(404);

    await request('POST', '/api/items', { kind: 'bug', title: 'Link expired' });
    expect(await (await request('POST', '/api/links', { src: 'BUG-0001', rel: 'affects', dst: 'REQ-0001' })).json()).toEqual({
      linked: true,
      src: 'BUG-0001',
      rel: 'affects',
      dst: 'REQ-0001',
    });
    expect(await (await request('DELETE', '/api/links', { src: 'BUG-0001', rel: 'affects', dst: 'REQ-0001' })).json()).toMatchObject({ linked: false });
    expect((await request('POST', '/api/links', { src: 'BUG-0001', rel: 'implements', dst: 'REQ-0001' })).status).toBe(400);

    const search = await (await request('GET', '/api/search?q=password&kind=requirement')).json();
    expect(search).toMatchObject({ semantic: true, results: [{ id: 'REQ-0001' }] });
    const similar = await (await request('POST', '/api/similar', { text: 'Password reset by email', kind: 'requirement' })).json();
    expect(similar).toMatchObject({ matches: [{ id: 'REQ-0001' }] });

    const drift = await (await request('GET', '/api/reports/drift')).json();
    expect(drift).toMatchObject({ kind: 'drift', data: { drift: [{ id: 'REQ-0001', rule: 'unapproved_in_progress' }] } });
    expect((await request('GET', '/api/reports/nope')).status).toBe(400);

    const exported = await (await request('POST', '/api/export', { only: ['summary'] })).json();
    expect(exported).toEqual({ out_dir: 'docs/overseer', files: ['docs/overseer/README.md'] });
    expect((await request('GET', '/api/nothing')).status).toBe(404);
  });

  it('streams a changed event when another connection commits', async () => {
    const root = tempRepo();
    const { request, dispose } = setup(openService(root));
    const response = await request('GET', '/api/events');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const readUntil = async (pattern: RegExp) => {
      while (!pattern.test(received)) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value);
      }
    };
    await readUntil(/event: ready/);
    const other = OverseerService.open({ root, create: false, embedder: new HashEmbedder() })!;
    await other.createItem({ kind: 'task', title: 'Written elsewhere' }, ctx);
    await readUntil(/event: changed/);
    expect(received).toMatch(/event: changed\ndata: \{"data_version":\d+\}/);
    await reader.cancel();
    other.close();
    dispose();
  });

  it('streams a changed event when another connection deletes an item, which then leaves the item list', async () => {
    const root = tempRepo();
    const { request, dispose, service } = setup(openService(root));
    await service.createItem({ kind: 'task', title: 'Stays' }, ctx);
    await service.createItem({ kind: 'task', title: 'Goes away' }, ctx);
    const response = await request('GET', '/api/events');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const readUntil = async (pattern: RegExp) => {
      while (!pattern.test(received)) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value);
      }
    };
    await readUntil(/event: ready/);
    const other = OverseerService.open({ root, create: false, embedder: new HashEmbedder() })!;
    other.deleteItem('TASK-0002', ctx);
    await readUntil(/event: changed/);
    expect(received).toMatch(/event: changed\ndata: \{"data_version":\d+\}/);
    expect(await (await request('GET', '/api/items')).json()).toMatchObject({ total: 1, items: [{ id: 'TASK-0001' }] });
    const gone = await request('GET', '/api/items/TASK-0002');
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: { code: 'NOT_FOUND', message: expect.stringMatching(/^Item TASK-0002 was deleted on /) } });
    await reader.cancel();
    other.close();
    dispose();
  });
});

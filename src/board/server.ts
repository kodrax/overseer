import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { createAdaptorServer } from '@hono/node-server';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { type Database, openReadConnection } from '../core/db.js';
import { errorMessage, isOverseerError, OverseerError } from '../core/errors.js';
import { packageVersion, webDir as defaultWebDir } from '../core/paths.js';
import {
  CLOSED_STATUSES,
  COVERAGE_STATES,
  type Ctx,
  EXPORT_PARTS,
  KINDS,
  NFR_CATEGORIES,
  PRIORITIES,
  RELATIONS,
  REPORT_KINDS,
  REQ_TYPES,
  SEVERITIES,
  STATUSES,
  VERIFICATION_METHODS,
  parseInput,
} from '../core/schema.js';
import type { OverseerService } from '../core/service.js';

export interface BoardServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface BoardOptions {
  service: OverseerService;
  port?: number;
  openBrowser?: boolean;
}

export interface BoardAppOptions {
  token: string;
  /** Listening port, used to validate the Host header. */
  port: () => number;
  webDir?: string;
  /** `PRAGMA data_version` polling interval for `/api/events` (default 1000 ms). */
  pollMs?: number;
}

const DEFAULT_PORT = 4477;
const PORT_ATTEMPTS = 20;
const LIST_LIMIT_DEFAULT = 1000;
const LIST_LIMIT_MAX = 5000;
const BOOT_MARKER = '<!--OVERSEER_BOOT-->';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const STATUS_BY_CODE: Record<string, 400 | 403 | 404 | 500> = {
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  INVALID_STATUS: 400,
  INVALID_LINK: 400,
  INVALID_PARENT: 400,
  NO_PROJECT: 400,
  FORBIDDEN: 403,
};

const commaList = z
  .string()
  .optional()
  .transform((value) => (value ? value.split(',').map((part) => part.trim()).filter(Boolean) : undefined));

const listQuerySchema = z.object({
  kind: z.enum(KINDS).optional(),
  status: commaList,
  req_type: z.enum(REQ_TYPES).optional(),
  coverage: commaList.pipe(z.array(z.enum(COVERAGE_STATES)).optional()),
  tag: z.string().optional(),
  parent_id: z.string().optional(),
  include_closed: z
    .enum(['1', 'true', '0', 'false'])
    .optional()
    .transform((value) => value === '1' || value === 'true'),
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

const searchQuerySchema = z.object({
  q: z.string().min(1).max(4000),
  kind: z.enum(KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

const similarSchema = z.object({
  text: z.string().min(1).max(4000),
  kind: z.enum(KINDS).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const linkSchema = z.object({ src: z.string().min(1), rel: z.enum(RELATIONS), dst: z.string().min(1) });
const exportSchema = z.object({ only: z.array(z.enum(EXPORT_PARTS)).optional(), since: z.string().optional() });

function errorResponse(c: Context, error: unknown): Response {
  if (isOverseerError(error)) {
    return c.json({ error: { code: error.code, message: error.message } }, STATUS_BY_CODE[error.code] ?? 500);
  }
  return c.json({ error: { code: 'INTERNAL', message: errorMessage(error) } }, 500);
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new OverseerError('INVALID_INPUT', 'Request body must be JSON.');
  }
}

/** Polls `PRAGMA data_version` on its own connection, so commits from any connection or process are seen. */
class ChangeWatcher {
  private readonly listeners = new Set<(version: number) => void>();
  private timer?: NodeJS.Timeout;
  private db?: Database;
  private last = -1;
  private readonly root: string;
  private readonly pollMs: number;

  constructor(root: string, pollMs: number) {
    this.root = root;
    this.pollMs = pollMs;
  }

  subscribe(listener: (version: number) => void): () => void {
    this.listeners.add(listener);
    if (!this.timer) {
      this.db ??= openReadConnection(this.root);
      this.last = this.read();
      this.timer = setInterval(() => {
        const version = this.read();
        if (version === this.last) return;
        this.last = version;
        for (const notify of this.listeners) notify(version);
      }, this.pollMs);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private read(): number {
    return Number(this.db!.prepare('PRAGMA data_version').get()?.data_version ?? 0);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.db?.close();
    this.db = undefined;
  }
}

/** Board HTTP app (S13): JSON API, SSE change feed and the SPA with its per-start token. */
export function createBoardApp(service: OverseerService, options: BoardAppOptions): { app: Hono; dispose(): void } {
  const app = new Hono();
  const ctx: Ctx = { via: 'web' };
  const assets = options.webDir ?? defaultWebDir();
  const watcher = new ChangeWatcher(service.root, options.pollMs ?? 1000);
  const indexFile = join(assets, 'index.html');
  const indexHtml = existsSync(indexFile)
    ? readFileSync(indexFile, 'utf8').replace(BOOT_MARKER, `<script>window.__OVERSEER__={token:${JSON.stringify(options.token)}}</script>`)
    : undefined;

  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    const port = options.port();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return c.json({ error: { code: 'FORBIDDEN', message: `Host header not allowed: ${host ?? '(none)'}` } }, 403);
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('x-overseer-token') !== options.token) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Missing or invalid X-Overseer-Token header.' } }, 403);
    }
    await next();
  });

  app.onError((error, c) => errorResponse(c, error));

  app.get('/api/project', (c) =>
    c.json({
      ...service.info(),
      version: packageVersion(),
      enums: {
        kinds: KINDS,
        statuses: STATUSES,
        closed_statuses: CLOSED_STATUSES,
        priorities: PRIORITIES,
        req_types: REQ_TYPES,
        nfr_categories: NFR_CATEGORIES,
        verification_methods: VERIFICATION_METHODS,
        severities: SEVERITIES,
        relations: RELATIONS,
        coverage_states: COVERAGE_STATES,
      },
    }),
  );

  app.get('/api/items', (c) => {
    const filter = parseInput(listQuerySchema, c.req.query());
    return c.json(service.listFullItems(filter));
  });

  app.get('/api/items/:id', (c) => {
    const history = c.req.query('history');
    return c.json(service.getItem(c.req.param('id'), { history: history === '1' || history === 'true' }));
  });

  app.post('/api/items', async (c) => c.json(await service.createItem(await jsonBody(c), ctx)));

  app.patch('/api/items/:id', async (c) => {
    const body = await jsonBody(c);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OverseerError('INVALID_INPUT', 'Body must be a JSON object.');
    return c.json(await service.updateItem({ ...body, id: c.req.param('id') }, ctx));
  });

  app.post('/api/links', async (c) => {
    const { src, rel, dst } = parseInput(linkSchema, await jsonBody(c));
    return c.json(service.link(src, rel, dst, ctx));
  });

  app.delete('/api/links', async (c) => {
    const { src, rel, dst } = parseInput(linkSchema, await jsonBody(c));
    return c.json(service.link(src, rel, dst, ctx, true));
  });

  app.get('/api/search', async (c) => {
    const { q, kind, limit } = parseInput(searchQuerySchema, c.req.query());
    return c.json(await service.search(q, { kind, limit }));
  });

  app.post('/api/similar', async (c) => {
    const { text, kind, limit } = parseInput(similarSchema, await jsonBody(c));
    return c.json(await service.findSimilar(text, { kind, limit }));
  });

  app.get('/api/reports/:kind', (c) => {
    const kind = parseInput(z.enum(REPORT_KINDS), c.req.param('kind'));
    return c.json(service.report(kind));
  });

  app.post('/api/export', async (c) => {
    const { only, since } = parseInput(exportSchema, await jsonBody(c));
    return c.json(service.exportReports({ only, since }));
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const pending: number[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = watcher.subscribe((version) => {
        pending.push(version);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: 'ready', data: JSON.stringify({ data_version: service.dataVersion() }) });
      let lastPing = Date.now();
      while (!stream.aborted) {
        await Promise.race([new Promise<void>((resolve) => (wake = resolve)), stream.sleep(15_000)]);
        wake = undefined;
        for (const version of pending.splice(0)) await stream.writeSSE({ event: 'changed', data: JSON.stringify({ data_version: version }) });
        if (Date.now() - lastPing >= 15_000) {
          await stream.writeSSE({ event: 'ping', data: '{}' });
          lastPing = Date.now();
        }
      }
      unsubscribe();
    }),
  );

  app.all('/api/*', (c) => c.json({ error: { code: 'NOT_FOUND', message: `No route ${c.req.method} ${c.req.path}` } }, 404));

  app.get('*', (c) => {
    const path = normalize(decodeURIComponent(c.req.path)).replace(/^([/\\])+/, '');
    const file = join(assets, path);
    if (path !== '' && path !== 'index.html' && file.startsWith(assets + sep) && existsSync(file) && statSync(file).isFile()) {
      return c.body(readFileSync(file), 200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': path.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
    }
    if (!indexHtml) return c.text('Board assets are not built (run "npm run build" in the overseer package).', 503);
    return c.html(indexHtml, 200, { 'cache-control': 'no-store' });
  });

  return { app, dispose: () => watcher.stop() };
}

function openUrl(url: string): void {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Best effort: the URL is printed/returned anyway.
  }
}

/** Starts the board on 127.0.0.1 (port, then up to +19 on EADDRINUSE). */
export async function startBoardServer(options: BoardOptions): Promise<BoardServer> {
  const token = randomBytes(24).toString('hex');
  let port = options.port ?? DEFAULT_PORT;
  const { app, dispose } = createBoardApp(options.service, { token, port: () => port });
  const server = createAdaptorServer({ fetch: app.fetch, hostname: '127.0.0.1' });
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      break;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'EADDRINUSE' || attempt + 1 >= PORT_ATTEMPTS) {
        dispose();
        throw error;
      }
      port += 1;
    }
  }
  const address = server.address();
  if (address && typeof address === 'object') port = (address satisfies AddressInfo).port;
  const url = `http://127.0.0.1:${port}/`;
  if (options.openBrowser) openUrl(`${url}#/board`);
  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        dispose();
        if ('closeAllConnections' in server) server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

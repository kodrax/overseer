import type {
  CreateItemInput,
  CreateItemResult,
  ExportInput,
  ExportResult,
  ItemDetail,
  Kind,
  LinkInput,
  LinkResult,
  ListItemsQuery,
  ListItemsResult,
  ProjectInfo,
  ReportKind,
  ReportResponse,
  SearchResponse,
  SimilarResponse,
  UpdateItemInput,
  UpdateItemResult,
} from './types';

declare global {
  interface Window {
    __OVERSEER__?: { token: string };
  }
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** Human-readable `<CODE>: <message>` for toasts and inline errors. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    const token = window.__OVERSEER__?.token;
    if (token) headers['X-Overseer-Token'] = token;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (cause) {
    throw new ApiError('NETWORK', `Cannot reach the overseer board server (${errorText(cause)})`, 0);
  }
  const text = await res.text();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }
  if (!res.ok) {
    const err = (payload as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    const code = typeof err?.code === 'string' ? err.code : `HTTP_${res.status}`;
    const message = typeof err?.message === 'string' ? err.message : text || res.statusText;
    throw new ApiError(code, message, res.status);
  }
  return payload as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const api = {
  project: () => request<ProjectInfo>('GET', '/api/project'),

  listItems: (q: ListItemsQuery = {}) =>
    request<ListItemsResult>(
      'GET',
      `/api/items${qs({
        kind: q.kind,
        status: q.status?.length ? q.status.join(',') : undefined,
        req_type: q.req_type,
        coverage: q.coverage?.length ? q.coverage.join(',') : undefined,
        tag: q.tag,
        parent_id: q.parent_id,
        include_closed: q.include_closed ? 1 : undefined,
        limit: q.limit,
        offset: q.offset,
      })}`,
    ),

  getItem: (id: string, history = false) =>
    request<ItemDetail>('GET', `/api/items/${encodeURIComponent(id)}${history ? '?history=1' : ''}`),

  createItem: (input: CreateItemInput) => request<CreateItemResult>('POST', '/api/items', input),

  updateItem: (id: string, input: UpdateItemInput) =>
    request<UpdateItemResult>('PATCH', `/api/items/${encodeURIComponent(id)}`, input),

  link: (input: LinkInput) => request<LinkResult>('POST', '/api/links', input),

  unlink: (input: LinkInput) => request<LinkResult>('DELETE', '/api/links', input),

  search: (q: string, kind?: Kind, limit?: number) =>
    request<SearchResponse>('GET', `/api/search${qs({ q, kind, limit })}`),

  similar: (text: string, kind?: Kind, limit?: number) =>
    request<SimilarResponse>('POST', '/api/similar', { text, kind, limit }),

  report: <K extends ReportKind>(kind: K) => request<ReportResponse<K>>('GET', `/api/reports/${kind}`),

  exportReports: (input: ExportInput = {}) => request<ExportResult>('POST', '/api/export', input),
};

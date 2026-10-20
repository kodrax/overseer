// Shared setup for the SPA component tests: a stubbed /api, a fake EventSource, fixtures and a render helper.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';
import {
  CLOSED_STATUSES,
  COVERAGE_STATES,
  KINDS,
  NFR_CATEGORIES,
  PRIORITIES,
  RELATIONS,
  REQ_TYPES,
  SEVERITIES,
  STATUSES,
  VERIFICATION_METHODS,
} from '../../src/core/schema.js';
import { ToastProvider } from '../../web/src/toast';
import type { Enums, ListedItem, ProjectInfo } from '../../web/src/types';

export interface ApiCall {
  method: string;
  /** Path with query string, e.g. `/api/items?limit=5000`. */
  path: string;
  body: unknown;
}

/** Returns the JSON payload for a call, or undefined for a 404. */
export type ApiHandler = (call: ApiCall) => unknown;

export const DAY_MS = 24 * 60 * 60 * 1000;

// The board server sends these enums from src/core/schema.ts (GET /api/project); reuse them so the fixture cannot drift.
export const enums = {
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
} as unknown as Enums;

export const project: ProjectInfo = {
  initialized: true,
  root: '/tmp/spa-test',
  project_name: 'spa-test',
  version: '0.0.0',
  schema_version: '1',
  vec_available: true,
  counts: {},
  enums,
};

export function listedItem(fields: Partial<ListedItem> & Pick<ListedItem, 'id' | 'title'>): ListedItem {
  const at = new Date().toISOString();
  return {
    kind: 'task',
    description: '',
    status: 'backlog',
    priority: 'should',
    req_type: null,
    nfr_category: null,
    rationale: null,
    acceptance_criteria: [],
    fit_criterion: null,
    verification_method: null,
    asked_by: null,
    source: null,
    recorded_via: 'test',
    in_backlog: false,
    parent_id: null,
    assignee: null,
    estimate: null,
    milestone: null,
    severity: null,
    bug_details: null,
    component: null,
    tags: [],
    code_refs: [],
    external_ref: null,
    external_url: null,
    external_state: null,
    external_synced_at: null,
    delivered_at: null,
    delivered_in: null,
    created_at: at,
    updated_at: at,
    status_changed_at: at,
    implements: [],
    ...fields,
  };
}

/** Every request the SPA sent through fetch, in order. */
export const calls: ApiCall[] = [];
let handler: ApiHandler = () => undefined;

/** Routes fetch to `next` for the rest of the test. */
export function stubApi(next: ApiHandler): void {
  handler = next;
}

export const callsTo = (method: string, path: string): ApiCall[] =>
  calls.filter((c) => c.method === method && c.path.split('?')[0] === path);

/** Stand-in for the browser EventSource (jsdom has none); `emit` delivers a server-sent event. */
export class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(type: string, data = ''): void {
    if (type === 'open') this.onopen?.(new Event('open'));
    else this.dispatchEvent(new MessageEvent(type, { data }));
  }

  close(): void {
    this.closed = true;
  }
}

beforeEach(() => {
  calls.length = 0;
  handler = () => undefined;
  FakeEventSource.instances = [];
  window.location.hash = '';
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const call: ApiCall = {
        method: init.method ?? 'GET',
        path: input,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const payload = handler(call);
      if (payload === undefined) {
        return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `${call.method} ${call.path}` } }), {
          status: 404,
        });
      }
      return new Response(JSON.stringify(payload), { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Renders `ui` inside the providers main.tsx sets up, with retries off so failures surface at once. */
export function renderWithProviders(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{ui}</ToastProvider>
      </QueryClientProvider>,
    ),
  };
}

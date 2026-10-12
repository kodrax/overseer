import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { queryKeys, useDebounced, useStoredChoice } from '../hooks';
import {
  CoverageBadge,
  ErrorBox,
  humanize,
  inlineControlClass,
  ITEM_ORDERS,
  ItemLink,
  Loading,
  percent,
  PriorityBadge,
  shortDate,
  sortByPriority,
  StatusBadge,
  tableClass,
  tdClass,
  thClass,
  type ItemOrder,
} from '../ui';
import type { ListedItem, ListItemsQuery, ProjectInfo } from '../types';

const REQUIREMENTS_QUERY: ListItemsQuery = { kind: 'requirement', include_closed: true, limit: 5000 };

export function RequirementsPage({ project }: { project: ProjectInfo }) {
  const { enums } = project;
  const [reqType, setReqType] = useState('');
  const [status, setStatus] = useState('');
  const [coverage, setCoverage] = useState('');
  const [priority, setPriority] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [search, setSearch] = useState('');
  const [order, setOrder] = useStoredChoice<ItemOrder>('overseer.requirements.order', ITEM_ORDERS, 'id');
  const query = useDebounced(search.trim(), 300);

  const items = useQuery({ queryKey: queryKeys.items(REQUIREMENTS_QUERY), queryFn: () => api.listItems(REQUIREMENTS_QUERY) });
  const results = useQuery({
    queryKey: queryKeys.search(query, 'requirement'),
    queryFn: () => api.search(query, 'requirement', 100),
    enabled: query.length > 0,
  });

  const closed = enums.closed_statuses.requirement ?? [];
  const matches = (it: ListedItem) =>
    (!reqType || it.req_type === reqType) &&
    (status ? it.status === status : showClosed || !closed.includes(it.status)) &&
    (!coverage || it.coverage === coverage) &&
    (!priority || it.priority === priority);

  const all = items.data?.items ?? [];
  const searching = query.length > 0;
  let rows: { item: ListedItem; similarity: number | null }[];
  if (searching) {
    const byId = new Map(all.map((it) => [it.id, it]));
    rows = (results.data?.results ?? []).flatMap((r) => {
      const item = byId.get(r.id);
      return item ? [{ item, similarity: r.similarity }] : [];
    });
  } else {
    rows = all.map((item) => ({ item, similarity: null }));
  }
  rows = rows.filter((r) => matches(r.item));
  if (order === 'priority') rows = sortByPriority(rows, (r) => r.item.priority, enums.priorities);

  const filterSelect = (label: string, value: string, set: (v: string) => void, options: readonly string[]) => (
    <select className={inlineControlClass} value={value} onChange={(e) => set(e.target.value)} aria-label={label}>
      <option value="">{`Any ${label.toLowerCase()}`}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {humanize(o)}
        </option>
      ))}
    </select>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          className={`${inlineControlClass} w-72`}
          placeholder="Semantic search in requirements…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {filterSelect('Type', reqType, setReqType, enums.req_types)}
        {filterSelect('Status', status, setStatus, enums.statuses.requirement ?? [])}
        {filterSelect('Coverage', coverage, setCoverage, enums.coverage_states)}
        {filterSelect('Priority', priority, setPriority, enums.priorities)}
        <label className="flex items-center gap-1 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Show rejected/obsolete
        </label>
        <span className="text-xs text-slate-500">
          {rows.length} shown
          {searching && results.data && !results.data.semantic && ' · keyword search only'}
        </span>
      </div>
      {searching && results.data?.warning && <p className="text-xs text-amber-600 dark:text-amber-400">{results.data.warning}</p>}

      {items.isPending || (searching && results.isPending) ? (
        <Loading />
      ) : items.isError ? (
        <ErrorBox error={items.error} />
      ) : searching && results.isError ? (
        <ErrorBox error={results.error} />
      ) : rows.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">{searching ? 'No requirement matches this search.' : 'No requirements.'}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>ID</th>
                <th className={thClass}>Title</th>
                <th className={thClass}>Type</th>
                <th className={thClass}>NFR category</th>
                <th className={thClass} aria-sort={order === 'priority' ? 'descending' : undefined}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 uppercase hover:text-slate-800 dark:hover:text-slate-100"
                    onClick={() => setOrder(order === 'priority' ? 'id' : 'priority')}
                    title={order === 'priority' ? 'Priority order (must first). Click to go back to the default order.' : 'Order by priority, must first'}
                  >
                    Priority
                    <span aria-hidden="true" className={order === 'priority' ? 'text-sky-600 dark:text-sky-400' : 'text-slate-300 dark:text-slate-600'}>
                      {order === 'priority' ? '↓' : '↕'}
                    </span>
                  </button>
                </th>
                <th className={thClass}>Status</th>
                <th className={thClass}>Coverage</th>
                <th className={thClass}>In backlog</th>
                <th className={thClass}>Asked by</th>
                <th className={thClass}>Created</th>
                {searching && <th className={thClass}>Similarity</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ item, similarity }) => (
                <tr key={item.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/40">
                  <td className={tdClass}>
                    <ItemLink id={item.id} />
                  </td>
                  <td className={`${tdClass} min-w-64`}>{item.title}</td>
                  <td className={`${tdClass} whitespace-nowrap`}>{humanize(item.req_type)}</td>
                  <td className={`${tdClass} whitespace-nowrap`}>{humanize(item.nfr_category)}</td>
                  <td className={tdClass}>
                    <PriorityBadge priority={item.priority} />
                  </td>
                  <td className={tdClass}>
                    <StatusBadge status={item.status} />
                  </td>
                  <td className={tdClass}>
                    <CoverageBadge coverage={item.coverage} />
                  </td>
                  <td className={tdClass}>{item.in_backlog ? 'yes' : 'no'}</td>
                  <td className={tdClass}>{item.asked_by ?? ''}</td>
                  <td className={`${tdClass} whitespace-nowrap`}>{shortDate(item.created_at)}</td>
                  {searching && <td className={`${tdClass} font-mono text-xs`}>{percent(similarity)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

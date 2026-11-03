import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { CoverageTrack, StatusBadge } from '../ds/components';
import { queryKeys, useDebounced, useStoredChoice } from '../hooks';
import { ErrorBox, ITEM_ORDERS, ItemLink, Loading, PriorityBadge, score, shortDate, sortByPriority, type ItemOrder } from '../ui';
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
    <select className="ov-input" value={value} onChange={(e) => set(e.target.value)} aria-label={label}>
      <option value="">{`Any ${label.toLowerCase()}`}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );

  return (
    <div>
      <div className="page-head">
        <h1 className="ov-h1">Requirements</h1>
        <input
          type="search"
          className="ov-input toolbar-search-wide"
          placeholder="Semantic search in requirements…"
          aria-label="Search requirements"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {filterSelect('Type', reqType, setReqType, enums.req_types)}
        {filterSelect('Status', status, setStatus, enums.statuses.requirement ?? [])}
        {filterSelect('Coverage', coverage, setCoverage, enums.coverage_states)}
        {filterSelect('Priority', priority, setPriority, enums.priorities)}
        <label className="check">
          <input className="ov-check" type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Show rejected/obsolete
        </label>
        <span className="small-muted">
          {rows.length} shown
          {searching && results.data && !results.data.semantic && ' · keyword search only'}
        </span>
      </div>
      {searching && results.data?.warning && <p className="app-warn page-warning">{results.data.warning}</p>}

      {items.isPending || (searching && results.isPending) ? (
        <Loading />
      ) : items.isError ? (
        <ErrorBox error={items.error} />
      ) : searching && results.isError ? (
        <ErrorBox error={results.error} />
      ) : rows.length === 0 ? (
        <p className="quiet-note">{searching ? 'No requirement matches this search.' : 'No requirements.'}</p>
      ) : (
        <div className="table-panel">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Title</th>
                <th>Type</th>
                <th>NFR category</th>
                <th aria-sort={order === 'priority' ? 'descending' : undefined}>
                  <button
                    type="button"
                    className="th-button"
                    onClick={() => setOrder(order === 'priority' ? 'id' : 'priority')}
                    title={order === 'priority' ? 'Priority order (must first). Click to go back to the default order.' : 'Order by priority, must first'}
                  >
                    Priority
                    <span aria-hidden="true" data-on={order === 'priority'}>
                      {order === 'priority' ? '↓' : '↕'}
                    </span>
                  </button>
                </th>
                <th>Status</th>
                <th>Coverage</th>
                <th>In backlog</th>
                <th>Asked by</th>
                <th>Created</th>
                {searching && <th>Similarity</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ item, similarity }) => (
                <tr key={item.id}>
                  <td>
                    <ItemLink id={item.id} />
                  </td>
                  <td className="title-cell">{item.title}</td>
                  <td className="nowrap mono">{item.req_type}</td>
                  <td className="nowrap mono">{item.nfr_category}</td>
                  <td>
                    <PriorityBadge priority={item.priority} />
                  </td>
                  <td>
                    <StatusBadge status={item.status} />
                  </td>
                  <td>{item.coverage && <CoverageTrack coverage={item.coverage} />}</td>
                  <td>{item.in_backlog ? 'yes' : 'no'}</td>
                  <td>{item.asked_by ?? ''}</td>
                  <td className="nowrap">{shortDate(item.created_at)}</td>
                  {searching && <td className="mono">{score(similarity)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

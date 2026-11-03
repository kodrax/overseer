import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, errorText } from '../api';
import { BoardCard, BoardColumn } from '../ds/components';
import { queryKeys, useStoredChoice } from '../hooks';
import { itemHref, navigate } from '../router';
import { useToast } from '../toast';
import {
  ErrorBox,
  ITEM_ORDERS,
  Loading,
  PriorityAccent,
  PriorityBadge,
  sortByPriority,
  type ItemOrder,
} from '../ui';
import type { Kind, ListedItem, ListItemsQuery, ListItemsResult, Priority, ProjectInfo } from '../types';

const BOARD_KINDS: Kind[] = ['story', 'task', 'bug'];
const BOARD_QUERY: ListItemsQuery = { limit: 5000 };
const DONE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Time of the last drop; a click fired by the same pointer-up must not open the card. */
let lastDropAt = 0;

export function BoardPage({ project }: { project: ProjectInfo }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const itemsKey = queryKeys.items(BOARD_QUERY);
  const items = useQuery({ queryKey: itemsKey, queryFn: () => api.listItems(BOARD_QUERY) });

  const [kind, setKind] = useState<Kind | ''>('');
  const [epic, setEpic] = useState('');
  const [tag, setTag] = useState('');
  const [text, setText] = useState('');
  const [showAllDone, setShowAllDone] = useState(false);
  const [order, setOrder] = useStoredChoice<ItemOrder>('overseer.board.order', ITEM_ORDERS, 'id');
  const [dragging, setDragging] = useState<ListedItem | null>(null);

  const closed = project.enums.closed_statuses.story ?? [];
  const columns = (project.enums.statuses.story ?? []).filter((s) => !closed.includes(s));

  const moveMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.updateItem(id, { status }),
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: itemsKey });
      const previous = queryClient.getQueryData<ListItemsResult>(itemsKey);
      queryClient.setQueryData<ListItemsResult>(itemsKey, (old) =>
        old && {
          ...old,
          items: old.items.map((it) =>
            it.id === id ? { ...it, status, status_changed_at: new Date().toISOString() } : it,
          ),
        },
      );
      return { previous };
    },
    onError: (err, { id, status }, context) => {
      if (context?.previous) queryClient.setQueryData(itemsKey, context.previous);
      toast.push('error', `Could not move ${id} to ${status}: ${errorText(err)}`);
    },
    onSettled: (_data, _err, { id }) => {
      void queryClient.invalidateQueries({ queryKey: ['items'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.item(id) });
    },
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const all = items.data?.items ?? [];
  const byId = useMemo(() => new Map(all.map((it) => [it.id, it])), [all]);
  const epics = all.filter((it) => it.kind === 'epic');
  const tags = useMemo(
    () => [...new Set(all.filter((it) => BOARD_KINDS.includes(it.kind)).flatMap((it) => it.tags))].sort(),
    [all],
  );

  const needle = text.trim().toLowerCase();
  const visible = all.filter((it) => {
    if (!BOARD_KINDS.includes(it.kind)) return false;
    if (kind && it.kind !== kind) return false;
    if (tag && !it.tags.includes(tag)) return false;
    if (epic) {
      const parent = it.parent_id ? byId.get(it.parent_id) : undefined;
      if (it.parent_id !== epic && parent?.parent_id !== epic) return false;
    }
    if (needle && !it.title.toLowerCase().includes(needle) && !it.id.toLowerCase().includes(needle)) return false;
    return true;
  });

  const now = Date.now();
  const grouped = new Map<string, ListedItem[]>(columns.map((c) => [c, []]));
  let hiddenDone = 0;
  const ordered = order === 'priority' ? sortByPriority(visible, (it) => it.priority, project.enums.priorities) : visible;
  for (const it of ordered) {
    const bucket = grouped.get(it.status);
    if (!bucket) continue;
    if (it.status === 'done' && !showAllDone) {
      const changed = Date.parse(it.status_changed_at);
      if (Number.isFinite(changed) && now - changed > DONE_WINDOW_MS) {
        hiddenDone++;
        continue;
      }
    }
    bucket.push(it);
  }

  const onDragStart = (e: DragStartEvent) => setDragging(byId.get(String(e.active.id)) ?? null);
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    lastDropAt = Date.now();
    if (!e.over) return;
    const id = String(e.active.id);
    const status = String(e.over.id);
    const item = byId.get(id);
    if (item && item.status !== status) moveMutation.mutate({ id, status });
  };

  return (
    <div>
      <div className="page-head">
        <h1 className="ov-h1">Board</h1>
        <select className="ov-input" value={kind} onChange={(e) => setKind(e.target.value as Kind | '')} aria-label="Kind">
          <option value="">All kinds</option>
          {BOARD_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select className="ov-input toolbar-epic" value={epic} onChange={(e) => setEpic(e.target.value)} aria-label="Epic">
          <option value="">All epics</option>
          {epics.map((ep) => (
            <option key={ep.id} value={ep.id}>
              {ep.id} — {ep.title}
            </option>
          ))}
        </select>
        <select className="ov-input" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
          <option value="">All tags</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          className="ov-input toolbar-search"
          placeholder="Filter by ID or title"
          aria-label="Filter by ID or title"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select className="ov-input" value={order} onChange={(e) => setOrder(e.target.value as ItemOrder)} aria-label="Order">
          <option value="id">ID order</option>
          <option value="priority">Priority order</option>
        </select>
        <label className="check">
          <input className="ov-check" type="checkbox" checked={showAllDone} onChange={(e) => setShowAllDone(e.target.checked)} />
          Show all done
        </label>
        {items.isFetching && <span className="small-muted">Refreshing…</span>}
        <PriorityLegend priorities={project.enums.priorities} />
      </div>

      {items.isPending ? (
        <Loading />
      ) : items.isError ? (
        <ErrorBox error={items.error} />
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          <div className="board-columns">
            {columns.map((status) => (
              <Column
                key={status}
                status={status}
                items={grouped.get(status) ?? []}
                footer={status === 'done' && hiddenDone > 0 ? `${hiddenDone} done more than 30 days ago hidden` : undefined}
              />
            ))}
          </div>
          <DragOverlay>{dragging ? <CardBody item={dragging} dragging /> : null}</DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

function PriorityLegend({ priorities }: { priorities: Priority[] }) {
  return (
    <div className="priority-legend">
      <span>Priority</span>
      <ul aria-label="Priority legend">
        {priorities.map((priority) => (
          <li key={priority}>
            <PriorityAccent priority={priority} className="legend-swatch" />
            <PriorityBadge priority={priority} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Column({ status, items, footer }: { status: string; items: ListedItem[]; footer?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <BoardColumn ref={setNodeRef} title={status.replace(/_/g, ' ')} count={items.length} over={isOver} footer={footer}>
      {items.map((it) => (
        <Card key={it.id} item={it} />
      ))}
    </BoardColumn>
  );
}

function Card({ item }: { item: ListedItem }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: item.id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => {
        if (Date.now() - lastDropAt > 250) navigate({ name: 'item', id: item.id });
      }}
      className="board-card"
      data-source={isDragging}
    >
      <CardBody item={item} />
    </div>
  );
}

function CardBody({ item, dragging = false }: { item: ListedItem; dragging?: boolean }) {
  return (
    <BoardCard
      id={item.id}
      href={itemHref(item.id)}
      onIdClick={(e) => e.stopPropagation()}
      title={item.title}
      dragging={dragging}
      lead={<PriorityAccent priority={item.priority} className="card-accent" />}
      aside={<PriorityBadge priority={item.priority} />}
      meta={item.assignee ? <span>@{item.assignee}</span> : undefined}
      relation={{ rel: 'implements', ids: item.implements }}
      tags={item.tags}
    />
  );
}

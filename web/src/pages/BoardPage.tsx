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
import { queryKeys, useStoredChoice } from '../hooks';
import { itemHref, navigate } from '../router';
import { useToast } from '../toast';
import {
  ErrorBox,
  humanize,
  inlineControlClass,
  ITEM_ORDERS,
  KindBadge,
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
      toast.push('error', `Could not move ${id} to ${humanize(status)}: ${errorText(err)}`);
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className={inlineControlClass} value={kind} onChange={(e) => setKind(e.target.value as Kind | '')} aria-label="Kind">
          <option value="">All kinds</option>
          {BOARD_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select className={`${inlineControlClass} max-w-64`} value={epic} onChange={(e) => setEpic(e.target.value)} aria-label="Epic">
          <option value="">All epics</option>
          {epics.map((ep) => (
            <option key={ep.id} value={ep.id}>
              {ep.id} — {ep.title}
            </option>
          ))}
        </select>
        <select className={inlineControlClass} value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
          <option value="">All tags</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          className={`${inlineControlClass} w-56`}
          placeholder="Filter by ID or title"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select className={inlineControlClass} value={order} onChange={(e) => setOrder(e.target.value as ItemOrder)} aria-label="Order">
          <option value="id">ID order</option>
          <option value="priority">Priority order</option>
        </select>
        <label className="flex items-center gap-1 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={showAllDone} onChange={(e) => setShowAllDone(e.target.checked)} />
          Show all done
        </label>
        {items.isFetching && <span className="text-xs text-slate-400">Refreshing…</span>}
        <PriorityLegend priorities={project.enums.priorities} />
      </div>

      {items.isPending ? (
        <Loading />
      ) : items.isError ? (
        <ErrorBox error={items.error} />
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          <div className="grid auto-cols-[minmax(15rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
            {columns.map((status) => (
              <Column
                key={status}
                status={status}
                items={grouped.get(status) ?? []}
                footer={status === 'done' && hiddenDone > 0 ? `${hiddenDone} done more than 30 days ago hidden` : undefined}
              />
            ))}
          </div>
          <DragOverlay>{dragging ? <CardBody item={dragging} /> : null}</DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

function PriorityLegend({ priorities }: { priorities: Priority[] }) {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <span>Priority</span>
      <ul aria-label="Priority legend" className="flex flex-wrap items-center gap-2">
        {priorities.map((priority) => (
          <li key={priority} className="flex items-center gap-1">
            <PriorityAccent priority={priority} className="h-4 w-1 rounded-sm" />
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
    <div
      ref={setNodeRef}
      className={`flex min-h-[60vh] flex-col rounded-lg border p-2 ${
        isOver
          ? 'border-sky-400 bg-sky-50 dark:border-sky-600 dark:bg-sky-950/40'
          : 'border-slate-200 bg-slate-100/70 dark:border-slate-700 dark:bg-slate-800/50'
      }`}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-300">{humanize(status)}</h2>
        <span className="rounded-full bg-slate-200 px-1.5 text-xs text-slate-600 dark:bg-slate-700 dark:text-slate-300">
          {items.length}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-2">
        {items.map((it) => (
          <Card key={it.id} item={it} />
        ))}
      </div>
      {footer && <p className="mt-2 px-1 text-xs text-slate-400">{footer}</p>}
    </div>
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
      className={`cursor-grab touch-none ${isDragging ? 'opacity-40' : ''}`}
    >
      <CardBody item={item} />
    </div>
  );
}

function CardBody({ item }: { item: ListedItem }) {
  return (
    <div className="relative overflow-hidden rounded-md border border-slate-200 bg-white py-2 pr-2 pl-3 text-sm shadow-sm hover:border-sky-300 dark:border-slate-600 dark:bg-slate-800 dark:hover:border-sky-600">
      <PriorityAccent priority={item.priority} className="absolute inset-y-0 left-0 w-1" />
      <div className="mb-1 flex items-center gap-1.5">
        <a
          href={itemHref(item.id)}
          className="font-mono text-xs text-sky-700 hover:underline dark:text-sky-400"
          onClick={(e) => e.stopPropagation()}
        >
          {item.id}
        </a>
        <KindBadge kind={item.kind} />
        <span className="ml-auto">
          <PriorityBadge priority={item.priority} />
        </span>
      </div>
      <div className="leading-snug break-words">{item.title}</div>
      {(item.assignee || item.implements.length > 0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
          {item.assignee && <span>@{item.assignee}</span>}
          {item.implements.map((rid) => (
            <span
              key={rid}
              className="rounded bg-violet-50 px-1 font-mono text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
              title={`Implements ${rid}`}
            >
              {rid}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api';
import { queryKeys } from '../hooks';
import { changedFields, draftFromItem, ItemFieldsEditor, validateDraft, type Draft } from '../itemForm';
import { useToast } from '../toast';
import {
  buttonClass,
  CoverageBadge,
  ErrorBox,
  humanize,
  inlineControlClass,
  inputClass,
  ItemLink,
  KindBadge,
  linkClass,
  Loading,
  primaryButtonClass,
  PriorityBadge,
  Section,
  shortDateTime,
  StatusBadge,
  WarningsList,
} from '../ui';
import type { Item, ItemDetail, ItemEvent, ItemRef, LinkInput, LinkRef, LintWarning, ProjectInfo, Relation } from '../types';

export function ItemPage({ id, project }: { id: string; project: ProjectInfo }) {
  const detail = useQuery({ queryKey: queryKeys.item(id), queryFn: () => api.getItem(id, true) });

  if (detail.isPending) return <Loading />;
  if (detail.isError) return <ErrorBox error={detail.error} />;
  const { item, coverage, links, children, history } = detail.data;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-slate-500">{item.id}</span>
          <KindBadge kind={item.kind} />
          <StatusBadge status={item.status} />
          <PriorityBadge priority={item.priority} />
          {item.kind === 'requirement' && <CoverageBadge coverage={coverage ?? item.coverage} />}
        </div>
        <h1 className="text-xl font-semibold break-words">{item.title}</h1>
        <p className="text-xs text-slate-500">
          Created {shortDateTime(item.created_at)} · updated {shortDateTime(item.updated_at)} · status since{' '}
          {shortDateTime(item.status_changed_at)}
          {item.delivered_at && <> · delivered {shortDateTime(item.delivered_at)}</>} · recorded via {item.recorded_via}
          {item.external_ref && (
            <>
              {' '}
              · {item.external_ref}
              {item.external_url && (
                <>
                  {' '}
                  (
                  <a className={linkClass} href={item.external_url} target="_blank" rel="noreferrer noopener">
                    open
                  </a>
                  {item.external_state ? `, ${item.external_state}` : ''})
                </>
              )}
            </>
          )}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <EditForm item={item} project={project} />
        <div className="space-y-4">
          <LinksSection item={item} outgoing={links.outgoing} incoming={links.incoming} project={project} />
          <Section title={`Children (${children.length})`}>
            <RefList refs={children} empty="No child items." />
          </Section>
          <HistorySection item={item} history={history ?? []} />
        </div>
      </div>
    </div>
  );
}

function RefList({ refs, empty }: { refs: ItemRef[]; empty: string }) {
  if (refs.length === 0) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="space-y-1">
      {refs.map((r) => (
        <li key={r.id} className="flex items-center gap-1.5 text-sm">
          <ItemLink id={r.id} />
          <KindBadge kind={r.kind} />
          <StatusBadge status={r.status} />
          <span className="truncate" title={r.title}>
            {r.title}
          </span>
        </li>
      ))}
    </ul>
  );
}

function EditForm({ item, project }: { item: Item; project: ProjectInfo }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  // `base` is the item version the draft was started from; remote changes replace it only while the draft is clean.
  const [form, setForm] = useState<{ base: Item; draft: Draft }>(() => ({ base: item, draft: draftFromItem(item) }));
  const [warnings, setWarnings] = useState<LintWarning[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const pending = changedFields(form.base, form.draft);
  const dirty = Object.keys(pending).length > 0;
  const stale = form.base.updated_at !== item.updated_at;
  if (stale && !dirty) setForm({ base: item, draft: draftFromItem(item) });

  const save = useMutation({
    mutationFn: () => api.updateItem(item.id, pending),
    onSuccess: (res) => {
      queryClient.setQueryData<ItemDetail>(queryKeys.item(item.id), (old) => old && { ...old, item: res.item });
      setForm({ base: res.item, draft: draftFromItem(res.item) });
      setWarnings(res.warnings);
      toast.push('success', `Saved ${res.item.id}`, res.changed_fields.length ? [`Changed: ${res.changed_fields.join(', ')}`] : []);
      void queryClient.invalidateQueries();
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const invalid = validateDraft(form.draft, item.kind);
    setProblem(invalid);
    if (!invalid && dirty) save.mutate();
  };

  return (
    <Section title="Details">
      <form onSubmit={onSubmit} className="space-y-3">
        {stale && dirty && (
          <div className="flex items-center gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
            <span className="flex-1">This item was changed elsewhere while you were editing.</span>
            <button type="button" className={buttonClass} onClick={() => setForm({ base: item, draft: draftFromItem(item) })}>
              Discard my changes
            </button>
          </div>
        )}
        <ItemFieldsEditor kind={item.kind} draft={form.draft} onChange={(draft) => setForm({ ...form, draft })} enums={project.enums} />
        <WarningsList warnings={warnings} />
        {problem && <ErrorBox error={new Error(problem)} />}
        {save.isError && <ErrorBox error={save.error} />}
        <div className="flex items-center justify-end gap-2">
          {dirty && <span className="text-xs text-slate-500">Unsaved: {Object.keys(pending).join(', ')}</span>}
          <button
            type="button"
            className={buttonClass}
            disabled={!dirty || save.isPending}
            onClick={() => setForm({ base: form.base, draft: draftFromItem(form.base) })}
          >
            Reset
          </button>
          <button type="submit" className={primaryButtonClass} disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Section>
  );
}

function LinksSection({
  item,
  outgoing,
  incoming,
  project,
}: {
  item: Item;
  outgoing: LinkRef[];
  incoming: LinkRef[];
  project: ProjectInfo;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [rel, setRel] = useState<Relation>(item.kind === 'bug' ? 'affects' : item.kind === 'requirement' ? 'refines' : 'implements');
  const [direction, setDirection] = useState<'out' | 'in'>('out');
  const [target, setTarget] = useState('');

  const add = useMutation({
    mutationFn: (input: LinkInput) => api.link(input),
    onSuccess: () => {
      setTarget('');
      void queryClient.invalidateQueries();
    },
  });
  const remove = useMutation({
    mutationFn: (input: LinkInput) => api.unlink(input),
    onSuccess: () => void queryClient.invalidateQueries(),
    onError: (err) => toast.push('error', `Could not remove link: ${errorText(err)}`),
  });

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    const other = target.trim().toUpperCase();
    if (!other) return;
    add.mutate(direction === 'out' ? { src: item.id, rel, dst: other } : { src: other, rel, dst: item.id });
  };

  const row = (link: LinkRef, input: LinkInput, arrow: string) => (
    <li key={`${arrow}${link.rel}:${link.id}`} className="flex items-center gap-1.5 text-sm">
      <span className="w-28 shrink-0 text-xs text-slate-500">
        {arrow} {humanize(link.rel)}
      </span>
      <ItemLink id={link.id} />
      <KindBadge kind={link.kind} />
      <StatusBadge status={link.status} />
      <span className="min-w-0 flex-1 truncate" title={link.title}>
        {link.title}
      </span>
      <button
        type="button"
        className="text-slate-400 hover:text-rose-600"
        title="Remove link"
        aria-label={`Remove link ${input.src} ${input.rel} ${input.dst}`}
        disabled={remove.isPending}
        onClick={() => remove.mutate(input)}
      >
        ×
      </button>
    </li>
  );

  return (
    <Section title="Links">
      <div className="space-y-3">
        {outgoing.length === 0 && incoming.length === 0 ? (
          <p className="text-sm text-slate-500">No links.</p>
        ) : (
          <ul className="space-y-1">
            {outgoing.map((l) => row(l, { src: item.id, rel: l.rel, dst: l.id }, '→'))}
            {incoming.map((l) => row(l, { src: l.id, rel: l.rel, dst: item.id }, '←'))}
          </ul>
        )}
        <form onSubmit={onAdd} className="flex flex-wrap gap-1">
          <select
            className={inlineControlClass}
            value={direction}
            aria-label="Direction"
            onChange={(e) => setDirection(e.target.value as 'out' | 'in')}
          >
            <option value="out">{item.id} →</option>
            <option value="in">← from</option>
          </select>
          <select className={inlineControlClass} value={rel} aria-label="Relation" onChange={(e) => setRel(e.target.value as Relation)}>
            {project.enums.relations.map((r) => (
              <option key={r} value={r}>
                {humanize(r)}
              </option>
            ))}
          </select>
          <input
            className={`${inlineControlClass} w-32 font-mono`}
            placeholder="REQ-0001"
            aria-label="Other item ID"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          <button type="submit" className={buttonClass} disabled={add.isPending || !target.trim()}>
            Add link
          </button>
        </form>
        {add.isError && <ErrorBox error={add.error} />}
      </div>
    </Section>
  );
}

function describeEvent(ev: ItemEvent): string {
  switch (ev.action) {
    case 'create':
      return 'created';
    case 'import':
      return `imported${ev.new_value ? ` (${ev.new_value})` : ''}`;
    case 'status':
      return `status ${humanize(ev.old_value) || '∅'} → ${humanize(ev.new_value)}`;
    case 'link':
      return `linked ${humanize(ev.field)} ${ev.new_value ?? ''}`;
    case 'unlink':
      return `unlinked ${humanize(ev.field)} ${ev.old_value ?? ''}`;
    case 'comment':
      return 'commented';
    default:
      return `${ev.field ?? 'field'}: ${ev.old_value ?? '∅'} → ${ev.new_value ?? '∅'}`;
  }
}

function HistorySection({ item, history }: { item: Item; history: ItemEvent[] }) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const send = useMutation({
    mutationFn: (text: string) => api.updateItem(item.id, { comment: text }),
    onSuccess: () => {
      setComment('');
      void queryClient.invalidateQueries();
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (comment.trim()) send.mutate(comment.trim());
  };

  const events = [...history].sort((a, b) => b.seq - a.seq);

  return (
    <Section title="History">
      <form onSubmit={onSubmit} className="mb-3 space-y-1">
        <textarea
          className={inputClass}
          rows={2}
          placeholder="Add a comment…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <div className="flex justify-end">
          <button type="submit" className={buttonClass} disabled={send.isPending || !comment.trim()}>
            {send.isPending ? 'Posting…' : 'Comment'}
          </button>
        </div>
        {send.isError && <ErrorBox error={send.error} />}
      </form>
      {events.length === 0 ? (
        <p className="text-sm text-slate-500">No history.</p>
      ) : (
        <ol className="space-y-2 border-l border-slate-200 pl-3 dark:border-slate-700">
          {events.map((ev) => (
            <li key={ev.seq} className="text-sm">
              <div className="text-xs text-slate-500">
                {shortDateTime(ev.at)} · {ev.actor} · {ev.via}
              </div>
              <div className="break-words whitespace-pre-wrap">
                {ev.item_id !== item.id && <span className="font-mono">{ev.item_id} </span>}
                {describeEvent(ev)}
                {ev.action === 'comment' && ev.new_value && (
                  <blockquote className="mt-0.5 rounded bg-slate-50 px-2 py-1 dark:bg-slate-900">{ev.new_value}</blockquote>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

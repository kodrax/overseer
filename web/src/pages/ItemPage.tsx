import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api';
import { Button, CoverageTrack, ItemId, StatusBadge } from '../ds/components';
import { queryKeys } from '../hooks';
import { changedFields, draftFromItem, ItemFieldsEditor, validateDraft, type Draft } from '../itemForm';
import { useToast } from '../toast';
import { ErrorBox, ItemLink, Loading, PriorityBadge, RefRow, Section, shortDateTime, WarningsList } from '../ui';
import type { Item, ItemDetail, ItemEvent, ItemRef, LinkInput, LinkRef, LintWarning, ProjectInfo, Relation } from '../types';

export function ItemPage({ id, project }: { id: string; project: ProjectInfo }) {
  const detail = useQuery({ queryKey: queryKeys.item(id), queryFn: () => api.getItem(id, true) });

  if (detail.isPending) return <Loading />;
  if (detail.isError) return <ErrorBox error={detail.error} />;
  const { item, coverage, links, children, history } = detail.data;

  const shownCoverage = coverage ?? item.coverage;
  return (
    <div className="item-page stack-4">
      <div className="item-head">
        <div className="row-2">
          <ItemId id={item.id} />
          <StatusBadge status={item.status} />
          <PriorityBadge priority={item.priority} />
          {item.kind === 'requirement' && shownCoverage && <CoverageTrack coverage={shownCoverage} />}
        </div>
        <h1 className="ov-h2 item-title">{item.title}</h1>
        <p className="small-muted">
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
                  <a className="ov-link" href={item.external_url} target="_blank" rel="noreferrer noopener">
                    open
                  </a>
                  {item.external_state ? `, ${item.external_state}` : ''})
                </>
              )}
            </>
          )}
        </p>
      </div>

      <div className="item-grid">
        <EditForm item={item} project={project} />
        <div className="stack-4">
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
  if (refs.length === 0) return <p className="quiet-note">{empty}</p>;
  return (
    <ul className="stack-1">
      {refs.map((r) => (
        <li key={r.id}>
          <RefRow id={r.id} status={r.status} title={r.title} />
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
      <form onSubmit={onSubmit} className="stack-3">
        {stale && dirty && (
          <div className="notice">
            <span>This item was changed elsewhere while you were editing.</span>
            <Button onClick={() => setForm({ base: item, draft: draftFromItem(item) })}>Discard my changes</Button>
          </div>
        )}
        <ItemFieldsEditor kind={item.kind} draft={form.draft} onChange={(draft) => setForm({ ...form, draft })} enums={project.enums} />
        <WarningsList warnings={warnings} />
        {problem && <ErrorBox error={new Error(problem)} />}
        {save.isError && <ErrorBox error={save.error} />}
        <div className="row-end">
          {dirty && <span className="small-muted">Unsaved: {Object.keys(pending).join(', ')}</span>}
          <Button disabled={!dirty || save.isPending} onClick={() => setForm({ base: form.base, draft: draftFromItem(form.base) })}>
            Reset
          </Button>
          {/* One primary per view: the header's New item. */}
          <Button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
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
    <li key={`${arrow}${link.rel}:${link.id}`} className="ref-row">
      <span className="link-rel">
        {arrow} {link.rel}
      </span>
      <ItemLink id={link.id} />
      <StatusBadge status={link.status} />
      <span className="ref-title push-grow" title={link.title}>
        {link.title}
      </span>
      <Button
        icon
        title="Remove link"
        aria-label={`Remove link ${input.src} ${input.rel} ${input.dst}`}
        disabled={remove.isPending}
        onClick={() => remove.mutate(input)}
      >
        ×
      </Button>
    </li>
  );

  return (
    <Section title="Links">
      <div className="stack-3">
        {outgoing.length === 0 && incoming.length === 0 ? (
          <p className="quiet-note">No links.</p>
        ) : (
          <ul className="stack-1">
            {outgoing.map((l) => row(l, { src: item.id, rel: l.rel, dst: l.id }, '→'))}
            {incoming.map((l) => row(l, { src: l.id, rel: l.rel, dst: item.id }, '←'))}
          </ul>
        )}
        <form onSubmit={onAdd} className="row-1">
          <select className="ov-input" value={direction} aria-label="Direction" onChange={(e) => setDirection(e.target.value as 'out' | 'in')}>
            <option value="out">{item.id} →</option>
            <option value="in">← from</option>
          </select>
          <select className="ov-input" value={rel} aria-label="Relation" onChange={(e) => setRel(e.target.value as Relation)}>
            {project.enums.relations.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <input
            className="ov-input ov-input--mono link-id-input"
            placeholder="REQ-0001"
            aria-label="Other item ID"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          <Button type="submit" disabled={add.isPending || !target.trim()}>
            Add link
          </Button>
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
      return `status ${ev.old_value ?? '∅'} → ${ev.new_value ?? '∅'}`;
    case 'link':
      return `linked ${ev.field ?? ''} ${ev.new_value ?? ''}`;
    case 'unlink':
      return `unlinked ${ev.field ?? ''} ${ev.old_value ?? ''}`;
    case 'comment':
      return 'commented';
    case 'overwrite':
      return `overwrote ${ev.field ?? 'field'}: ${ev.old_value ?? '∅'} → ${ev.new_value ?? '∅'}`;
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
      <form onSubmit={onSubmit} className="stack-2 history-form">
        <textarea
          className="ov-input"
          rows={2}
          placeholder="Add a comment…"
          aria-label="Comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <div className="row-end">
          <Button type="submit" disabled={send.isPending || !comment.trim()}>
            {send.isPending ? 'Posting…' : 'Comment'}
          </Button>
        </div>
        {send.isError && <ErrorBox error={send.error} />}
      </form>
      {events.length === 0 ? (
        <p className="quiet-note">No history.</p>
      ) : (
        <ol className="history">
          {events.map((ev) => (
            <li key={ev.seq}>
              <div className="small-muted">
                {shortDateTime(ev.at)} · {ev.actor} · {ev.via}
              </div>
              <div className="history-text">
                {ev.item_id !== item.id && <span className="mono">{ev.item_id} </span>}
                {describeEvent(ev)}
                {ev.action === 'comment' && ev.new_value && <blockquote className="history-comment">{ev.new_value}</blockquote>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

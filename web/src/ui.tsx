import { useEffect, type ReactNode } from 'react';
import { errorText } from './api';
import { Button, CoverageTrack, ItemId, LintNote, SimilarityHint, StatusBadge } from './ds/components';
import { itemHref } from './router';
import type { LintWarning, SimilarMatch } from './types';

export function shortDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

export function shortDateTime(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '';
}

/** Similarity score with two decimals, as the duplicate check reports it. */
export function score(similarity: number | null): string {
  return similarity === null ? '—' : similarity.toFixed(2);
}

/** Stroke shapes on a 16×16 grid: must double chevron up, should chevron up, could dash, wont slashed circle. */
const priorityIconShape: Record<string, ReactNode> = {
  must: <path d="M4 7.5L8 3.5L12 7.5M4 12.5L8 8.5L12 12.5" />,
  should: <path d="M4 10L8 6L12 10" />,
  could: <path d="M4 8H12" />,
  wont: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M4.1 4.1L11.9 11.9" />
    </>
  ),
};

function PriorityIcon({ priority }: { priority: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {priorityIconShape[priority] ?? priorityIconShape.wont}
    </svg>
  );
}

/**
 * Priority mark: a shape plus the stored word, in neutral inks only (ink, ink-muted, ink-faint), so the priority
 * never depends on hue and never borrows warn, danger or a green.
 */
export function PriorityBadge({ priority }: { priority: string }) {
  return (
    <span className="priority" data-priority={priority}>
      <PriorityIcon priority={priority} />
      {priority}
    </span>
  );
}

/**
 * Decorative edge whose weight and stroke follow the priority (must thick ink, should medium ink-muted, could thin
 * line-strong, wont dashed line-strong); `className` places it (card edge, legend swatch).
 */
export function PriorityAccent({ priority, className }: { priority: string; className: string }) {
  return <span aria-hidden="true" className={`priority-accent ${className}`} data-priority={priority} />;
}

/** How a list is ordered: server ID order, or priority order (see `sortByPriority`). */
export const ITEM_ORDERS = ['id', 'priority'] as const;
export type ItemOrder = (typeof ITEM_ORDERS)[number];

/**
 * Stable sort from the highest to the lowest priority, following `priorities` (project.enums.priorities:
 * must, should, could, wont); unknown values go last. Ties keep their input order, and `list_items` returns
 * items in ID order, so ties end up in ID order.
 */
export function sortByPriority<T>(items: readonly T[], priorityOf: (item: T) => string, priorities: readonly string[]): T[] {
  const rank = (p: string) => {
    const i = priorities.indexOf(p);
    return i === -1 ? priorities.length : i;
  };
  return [...items].sort((a, b) => rank(priorityOf(a)) - rank(priorityOf(b)));
}

/** The ID chip linking to the item page. */
export function ItemLink({ id, onClick }: { id: string; onClick?: () => void }) {
  return <ItemId id={id} href={itemHref(id)} onClick={onClick} />;
}

/** ID chip, status and title on one line, for lists of related items. */
export function RefRow({ id, status, title }: { id: string; status: string; title: string }) {
  return (
    <span className="ref-row">
      <ItemLink id={id} />
      <StatusBadge status={status} />
      <span className="ref-title" title={title}>
        {title}
      </span>
    </span>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <p className="quiet-note">{label}</p>;
}

export function ErrorBox({ error }: { error: unknown }) {
  return (
    <div role="alert" className="error-box">
      <span className="error-tag">error:</span> {errorText(error)}
    </div>
  );
}

export function WarningsList({ warnings }: { warnings: LintWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="stack-2">
      {warnings.map((w, i) => (
        <LintNote key={i} tag={w.severity === 'warn' ? 'WARN' : 'INFO'}>
          <code>{w.rule}</code> {w.message}
        </LintNote>
      ))}
    </div>
  );
}

const NEXT_STEP: Record<string, string> = {
  duplicate: 'Open it and update it instead, or create anyway.',
  related: 'Consider linking it instead of repeating it.',
  weak: 'Probably a different item.',
};

export function SimilarList({ matches, onNavigate }: { matches: SimilarMatch[]; onNavigate?: () => void }) {
  return (
    <div className="stack-2">
      {matches.map((m) => (
        <SimilarityHint
          key={m.id}
          verdict={m.match ?? 'weak'}
          score={m.similarity}
          id={m.id}
          href={itemHref(m.id)}
          title={m.title}
          onNavigate={onNavigate}
          note={
            <span className="row-2">
              <StatusBadge status={m.status} />
              {m.coverage && <CoverageTrack coverage={m.coverage} />}
              <span>{NEXT_STEP[m.match ?? 'weak']}</span>
            </span>
          }
        />
      ))}
    </div>
  );
}

/** Editor for a list of strings (acceptance criteria, steps, code refs). */
export function ListEditor({
  values,
  onChange,
  placeholder,
  multiline = false,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  const update = (index: number, value: string) => onChange(values.map((v, i) => (i === index ? value : v)));
  const remove = (index: number) => onChange(values.filter((_, i) => i !== index));
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= values.length) return;
    const next = [...values];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  return (
    <div className="stack-1">
      {values.map((value, i) => (
        <div key={i} className="list-row">
          <span className="list-index">{i + 1}.</span>
          {multiline ? (
            <textarea className="ov-input" rows={2} value={value} placeholder={placeholder} onChange={(e) => update(i, e.target.value)} />
          ) : (
            <input className="ov-input" value={value} placeholder={placeholder} onChange={(e) => update(i, e.target.value)} />
          )}
          <Button icon title="Move up" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
            ↑
          </Button>
          <Button icon title="Move down" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === values.length - 1}>
            ↓
          </Button>
          <Button icon title="Remove" aria-label="Remove" onClick={() => remove(i)}>
            ×
          </Button>
        </div>
      ))}
      <div>
        <Button onClick={() => onChange([...values, ''])}>Add</Button>
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="ov-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** A labelled group of controls that is not a single <label> (list editors, link rows). */
export function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field" role="group" aria-label={label}>
      <span className="ov-label">{label}</span>
      {children}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className="modal">
        <div className="modal-head">
          <h2 className="ov-h2">{title}</h2>
          <Button icon aria-label="Close" onClick={onClose}>
            ×
          </Button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** A panel with a heading: h3 for field groups on item pages, h2 for the Coverage view's sections. */
export function Section({
  title,
  children,
  actions,
  level = 3,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <section className="panel">
      <div className="panel-head">
        <Heading className={level === 2 ? 'ov-h2' : 'ov-h3'}>{title}</Heading>
        {actions}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

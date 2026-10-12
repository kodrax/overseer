import { useEffect, type ReactNode } from 'react';
import { errorText } from './api';
import { itemHref } from './router';
import type { CoverageState, Kind, LintWarning, SimilarMatch } from './types';

/** Control styling without a width; callers that need a fixed or auto width add it (w-full would win over it). */
export const inlineControlClass =
  'rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100';
export const inputClass = `w-full ${inlineControlClass}`;
export const selectClass = inputClass;
export const buttonClass =
  'inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700';
export const primaryButtonClass =
  'inline-flex items-center gap-1 rounded bg-sky-600 px-2.5 py-1 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50';
export const linkClass = 'text-sky-700 hover:underline dark:text-sky-400';

/** `non_functional` → `non functional`. */
export function humanize(value: string | null | undefined): string {
  return value ? value.replace(/_/g, ' ') : '';
}

export function shortDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

export function shortDateTime(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '';
}

export function percent(similarity: number | null): string {
  return similarity === null ? '—' : `${Math.round(similarity * 100)}%`;
}

function Badge({ className, children, title }: { className: string; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap ${className}`}
    >
      {children}
    </span>
  );
}

const kindClass: Record<Kind, string> = {
  requirement: 'bg-violet-100 text-violet-800 dark:bg-violet-900/60 dark:text-violet-200',
  epic: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/60 dark:text-fuchsia-200',
  story: 'bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200',
  task: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200',
  bug: 'bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-200',
};

export function KindBadge({ kind }: { kind: Kind }) {
  return <Badge className={kindClass[kind] ?? kindClass.task}>{kind}</Badge>;
}

const priorityClass: Record<string, string> = {
  must: 'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200',
  should: 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200',
  could: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200',
  wont: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
};

/**
 * Solid priority colours for the board card accent and the legend swatches. WCAG contrast against the card
 * background (white / dark:slate-800): must 4.76 / 3.84, should 3.19 / 6.83, could 3.67 / 5.95, wont 4.77 / 5.58.
 */
const priorityAccentClass: Record<string, string> = {
  must: 'bg-red-600 dark:bg-red-500',
  should: 'bg-amber-600 dark:bg-amber-500',
  could: 'bg-emerald-600 dark:bg-emerald-500',
  wont: 'bg-slate-500 dark:bg-slate-400',
};

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
      className="h-3 w-3 shrink-0"
    >
      {priorityIconShape[priority] ?? priorityIconShape.wont}
    </svg>
  );
}

/** Priority pill: icon plus name, so the priority never depends on colour alone. */
export function PriorityBadge({ priority }: { priority: string }) {
  return (
    <Badge className={`gap-1 ${priorityClass[priority] ?? priorityClass.wont!}`}>
      <PriorityIcon priority={priority} />
      {priority}
    </Badge>
  );
}

/** Decorative bar in the priority's accent colour; `className` sizes and positions it (card accent, legend swatch). */
export function PriorityAccent({ priority, className }: { priority: string; className: string }) {
  return <span aria-hidden="true" className={`${priorityAccentClass[priority] ?? priorityAccentClass.wont!} ${className}`} />;
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

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge className="bg-slate-100 text-slate-700 ring-1 ring-slate-300 ring-inset dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-600">
      {humanize(status)}
    </Badge>
  );
}

const coverageClass: Record<CoverageState, string> = {
  untracked: 'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200',
  tracked: 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200',
  in_progress: 'bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200',
  delivered: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200',
  verified: 'bg-green-200 text-green-900 dark:bg-green-800/70 dark:text-green-100',
  not_applicable: 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300',
};

export function CoverageBadge({ coverage }: { coverage: CoverageState | null | undefined }) {
  if (!coverage) return null;
  return <Badge className={coverageClass[coverage] ?? coverageClass.not_applicable}>{humanize(coverage)}</Badge>;
}

const matchClass: Record<string, string> = {
  duplicate: 'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200',
  related: 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200',
  weak: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
};

export function MatchBadge({ match }: { match: string | null }) {
  if (!match) return null;
  return <Badge className={matchClass[match] ?? matchClass.weak!}>{match}</Badge>;
}

export function ItemLink({ id, onClick }: { id: string; onClick?: () => void }) {
  return (
    <a href={itemHref(id)} onClick={onClick} className={`${linkClass} font-mono text-xs whitespace-nowrap`}>
      {id}
    </a>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="p-4 text-sm text-slate-500">{label}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  return (
    <div
      role="alert"
      className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-200"
    >
      {errorText(error)}
    </div>
  );
}

export function WarningsList({ warnings }: { warnings: LintWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="space-y-1 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      {warnings.map((w, i) => (
        <li key={i}>
          <span className="font-mono text-xs">
            [{w.severity}] {w.rule}
          </span>{' '}
          {w.message}
        </li>
      ))}
    </ul>
  );
}

export function SimilarList({ matches, onNavigate }: { matches: SimilarMatch[]; onNavigate?: () => void }) {
  return (
    <ul className="divide-y divide-slate-200 dark:divide-slate-700">
      {matches.map((m) => (
        <li key={m.id} className="flex items-center gap-2 py-1 text-sm">
          <ItemLink id={m.id} onClick={onNavigate} />
          <KindBadge kind={m.kind} />
          <span className="min-w-0 flex-1 truncate" title={m.title}>
            {m.title}
          </span>
          <StatusBadge status={m.status} />
          <CoverageBadge coverage={m.coverage} />
          <span className="w-10 text-right font-mono text-xs text-slate-500">{percent(m.similarity)}</span>
          <MatchBadge match={m.match} />
        </li>
      ))}
    </ul>
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
    <div className="space-y-1">
      {values.map((value, i) => (
        <div key={i} className="flex items-start gap-1">
          <span className="w-5 pt-1 text-right text-xs text-slate-400">{i + 1}.</span>
          {multiline ? (
            <textarea
              className={`${inputClass} min-h-[2.25rem]`}
              rows={2}
              value={value}
              placeholder={placeholder}
              onChange={(e) => update(i, e.target.value)}
            />
          ) : (
            <input className={inputClass} value={value} placeholder={placeholder} onChange={(e) => update(i, e.target.value)} />
          )}
          <button type="button" className={buttonClass} title="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
            ↑
          </button>
          <button
            type="button"
            className={buttonClass}
            title="Move down"
            onClick={() => move(i, 1)}
            disabled={i === values.length - 1}
          >
            ↓
          </button>
          <button type="button" className={buttonClass} title="Remove" onClick={() => remove(i)}>
            ×
          </button>
        </div>
      ))}
      <button type="button" className={buttonClass} onClick={() => onChange([...values, ''])}>
        + Add
      </button>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-400">{hint}</span>}
    </label>
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
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-12"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-3xl rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-800"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 dark:border-slate-700">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" className="text-xl leading-none text-slate-400 hover:text-slate-700" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-700">
        <h3 className="text-sm font-semibold">{title}</h3>
        {actions}
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

export const tableClass = 'w-full border-collapse text-sm';
export const thClass =
  'border-b border-slate-200 px-2 py-1.5 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-700 dark:text-slate-400';
export const tdClass = 'border-b border-slate-100 px-2 py-1.5 align-top dark:border-slate-700/60';

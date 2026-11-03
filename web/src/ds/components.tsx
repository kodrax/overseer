// React components for the overseer design system (design/system/components/<Name>/README.md). They render the
// `ov-` classes from bundle.css and base.css; import './ds.css' once at the app entry.
import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode, Ref } from 'react';

/** The ID chip. A link when `href` is given; `plain` drops the box for relation lines ("implements REQ-0001"). */
export function ItemId({
  id,
  href,
  plain = false,
  onClick,
}: {
  id: string;
  href?: string;
  plain?: boolean;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}) {
  const className = `ov-id${plain ? ' ov-id--plain' : id.startsWith('BUG-') ? ' ov-id--bug' : ''}`;
  return href ? (
    <a className={className} href={href} onClick={onClick}>
      {id}
    </a>
  ) : (
    <span className={className}>{id}</span>
  );
}

export type StatusStep = '0' | '25' | '50' | '75' | '100' | 'closed';

/** Fill step of the status dot, per the StatusBadge table (stories/tasks/bugs, epics, requirements). */
const STATUS_STEP: Record<string, StatusStep> = {
  backlog: '0',
  open: '0',
  proposed: '0',
  ready: '25',
  approved: '25',
  in_progress: '50',
  review: '75',
  implemented: '75',
  done: '100',
  verified: '100',
  cancelled: 'closed',
  deferred: 'closed',
  rejected: 'closed',
  obsolete: 'closed',
};

export function statusStep(status: string): StatusStep {
  return STATUS_STEP[status] ?? '0';
}

/** Progress dot plus the status value as stored (`in_progress`, never "In Progress"). */
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className="ov-status" data-p={statusStep(status)}>
      <span className="ov-dot" aria-hidden="true" />
      {status}
    </span>
  );
}

/** Filled segments per coverage value; `not_applicable` draws four dashed segments. */
const COVERAGE_FILLED: Record<string, number> = {
  untracked: 0,
  tracked: 1,
  in_progress: 2,
  delivered: 3,
  verified: 4,
  not_applicable: 0,
};

export function coverageFilled(coverage: string): number {
  return COVERAGE_FILLED[coverage] ?? 0;
}

/** Four segments plus the coverage word overseer computed. */
export function CoverageTrack({ coverage }: { coverage: string }) {
  const filled = coverageFilled(coverage);
  return (
    <span className="ov-cov" data-cov={coverage}>
      <span className="ov-cov-seg" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className={i < filled ? 'on' : undefined} />
        ))}
      </span>
      {coverage}
    </span>
  );
}

/** `primary` (one per view) or `quiet`; `icon` makes a 32px square for a single glyph (×, ↑, ↓). */
export function Button({
  variant = 'quiet',
  icon = false,
  kbd,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'quiet'; icon?: boolean; kbd?: string }) {
  return (
    <button
      type={type}
      className={`ov-btn ov-btn--${variant}${icon ? ' ov-btn--icon' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
      {kbd && <kbd>{kbd}</kbd>}
    </button>
  );
}

/** A kanban column: the status in uppercase label style with a count, then its cards. */
export function BoardColumn({
  title,
  count,
  over = false,
  footer,
  ref,
  children,
}: {
  title: string;
  count: number;
  over?: boolean;
  footer?: ReactNode;
  ref?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div ref={ref} className={`ov-col${over ? ' is-over' : ''}`}>
      <div className="ov-col-head">
        <h2>{title}</h2>
        <span>{count}</span>
      </div>
      {children}
      {footer && <p className="ov-col-foot">{footer}</p>}
    </div>
  );
}

/**
 * A card for one story, task or bug. At most one relation line (`implements REQ-…`, `affects REQ-…`) and up to
 * three tags; `aside` sits opposite the ID, `meta` leads the metadata line, `lead` is a decorative first child.
 */
export function BoardCard({
  id,
  href,
  title,
  relation,
  tags = [],
  aside,
  meta,
  lead,
  dragging = false,
  onIdClick,
}: {
  id: string;
  href?: string;
  title: string;
  relation?: { rel: string; ids: string[] };
  tags?: string[];
  aside?: ReactNode;
  meta?: ReactNode;
  lead?: ReactNode;
  dragging?: boolean;
  onIdClick?: MouseEventHandler<HTMLAnchorElement>;
}) {
  const parts: ReactNode[] = [];
  if (meta) parts.push(meta);
  if (relation && relation.ids.length > 0)
    parts.push(
      <span key="rel" className="ov-card-rel">
        <span>{relation.rel}</span>
        {relation.ids.map((rid) => (
          <span key={rid} className="ov-rel">
            {rid}
          </span>
        ))}
      </span>,
    );
  for (const tag of tags.slice(0, 3))
    parts.push(
      <span key={`#${tag}`} className="ov-tag">
        {tag}
      </span>,
    );
  return (
    <article className={`ov-card${dragging ? ' is-dragging' : ''}`}>
      {lead}
      <div className="ov-card-top">
        <ItemId id={id} href={href} onClick={onIdClick} />
        {aside}
      </div>
      <p className="ov-card-title" title={title}>
        {title}
      </p>
      {parts.length > 0 && (
        <div className="ov-card-meta">
          {parts.flatMap((part, i) => (i === 0 ? [part] : [<span key={`sep${i}`} aria-hidden="true">·</span>, part]))}
        </div>
      )}
    </article>
  );
}

/** A lint or drift warning: short uppercase tag, the problem, then the fix. Never blocks a write. */
export function LintNote({ tag = 'WARN', children, fix }: { tag?: string; children: ReactNode; fix?: ReactNode }) {
  return (
    <div className="ov-lint" role="note">
      <span className="ov-lint-tag">{tag}</span>
      <span>{children}</span>
      {fix && <span className="ov-lint-fix">{fix}</span>}
    </div>
  );
}

/** One row of the duplicate check: verdict, score with two decimals, the matched item and the next step. */
export function SimilarityHint({
  verdict,
  score,
  id,
  href,
  title,
  note,
  onNavigate,
}: {
  verdict: string;
  score: number | null;
  id?: string;
  href?: string;
  title?: string;
  note?: ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <div className="ov-sim" data-verdict={verdict}>
      <span className="ov-sim-verdict">{verdict}</span>
      <span className="ov-sim-score">{score === null ? '—' : score.toFixed(2)}</span>
      <span className="ov-sim-body">
        {id && <ItemId id={id} href={href} onClick={onNavigate} />}
        {title && <span title={title}>{title}</span>}
      </span>
      {note && <span className="ov-sim-note">{note}</span>}
    </div>
  );
}

/** Rendered CLI output. Use `Prompt` for `$ ` and the spans ok, warn, fail, dim, id only where the CLI colors. */
export function Terminal({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre className="ov-term" aria-label={label}>
      {children}
    </pre>
  );
}

export function Prompt() {
  return <span className="p">$ </span>;
}

/**
 * The symbol: an ink ring with a signal half-disc, the board's status dot at the halfway mark. From 16 to 24 px
 * it uses the small cut (heavier ring); never recolor, outline or redraw it (design/brand/Misuse.dc.html).
 */
export function LogoSymbol({ size }: { size: number }) {
  const small = size <= 24;
  return (
    <svg className="ov-symbol" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ top: Math.round(size / 8) }}>
      <circle className="ov-symbol-ring" cx="12" cy="12" r={small ? 9.75 : 10} strokeWidth={small ? 2.5 : 2} />
      <path className="ov-symbol-fill" d={small ? 'M12 6A6 6 0 0 1 12 18Z' : 'M12 5.5A6.5 6.5 0 0 1 12 18.5Z'} />
    </svg>
  );
}

/** The lockup: symbol at the wordmark size, gap 0.36×, then "overseer" in Plex Mono 600. Scale it as one piece. */
export function Logo({ size = 18 }: { size?: number }) {
  return (
    <span className="ov-lockup" style={{ gap: Math.round(size * 0.36) }}>
      <LogoSymbol size={size} />
      <span className="ov-wordmark" style={{ fontSize: size }}>
        overseer
      </span>
    </span>
  );
}

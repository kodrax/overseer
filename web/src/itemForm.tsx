import type { Enums, Item, ItemFields, Kind, Priority, ReqType } from './types';
import { Field, humanize, inputClass, ListEditor, selectClass } from './ui';

/** Form state for item fields; text inputs hold strings, normalized by `draftToFields`. */
export interface Draft {
  title: string;
  description: string;
  status: string;
  priority: string;
  req_type: string;
  nfr_category: string;
  rationale: string;
  acceptance_criteria: string[];
  fit_criterion: string;
  verification_method: string;
  asked_by: string;
  source: string;
  in_backlog: boolean;
  parent_id: string;
  assignee: string;
  estimate: string;
  milestone: string;
  severity: string;
  steps: string[];
  expected: string;
  actual: string;
  environment: string;
  component: string;
  tags: string;
  code_refs: string[];
  delivered_in: string;
}

const WORK_KINDS: Kind[] = ['epic', 'story', 'task', 'bug'];
const ESTIMATE_KINDS: Kind[] = ['story', 'task', 'bug'];

export function emptyDraft(kind: Kind, enums: Enums): Draft {
  return {
    title: '',
    description: '',
    status: enums.statuses[kind]?.[0] ?? '',
    priority: 'should',
    req_type: kind === 'requirement' ? 'functional' : '',
    nfr_category: '',
    rationale: '',
    acceptance_criteria: [],
    fit_criterion: '',
    verification_method: '',
    asked_by: '',
    source: '',
    in_backlog: false,
    parent_id: '',
    assignee: '',
    estimate: '',
    milestone: '',
    severity: '',
    steps: [],
    expected: '',
    actual: '',
    environment: '',
    component: '',
    tags: '',
    code_refs: [],
    delivered_in: '',
  };
}

export function draftFromItem(item: Item): Draft {
  return {
    title: item.title,
    description: item.description,
    status: item.status,
    priority: item.priority,
    req_type: item.req_type ?? '',
    nfr_category: item.nfr_category ?? '',
    rationale: item.rationale ?? '',
    acceptance_criteria: [...item.acceptance_criteria],
    fit_criterion: item.fit_criterion ?? '',
    verification_method: item.verification_method ?? '',
    asked_by: item.asked_by ?? '',
    source: item.source ?? '',
    in_backlog: item.in_backlog,
    parent_id: item.parent_id ?? '',
    assignee: item.assignee ?? '',
    estimate: item.estimate === null ? '' : String(item.estimate),
    milestone: item.milestone ?? '',
    severity: item.severity ?? '',
    steps: [...(item.bug_details?.steps ?? [])],
    expected: item.bug_details?.expected ?? '',
    actual: item.bug_details?.actual ?? '',
    environment: item.bug_details?.environment ?? '',
    component: item.component ?? '',
    tags: item.tags.join(', '),
    code_refs: [...item.code_refs],
    delivered_in: item.delivered_in ?? '',
  };
}

/** Returns a user-facing problem with the draft, or null when it can be submitted. */
export function validateDraft(draft: Draft, kind: Kind): string | null {
  if (!draft.title.trim()) return 'Title is required.';
  if (kind === 'requirement' && !draft.req_type) return 'Type (functional / non-functional) is required for requirements.';
  if (ESTIMATE_KINDS.includes(kind) && draft.estimate.trim() && !Number.isFinite(Number(draft.estimate.trim())))
    return 'Estimate must be a number.';
  return null;
}

/** Normalizes the draft into wire fields applicable to `kind` (empty text → null). */
export function draftToFields(draft: Draft, kind: Kind): ItemFields {
  const text = (value: string): string | null => value.trim() || null;
  const list = (values: string[]): string[] => values.map((v) => v.trim()).filter(Boolean);
  const fields: ItemFields = {
    title: draft.title.trim(),
    description: draft.description.trim(),
    status: draft.status,
    priority: draft.priority as Priority,
    acceptance_criteria: list(draft.acceptance_criteria),
    asked_by: text(draft.asked_by),
    source: text(draft.source),
    component: text(draft.component),
    tags: list(draft.tags.split(',')),
    code_refs: list(draft.code_refs),
    delivered_in: text(draft.delivered_in),
  };
  if (kind !== 'epic') fields.parent_id = text(draft.parent_id);
  if (kind === 'requirement') {
    fields.req_type = (draft.req_type || null) as ReqType | null;
    fields.nfr_category = text(draft.nfr_category);
    fields.fit_criterion = text(draft.fit_criterion);
    fields.verification_method = text(draft.verification_method);
    fields.rationale = text(draft.rationale);
    fields.in_backlog = draft.in_backlog;
  }
  if (WORK_KINDS.includes(kind)) {
    fields.assignee = text(draft.assignee);
    fields.milestone = text(draft.milestone);
  }
  if (ESTIMATE_KINDS.includes(kind)) fields.estimate = draft.estimate.trim() ? Number(draft.estimate.trim()) : null;
  if (kind === 'bug') {
    fields.severity = text(draft.severity);
    const steps = list(draft.steps);
    const expected = draft.expected.trim();
    const actual = draft.actual.trim();
    const environment = draft.environment.trim();
    fields.bug_details =
      steps.length || expected || actual || environment
        ? { steps, expected, actual, ...(environment ? { environment } : {}) }
        : null;
  }
  return fields;
}

/** Only the fields whose normalized value differs from the stored item. */
export function changedFields(item: Item, draft: Draft): ItemFields {
  const before = draftToFields(draftFromItem(item), item.kind) as Record<string, unknown>;
  const after = draftToFields(draft, item.kind) as Record<string, unknown>;
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(value) !== JSON.stringify(before[key])) changed[key] = value;
  }
  return changed as ItemFields;
}

const PARENT_HINT: Record<Kind, string> = {
  requirement: 'Parent requirement (decomposition), e.g. REQ-0001',
  epic: '',
  story: 'Epic ID, e.g. EPIC-0001',
  task: 'Story ID, e.g. US-0001',
  bug: 'Epic or story ID (optional)',
};

function EnumSelect({
  value,
  onChange,
  options,
  allowEmpty,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  allowEmpty?: boolean;
  label: string;
}) {
  return (
    <select className={selectClass} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {allowEmpty && <option value="">—</option>}
      {options.map((o) => (
        <option key={o} value={o}>
          {humanize(o)}
        </option>
      ))}
    </select>
  );
}

/** Kind-aware editor for item fields, shared by the detail page and the "New item" dialog. */
export function ItemFieldsEditor({
  kind,
  draft,
  onChange,
  enums,
}: {
  kind: Kind;
  draft: Draft;
  onChange: (draft: Draft) => void;
  enums: Enums;
}) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => onChange({ ...draft, [key]: value });
  const textInput = (key: keyof Draft & string, placeholder?: string) => (
    <input
      className={inputClass}
      value={draft[key] as string}
      placeholder={placeholder}
      onChange={(e) => set(key, e.target.value as never)}
    />
  );
  const isRequirement = kind === 'requirement';
  const isWork = WORK_KINDS.includes(kind);

  return (
    <div className="space-y-3">
      <Field label="Title" hint={draft.title.length > 100 ? `${draft.title.length} characters; keep titles under 100` : undefined}>
        <input className={inputClass} value={draft.title} onChange={(e) => set('title', e.target.value)} required />
      </Field>
      <Field label="Description">
        <textarea
          className={`${inputClass} min-h-24`}
          rows={4}
          value={draft.description}
          placeholder={
            isRequirement
              ? 'When <trigger>, the <system> shall <response>.'
              : kind === 'story'
                ? 'As a <role> I want <capability> so that <benefit>.'
                : ''
          }
          onChange={(e) => set('description', e.target.value)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Status">
          <EnumSelect label="Status" value={draft.status} onChange={(v) => set('status', v)} options={enums.statuses[kind] ?? []} />
        </Field>
        <Field label="Priority">
          <EnumSelect label="Priority" value={draft.priority} onChange={(v) => set('priority', v)} options={enums.priorities} />
        </Field>
        {isRequirement && (
          <>
            <Field label="Type">
              <EnumSelect label="Type" value={draft.req_type} onChange={(v) => set('req_type', v)} options={enums.req_types} />
            </Field>
            <Field label="NFR category">
              <EnumSelect
                label="NFR category"
                value={draft.nfr_category}
                onChange={(v) => set('nfr_category', v)}
                options={enums.nfr_categories}
                allowEmpty
              />
            </Field>
            <Field label="Verification">
              <EnumSelect
                label="Verification"
                value={draft.verification_method}
                onChange={(v) => set('verification_method', v)}
                options={enums.verification_methods}
                allowEmpty
              />
            </Field>
          </>
        )}
        {kind === 'bug' && (
          <Field label="Severity">
            <EnumSelect
              label="Severity"
              value={draft.severity}
              onChange={(v) => set('severity', v)}
              options={enums.severities}
              allowEmpty
            />
          </Field>
        )}
        {kind !== 'epic' && <Field label="Parent">{textInput('parent_id', PARENT_HINT[kind])}</Field>}
        {isWork && <Field label="Assignee">{textInput('assignee')}</Field>}
        {ESTIMATE_KINDS.includes(kind) && <Field label="Estimate (points)">{textInput('estimate')}</Field>}
        {isWork && <Field label="Milestone">{textInput('milestone', 'Sprint or release')}</Field>}
        <Field label="Component">{textInput('component')}</Field>
        <Field label="Asked by">{textInput('asked_by')}</Field>
        <Field label="Delivered in">{textInput('delivered_in', 'Release, PR or commit')}</Field>
        {isRequirement && (
          <label className="flex items-center gap-2 self-end pb-1 text-sm">
            <input type="checkbox" checked={draft.in_backlog} onChange={(e) => set('in_backlog', e.target.checked)} />
            In backlog
          </label>
        )}
      </div>

      {isRequirement && (
        <>
          <Field label="Fit criterion" hint="Measurable target, e.g. p95 < 300 ms at 100 rps">
            {textInput('fit_criterion')}
          </Field>
          <Field label="Rationale">
            <textarea className={inputClass} rows={2} value={draft.rationale} onChange={(e) => set('rationale', e.target.value)} />
          </Field>
        </>
      )}

      <div className="space-y-1">
        <span className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">Acceptance criteria</span>
        <ListEditor
          values={draft.acceptance_criteria}
          onChange={(v) => set('acceptance_criteria', v)}
          placeholder="Given … when … then …"
          multiline
        />
      </div>

      {kind === 'bug' && (
        <div className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-700">
          <div className="space-y-1">
            <span className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">Steps to reproduce</span>
            <ListEditor values={draft.steps} onChange={(v) => set('steps', v)} placeholder="Step" />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Expected">
              <textarea className={inputClass} rows={2} value={draft.expected} onChange={(e) => set('expected', e.target.value)} />
            </Field>
            <Field label="Actual">
              <textarea className={inputClass} rows={2} value={draft.actual} onChange={(e) => set('actual', e.target.value)} />
            </Field>
          </div>
          <Field label="Environment">{textInput('environment', 'Browser, OS, version…')}</Field>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Tags" hint="Comma-separated">
          {textInput('tags')}
        </Field>
        <Field label="Source" hint="Conversation, file path, meeting or URL">
          {textInput('source')}
        </Field>
      </div>
      <div className="space-y-1">
        <span className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">Code references</span>
        <ListEditor values={draft.code_refs} onChange={(v) => set('code_refs', v)} placeholder="path/to/file.ts:42" />
      </div>
    </div>
  );
}

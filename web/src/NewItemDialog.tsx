import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from './api';
import { queryKeys, useDebounced } from './hooks';
import { draftToFields, emptyDraft, ItemFieldsEditor, validateDraft, type Draft } from './itemForm';
import { navigate } from './router';
import { useToast } from './toast';
import { buttonClass, ErrorBox, Field, humanize, inlineControlClass, Modal, primaryButtonClass, SimilarList } from './ui';
import type { CreateItemInput, CreateItemResult, Kind, ProjectInfo, Relation, SimilarMatch } from './types';

interface LinkDraft {
  rel: Relation;
  to: string;
}

const DEFAULT_REL: Record<Kind, Relation> = {
  requirement: 'refines',
  epic: 'relates_to',
  story: 'implements',
  task: 'implements',
  bug: 'affects',
};

export function NewItemDialog({
  project,
  initialKind,
  onClose,
}: {
  project: ProjectInfo;
  initialKind: Kind;
  onClose: () => void;
}) {
  const { enums } = project;
  const queryClient = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<Kind>(initialKind);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(initialKind, enums));
  const [links, setLinks] = useState<LinkDraft[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<SimilarMatch[] | null>(null);

  const similarText = useDebounced(`${draft.title.trim()}\n${draft.description.trim()}`.trim(), 400);
  const similar = useQuery({
    queryKey: queryKeys.similar(similarText, kind),
    queryFn: () => api.similar(similarText, kind),
    enabled: similarText.length >= 3,
    staleTime: 10_000,
  });
  const hints = (similar.data?.matches ?? []).filter((m) => m.match !== 'weak');

  const create = useMutation({
    mutationFn: (input: CreateItemInput) => api.createItem(input),
    onSuccess: (res: CreateItemResult) => {
      if (!res.created) {
        setDuplicates(res.candidates);
        return;
      }
      void queryClient.invalidateQueries();
      toast.push(
        res.warnings.length ? 'info' : 'success',
        `Created ${res.item.id}${res.warnings.length ? ' with lint warnings' : ''}`,
        res.warnings.map((w) => `${w.rule}: ${w.message}`),
      );
      onClose();
      navigate({ name: 'item', id: res.item.id });
    },
  });

  const changeKind = (next: Kind) => {
    setKind(next);
    setDuplicates(null);
    // Keep the shared text fields; reset kind-specific defaults (status, req_type).
    const fresh = emptyDraft(next, enums);
    setDraft({ ...draft, status: fresh.status, req_type: fresh.req_type });
    setLinks((current) => current.map((l) => ({ ...l, rel: DEFAULT_REL[next] })));
  };

  const submit = (allowDuplicate: boolean) => {
    const invalid = validateDraft(draft, kind);
    setProblem(invalid);
    if (invalid) return;
    // Omit empty values so the server applies its defaults (e.g. asked_by = project default).
    const fields = Object.fromEntries(
      Object.entries(draftToFields(draft, kind)).filter(
        ([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0),
      ),
    );
    const input: CreateItemInput = {
      ...fields,
      kind,
      title: draft.title.trim(),
      links: links.filter((l) => l.to.trim()).map((l) => ({ rel: l.rel, to: l.to.trim().toUpperCase() })),
      ...(allowDuplicate ? { allow_duplicate: true } : {}),
    };
    create.mutate(input);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(false);
  };

  return (
    <Modal title="New item" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Kind">
          <select className={`${inlineControlClass} w-48`} value={kind} onChange={(e) => changeKind(e.target.value as Kind)}>
            {enums.kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Field>

        <ItemFieldsEditor
          kind={kind}
          draft={draft}
          onChange={(next) => {
            setDraft(next);
            setDuplicates(null);
          }}
          enums={enums}
        />

        <div className="space-y-1">
          <span className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">Links</span>
          {links.map((link, i) => (
            <div key={i} className="flex gap-1">
              <select
                className={`${inlineControlClass} w-44`}
                value={link.rel}
                aria-label="Relation"
                onChange={(e) => setLinks(links.map((l, j) => (j === i ? { ...l, rel: e.target.value as Relation } : l)))}
              >
                {enums.relations.map((r) => (
                  <option key={r} value={r}>
                    {humanize(r)}
                  </option>
                ))}
              </select>
              <input
                className={`${inlineControlClass} w-44 font-mono`}
                placeholder="REQ-0001"
                aria-label="Target ID"
                value={link.to}
                onChange={(e) => setLinks(links.map((l, j) => (j === i ? { ...l, to: e.target.value } : l)))}
              />
              <button type="button" className={buttonClass} onClick={() => setLinks(links.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <button type="button" className={buttonClass} onClick={() => setLinks([...links, { rel: DEFAULT_REL[kind], to: '' }])}>
            + Add link
          </button>
        </div>

        {duplicates ? (
          <div className="space-y-2 rounded-md border border-rose-300 bg-rose-50 p-3 dark:border-rose-700 dark:bg-rose-950/50">
            <p className="text-sm font-medium text-rose-800 dark:text-rose-200">
              Possible duplicate: nothing was created. Review the candidates, update an existing item, or create anyway.
            </p>
            <SimilarList matches={duplicates} onNavigate={onClose} />
          </div>
        ) : (
          hints.length > 0 && (
            <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40">
              <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
                Similar existing items{similar.data && !similar.data.semantic ? ' (keyword match)' : ''}
              </p>
              <SimilarList matches={hints} onNavigate={onClose} />
            </div>
          )
        )}

        {problem && <ErrorBox error={new Error(problem)} />}
        {create.isError && <ErrorBox error={create.error} />}

        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass} onClick={onClose}>
            Cancel
          </button>
          {duplicates && (
            <button type="button" className={buttonClass} disabled={create.isPending} onClick={() => submit(true)}>
              Create anyway
            </button>
          )}
          <button type="submit" className={primaryButtonClass} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : `Create ${kind}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

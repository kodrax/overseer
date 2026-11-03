import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from './api';
import { Button } from './ds/components';
import { queryKeys, useDebounced } from './hooks';
import { draftToFields, emptyDraft, ItemFieldsEditor, validateDraft, type Draft } from './itemForm';
import { navigate } from './router';
import { useToast } from './toast';
import { ErrorBox, Field, FieldGroup, Modal, SimilarList } from './ui';
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
      <form onSubmit={onSubmit} className="stack-4">
        <Field label="Kind">
          <select className="ov-input kind-select" value={kind} onChange={(e) => changeKind(e.target.value as Kind)}>
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

        <FieldGroup label="Links">
          {links.map((link, i) => (
            <div key={i} className="link-row">
              <select
                className="ov-input"
                value={link.rel}
                aria-label="Relation"
                onChange={(e) => setLinks(links.map((l, j) => (j === i ? { ...l, rel: e.target.value as Relation } : l)))}
              >
                {enums.relations.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <input
                className="ov-input ov-input--mono"
                placeholder="REQ-0001"
                aria-label="Target ID"
                value={link.to}
                onChange={(e) => setLinks(links.map((l, j) => (j === i ? { ...l, to: e.target.value } : l)))}
              />
              <Button icon aria-label="Remove link" title="Remove link" onClick={() => setLinks(links.filter((_, j) => j !== i))}>
                ×
              </Button>
            </div>
          ))}
          <div>
            <Button onClick={() => setLinks([...links, { rel: DEFAULT_REL[kind], to: '' }])}>Add link</Button>
          </div>
        </FieldGroup>

        {duplicates ? (
          <div className="duplicate-box">
            <p>Possible duplicate: nothing was created. Open a match to update it, or create anyway.</p>
            <SimilarList matches={duplicates} onNavigate={onClose} />
          </div>
        ) : (
          hints.length > 0 && (
            <div className="stack-2">
              <p className="ov-label">
                Similar existing items{similar.data && !similar.data.semantic ? ' · keyword match only' : ''}
              </p>
              <SimilarList matches={hints} onNavigate={onClose} />
            </div>
          )
        )}

        {problem && <ErrorBox error={new Error(problem)} />}
        {create.isError && <ErrorBox error={create.error} />}

        <div className="row-end">
          <Button onClick={onClose}>Cancel</Button>
          {duplicates && (
            <Button disabled={create.isPending} onClick={() => submit(true)}>
              Create anyway
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : `Create ${kind}`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

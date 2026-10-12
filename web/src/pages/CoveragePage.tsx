import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { queryKeys, useProject } from '../hooks';
import { CoverageBadge, ErrorBox, humanize, ItemLink, KindBadge, Loading, Section, StatusBadge, tableClass, tdClass, thClass } from '../ui';
import type { CoverageState, ItemRef } from '../types';

function RefList({ refs }: { refs: ItemRef[] }) {
  if (refs.length === 0) return <span className="text-slate-400">—</span>;
  return (
    <ul className="space-y-0.5">
      {refs.map((r) => (
        <li key={r.id} className="flex items-center gap-1.5">
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

export function CoveragePage() {
  const project = useProject();
  const summary = useQuery({ queryKey: queryKeys.report('summary'), queryFn: () => api.report('summary') });
  const drift = useQuery({ queryKey: queryKeys.report('drift'), queryFn: () => api.report('drift') });
  const trace = useQuery({ queryKey: queryKeys.report('traceability'), queryFn: () => api.report('traceability') });

  const states: CoverageState[] = project.data?.enums.coverage_states ?? [];
  const counts = summary.data?.data.coverage ?? {};

  return (
    <div className="space-y-4">
      <Section title="Requirement coverage">
        {summary.isPending ? (
          <Loading />
        ) : summary.isError ? (
          <ErrorBox error={summary.error} />
        ) : (
          <div className="flex flex-wrap gap-3">
            {states.map((state) => (
              <div
                key={state}
                className="min-w-28 rounded-md border border-slate-200 px-3 py-2 dark:border-slate-700"
              >
                <div className="text-2xl font-semibold tabular-nums">{counts[state] ?? 0}</div>
                <CoverageBadge coverage={state} />
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title={`Drift${drift.data ? ` (${drift.data.data.drift.length})` : ''}`}>
        {drift.isPending ? (
          <Loading />
        ) : drift.isError ? (
          <ErrorBox error={drift.error} />
        ) : drift.data.data.drift.length === 0 ? (
          <p className="text-sm text-slate-500">No drift between requirement statuses and work items.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Requirement</th>
                  <th className={thClass}>Title</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Coverage</th>
                  <th className={thClass}>Rule</th>
                  <th className={thClass}>Message</th>
                  <th className={thClass}>Work</th>
                </tr>
              </thead>
              <tbody>
                {drift.data.data.drift.map((d) => (
                  <tr key={`${d.id}:${d.rule}`}>
                    <td className={tdClass}>
                      <ItemLink id={d.id} />
                    </td>
                    <td className={tdClass}>{d.title}</td>
                    <td className={tdClass}>
                      <StatusBadge status={d.status} />
                    </td>
                    <td className={tdClass}>
                      <CoverageBadge coverage={d.coverage} />
                    </td>
                    <td className={`${tdClass} font-mono text-xs`}>{d.rule}</td>
                    <td className={tdClass}>{d.message}</td>
                    <td className={tdClass}>
                      <RefList refs={d.work} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Traceability">
        {trace.isPending ? (
          <Loading />
        ) : trace.isError ? (
          <ErrorBox error={trace.error} />
        ) : trace.data.data.requirements.length === 0 ? (
          <p className="text-sm text-slate-500">No requirements.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Requirement</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Coverage</th>
                  <th className={thClass}>Implemented by</th>
                  <th className={thClass}>Affected by bugs</th>
                </tr>
              </thead>
              <tbody>
                {trace.data.data.requirements.map((r) => (
                  <tr key={r.id}>
                    <td className={`${tdClass} min-w-56`}>
                      <ItemLink id={r.id} /> <span>{r.title}</span>
                    </td>
                    <td className={tdClass}>
                      <StatusBadge status={r.status} />
                    </td>
                    <td className={tdClass}>
                      <CoverageBadge coverage={r.coverage} />
                    </td>
                    <td className={tdClass}>
                      {r.implemented_by.length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <ul className="space-y-1">
                          {r.implemented_by.map((w) => (
                            <li key={w.id}>
                              <RefList refs={[w]} />
                              {w.children.length > 0 && (
                                <div className="mt-0.5 ml-5 border-l border-slate-200 pl-2 dark:border-slate-700">
                                  <RefList refs={w.children} />
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className={tdClass}>
                      {r.affected_by.length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {r.affected_by.map((b) => (
                            <li key={b.id} className="flex items-center gap-1.5">
                              <ItemLink id={b.id} />
                              <StatusBadge status={b.status} />
                              {b.severity && <span className="text-xs text-rose-600 dark:text-rose-400">{humanize(b.severity)}</span>}
                              <span className="truncate" title={b.title}>
                                {b.title}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

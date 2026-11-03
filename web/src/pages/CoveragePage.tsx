import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { CoverageTrack, LintNote, StatusBadge } from '../ds/components';
import { queryKeys, useProject } from '../hooks';
import { ErrorBox, ItemLink, Loading, RefRow, Section } from '../ui';
import type { CoverageState, ItemRef } from '../types';

function RefList({ refs }: { refs: ItemRef[] }) {
  if (refs.length === 0) return <span className="dash">—</span>;
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

export function CoveragePage() {
  const project = useProject();
  const summary = useQuery({ queryKey: queryKeys.report('summary'), queryFn: () => api.report('summary') });
  const drift = useQuery({ queryKey: queryKeys.report('drift'), queryFn: () => api.report('drift') });
  const trace = useQuery({ queryKey: queryKeys.report('traceability'), queryFn: () => api.report('traceability') });

  const states: CoverageState[] = project.data?.enums.coverage_states ?? [];
  const counts = summary.data?.data.coverage ?? {};

  return (
    <div className="stack-4">
      <h1 className="ov-h1">Coverage</h1>
      <Section level={2} title="Requirement coverage">
        {summary.isPending ? (
          <Loading />
        ) : summary.isError ? (
          <ErrorBox error={summary.error} />
        ) : (
          <div className="coverage-counts">
            {states.map((state) => (
              <div key={state} className="coverage-count">
                <span className="coverage-number">{counts[state] ?? 0}</span>
                <CoverageTrack coverage={state} />
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section level={2} title={`Drift${drift.data ? ` (${drift.data.data.drift.length})` : ''}`}>
        {drift.isPending ? (
          <Loading />
        ) : drift.isError ? (
          <ErrorBox error={drift.error} />
        ) : drift.data.data.drift.length === 0 ? (
          <p className="quiet-note">No drift between requirement statuses and work items.</p>
        ) : (
          <div className="table-panel">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Requirement</th>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Coverage</th>
                  <th>Drift</th>
                  <th>Work</th>
                </tr>
              </thead>
              <tbody>
                {drift.data.data.drift.map((d) => (
                  <tr key={`${d.id}:${d.rule}`}>
                    <td>
                      <ItemLink id={d.id} />
                    </td>
                    <td>{d.title}</td>
                    <td>
                      <StatusBadge status={d.status} />
                    </td>
                    <td>
                      <CoverageTrack coverage={d.coverage} />
                    </td>
                    <td>
                      <LintNote tag="DRIFT">
                        <code>{d.rule}</code> {d.message}
                      </LintNote>
                    </td>
                    <td>
                      <RefList refs={d.work} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section level={2} title="Traceability">
        {trace.isPending ? (
          <Loading />
        ) : trace.isError ? (
          <ErrorBox error={trace.error} />
        ) : trace.data.data.requirements.length === 0 ? (
          <p className="quiet-note">No requirements.</p>
        ) : (
          <div className="table-panel">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Requirement</th>
                  <th>Status</th>
                  <th>Coverage</th>
                  <th>Implemented by</th>
                  <th>Affected by bugs</th>
                </tr>
              </thead>
              <tbody>
                {trace.data.data.requirements.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="id-title">
                        <ItemLink id={r.id} />
                        <span>{r.title}</span>
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td>
                      <CoverageTrack coverage={r.coverage} />
                    </td>
                    <td>
                      {r.implemented_by.length === 0 ? (
                        <span className="dash">—</span>
                      ) : (
                        <ul className="stack-1">
                          {r.implemented_by.map((w) => (
                            <li key={w.id}>
                              <RefRow id={w.id} status={w.status} title={w.title} />
                              {w.children.length > 0 && (
                                <div className="ref-children">
                                  <RefList refs={w.children} />
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td>
                      {r.affected_by.length === 0 ? (
                        <span className="dash">—</span>
                      ) : (
                        <ul className="stack-1">
                          {r.affected_by.map((b) => (
                            <li key={b.id} className="ref-row">
                              <ItemLink id={b.id} />
                              <StatusBadge status={b.status} />
                              {b.severity && <span className="severity">{b.severity}</span>}
                              <span className="ref-title" title={b.title}>
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

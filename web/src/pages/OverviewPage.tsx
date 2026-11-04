import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { queryKeys } from '../hooks';
import { GROUP_LABEL, groupForOverview, KIND_WORD, OVERVIEW_GROUPS, type OverviewGroup } from '../overview';
import { itemHref } from '../router';
import { ErrorBox, Loading } from '../ui';
import type { ListItemsQuery, ProjectInfo } from '../types';
import './OverviewPage.css';

// Same query as the board, so both pages share one cached list and refresh together on live updates.
const OVERVIEW_QUERY: ListItemsQuery = { limit: 5000 };

const EMPTY: Record<OverviewGroup, string> = {
  planned: 'Nothing is planned.',
  in_progress: 'Nothing is in progress.',
  done: 'Nothing is done yet.',
};

/** Every open item in plain words, for reviewing the project with someone who does not use the board. */
export function OverviewPage({ project }: { project: ProjectInfo }) {
  const items = useQuery({ queryKey: queryKeys.items(OVERVIEW_QUERY), queryFn: () => api.listItems(OVERVIEW_QUERY) });

  if (items.isPending) return <Loading />;
  if (items.isError) return <ErrorBox error={items.error} />;

  const kinds = project.enums.kinds;
  const byKind = [...items.data.items].sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
  const groups = groupForOverview(byKind);

  return (
    <div>
      <div className="page-head">
        <h1 className="ov-h1">Overview</h1>
        <p className="ov-body-sm ov-muted">Every open item in plain words: what is planned, what is in progress and what is done.</p>
      </div>
      <div className="ov-overview-groups">
        {OVERVIEW_GROUPS.map((group) => {
          const headingId = `overview-${group}`;
          return (
            <section key={group} className="ov-overview-group" aria-labelledby={headingId}>
              <h2 id={headingId} className="ov-h2">
                {GROUP_LABEL[group]} <span className="ov-overview-count">{groups[group].length}</span>
              </h2>
              {groups[group].length === 0 ? (
                <p className="ov-body-sm ov-muted">{EMPTY[group]}</p>
              ) : (
                <ul>
                  {groups[group].map(({ item, word }) => (
                    <li key={item.id}>
                      <a href={itemHref(item.id)} className="ov-overview-title">
                        {item.title}
                      </a>
                      <span className="ov-body-sm ov-muted">
                        {KIND_WORD[item.kind]} · {word}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

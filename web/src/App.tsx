import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorText } from './api';
import { Button, Logo } from './ds/components';
import { ThemeSwitch } from './ds/theme';
import { useProject } from './hooks';
import { NewItemDialog } from './NewItemDialog';
import { BoardPage } from './pages/BoardPage';
import { CoveragePage } from './pages/CoveragePage';
import { ItemPage } from './pages/ItemPage';
import { OverviewPage } from './pages/OverviewPage';
import { RequirementsPage } from './pages/RequirementsPage';
import { hrefFor, useRoute, type Route } from './router';
import { useToast } from './toast';
import { ErrorBox, Loading } from './ui';
import type { Kind } from './types';

/** One EventSource for the whole app: every `changed` event invalidates all cached queries. */
function useLiveUpdates(): boolean {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const source = new EventSource('/api/events');
    let lostConnection = false;
    source.onopen = () => {
      setConnected(true);
      // Changes committed while disconnected produced no event: refresh everything once.
      if (lostConnection) void queryClient.invalidateQueries();
      lostConnection = false;
    };
    source.onerror = () => {
      setConnected(false);
      lostConnection = true;
    };
    source.addEventListener('changed', () => void queryClient.invalidateQueries());
    return () => source.close();
  }, [queryClient]);
  return connected;
}

const NAV: { route: Route; label: string }[] = [
  { route: { name: 'board' }, label: 'Board' },
  { route: { name: 'requirements' }, label: 'Requirements' },
  { route: { name: 'coverage' }, label: 'Coverage' },
  { route: { name: 'overview' }, label: 'Overview' },
];

export function App() {
  const route = useRoute();
  const project = useProject();
  const connected = useLiveUpdates();
  const toast = useToast();
  const [newItemKind, setNewItemKind] = useState<Kind | null>(null);

  const exportMutation = useMutation({
    mutationFn: () => api.exportReports(),
    onSuccess: (res) => toast.push('success', `Exported ${res.files.length} file(s) to ${res.out_dir}`, res.files),
    onError: (err) => toast.push('error', `Export failed: ${errorText(err)}`),
  });

  useEffect(() => {
    if (project.data) document.title = `${project.data.project_name} · overseer`;
  }, [project.data]);

  const defaultKind: Kind = route.name === 'requirements' || route.name === 'coverage' ? 'requirement' : 'story';

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-brand">
          <a className="app-home" href={hrefFor({ name: 'board' })}>
            <Logo size={18} />
          </a>
          <span className="app-project" title={project.data?.root}>
            {project.data?.project_name ?? '…'}
          </span>
        </div>
        <nav className="app-nav" aria-label="Views">
          {NAV.map(({ route: target, label }) => (
            <a key={label} href={hrefFor(target)} aria-current={route.name === target.name ? 'page' : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <div className="app-tools">
          <span
            className="app-live"
            data-live={connected}
            title={connected ? 'Receiving live updates' : 'Live updates disconnected; retrying'}
          >
            {connected ? 'Live' : 'Offline'}
          </span>
          {project.data && !project.data.vec_available && (
            <span className="app-warn" title="sqlite-vec unavailable: keyword search only">
              Keyword search only
            </span>
          )}
          <span className="app-address">{window.location.host}</span>
          <ThemeSwitch />
          <Button onClick={() => exportMutation.mutate()} disabled={exportMutation.isPending}>
            {exportMutation.isPending ? 'Exporting…' : 'Export'}
          </Button>
          <Button variant="primary" onClick={() => setNewItemKind(defaultKind)} disabled={!project.data}>
            New item
          </Button>
        </div>
      </header>

      <main className="app-main">
        {project.isPending ? (
          <Loading />
        ) : project.isError ? (
          <ErrorBox error={project.error} />
        ) : route.name === 'board' ? (
          <BoardPage project={project.data} />
        ) : route.name === 'requirements' ? (
          <RequirementsPage project={project.data} />
        ) : route.name === 'coverage' ? (
          <CoveragePage />
        ) : route.name === 'overview' ? (
          <OverviewPage project={project.data} />
        ) : (
          <ItemPage key={route.id} id={route.id} project={project.data} />
        )}
      </main>

      {newItemKind && project.data && (
        <NewItemDialog project={project.data} initialKind={newItemKind} onClose={() => setNewItemKind(null)} />
      )}
    </div>
  );
}

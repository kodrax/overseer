import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorText } from './api';
import { useProject } from './hooks';
import { NewItemDialog } from './NewItemDialog';
import { BoardPage } from './pages/BoardPage';
import { CoveragePage } from './pages/CoveragePage';
import { ItemPage } from './pages/ItemPage';
import { RequirementsPage } from './pages/RequirementsPage';
import { hrefFor, useRoute, type Route } from './router';
import { useToast } from './toast';
import { buttonClass, ErrorBox, Loading, primaryButtonClass } from './ui';
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
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-sm font-bold tracking-tight text-sky-700 dark:text-sky-400">overseer</span>
            <span className="truncate text-sm font-semibold" title={project.data?.root}>
              {project.data?.project_name ?? '…'}
            </span>
          </div>
          <nav className="flex gap-1">
            {NAV.map(({ route: target, label }) => {
              const active = route.name === target.name;
              return (
                <a
                  key={label}
                  href={hrefFor(target)}
                  className={`rounded px-2 py-1 text-sm font-medium ${
                    active
                      ? 'bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                  }`}
                >
                  {label}
                </a>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span
              className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"
              title={connected ? 'Receiving live updates' : 'Live updates disconnected; retrying'}
            >
              <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-rose-500'}`} />
              {connected ? 'Live' : 'Offline'}
            </span>
            {project.data && !project.data.vec_available && (
              <span className="text-xs text-amber-600 dark:text-amber-400" title="sqlite-vec unavailable: keyword search only">
                Keyword search only
              </span>
            )}
            <button type="button" className={buttonClass} onClick={() => exportMutation.mutate()} disabled={exportMutation.isPending}>
              {exportMutation.isPending ? 'Exporting…' : 'Export'}
            </button>
            <button type="button" className={primaryButtonClass} onClick={() => setNewItemKind(defaultKind)} disabled={!project.data}>
              New item
            </button>
          </div>
        </div>
      </header>

      <main className="p-4">
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

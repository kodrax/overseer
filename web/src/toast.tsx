import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastTone = 'info' | 'success' | 'error';

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  lines: string[];
}

interface ToastApi {
  push: (tone: ToastTone, title: string, lines?: string[]) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const toneClass: Record<ToastTone, string> = {
  info: 'border-sky-300 bg-white dark:border-sky-700 dark:bg-slate-800',
  success: 'border-emerald-300 bg-white dark:border-emerald-700 dark:bg-slate-800',
  error: 'border-rose-300 bg-rose-50 dark:border-rose-700 dark:bg-rose-950',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (tone: ToastTone, title: string, lines: string[] = []) => {
      const id = nextId.current++;
      setToasts((all) => [...all, { id, tone, title, lines }]);
      window.setTimeout(() => dismiss(id), tone === 'error' ? 10000 : 7000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto rounded-md border px-3 py-2 text-sm shadow-lg ${toneClass[t.tone]}`}
          >
            <div className="flex items-start gap-2">
              <div className="flex-1 font-medium break-words">{t.title}</div>
              <button
                type="button"
                className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                aria-label="Dismiss"
                onClick={() => dismiss(t.id)}
              >
                ×
              </button>
            </div>
            {t.lines.length > 0 && (
              <ul className="mt-1 space-y-0.5 font-mono text-xs text-slate-600 dark:text-slate-300">
                {t.lines.map((line, i) => (
                  <li key={i} className="break-all">
                    {line}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

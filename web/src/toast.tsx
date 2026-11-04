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
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className="toast" data-tone={t.tone}>
            <div className="toast-head">
              <div className="toast-title">{t.title}</div>
              <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                ×
              </button>
            </div>
            {t.lines.length > 0 && (
              <ul className="toast-lines">
                {t.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

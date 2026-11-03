import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './api';
import { App } from './App';
import { applyTheme, storedTheme } from './ds/theme';
import { ToastProvider } from './toast';
import './ds/ds.css';
import './index.css';

// Before the first render, so a stored Paper or Terminal choice never flashes the other theme.
applyTheme(storedTheme());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Live updates arrive through the SSE `changed` event; no need to refetch on focus.
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);

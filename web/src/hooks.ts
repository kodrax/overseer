import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './api';
import type { ListItemsQuery } from './types';

export const queryKeys = {
  project: ['project'] as const,
  items: (q: ListItemsQuery) => ['items', q] as const,
  item: (id: string) => ['item', id] as const,
  search: (q: string, kind?: string) => ['search', q, kind ?? null] as const,
  similar: (text: string, kind?: string) => ['similar', text, kind ?? null] as const,
  report: (kind: string) => ['report', kind] as const,
};

export function useProject() {
  return useQuery({ queryKey: queryKeys.project, queryFn: api.project, staleTime: 30_000 });
}

export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/**
 * useState for a choice from `allowed`, kept in localStorage under `key`. A missing or unknown stored value, or
 * storage that cannot be used, falls back to `initial`.
 */
export function useStoredChoice<T extends string>(key: string, allowed: readonly T[], initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return (allowed as readonly string[]).includes(stored ?? '') ? (stored as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, next);
    } catch {
      // Storage unavailable (privacy mode, quota): the choice lasts until the page is reloaded.
    }
  };
  return [value, set];
}

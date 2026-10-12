import { useMemo, useSyncExternalStore } from 'react';

export type Route =
  | { name: 'board' }
  | { name: 'requirements' }
  | { name: 'coverage' }
  | { name: 'item'; id: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'requirements' && parts.length === 1) return { name: 'requirements' };
  if (parts[0] === 'coverage' && parts.length === 1) return { name: 'coverage' };
  if (parts[0] === 'items' && parts.length === 2) return { name: 'item', id: decodeURIComponent(parts[1]!) };
  return { name: 'board' };
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case 'item':
      return `#/items/${encodeURIComponent(route.id)}`;
    default:
      return `#/${route.name}`;
  }
}

export const itemHref = (id: string): string => hrefFor({ name: 'item', id });

export function navigate(route: Route): void {
  const next = hrefFor(route);
  if (window.location.hash !== next) window.location.hash = next;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

const getHash = (): string => window.location.hash;

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, getHash);
  return useMemo(() => parseHash(hash), [hash]);
}

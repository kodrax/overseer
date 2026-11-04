// Theme switch: Terminal (`dark`, the default and reference) and Paper (`light`). `system` follows
// prefers-color-scheme; tokens.css maps the choice through <html data-theme>.
import { useState } from 'react';

export const THEME_CHOICES = ['system', 'dark', 'light'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

const THEME_LABEL: Record<ThemeChoice, string> = { system: 'System', dark: 'Terminal', light: 'Paper' };
const STORAGE_KEY = 'overseer.theme';

export function storedTheme(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return (THEME_CHOICES as readonly string[]).includes(stored ?? '') ? (stored as ThemeChoice) : 'system';
  } catch {
    return 'system';
  }
}

/** Sets <html data-theme>; `system` removes it so prefers-color-scheme decides. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

export function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>(storedTheme);
  const change = (next: ThemeChoice) => {
    setChoice(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable: the choice lasts until the page is reloaded.
    }
  };
  return (
    <select className="ov-input" aria-label="Theme" value={choice} onChange={(e) => change(e.target.value as ThemeChoice)}>
      {THEME_CHOICES.map((c) => (
        <option key={c} value={c}>
          {THEME_LABEL[c]}
        </option>
      ))}
    </select>
  );
}

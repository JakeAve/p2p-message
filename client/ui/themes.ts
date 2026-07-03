/** One selectable site theme (spec: theme architecture design). */
export interface ThemeOption {
  id: string;
  label: string;
}

/** Adding a theme = one entry here + client/themes/<id>.css + a <link> in index.html. */
export const THEMES: readonly ThemeOption[] = [
  { id: "default", label: "Default" },
  { id: "90s", label: "90s" },
  { id: "banana", label: "Banana" },
];

export const DEFAULT_THEME_ID = "default";
export const THEME_STORAGE_KEY = "theme";

/** Map a stored value to a valid theme id; anything unknown falls back to default. */
export function resolveTheme(saved: string | null): string {
  return THEMES.some((t) => t.id === saved)
    ? saved as string
    : DEFAULT_THEME_ID;
}

/** Apply the saved theme at startup. Read-only: never writes storage. */
export function initTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, blocked) — use the default.
  }
  document.documentElement.dataset.theme = resolveTheme(saved);
}

/** Switch themes and persist the choice. */
export function applyTheme(id: string): void {
  const theme = resolveTheme(id);
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Persistence is best-effort; the theme still applies this session.
  }
}

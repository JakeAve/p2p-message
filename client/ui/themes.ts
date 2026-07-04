/** One selectable site theme (spec: theme architecture design). */
export interface ThemeOption {
  id: string;
  label: string;
}

/** Adding a theme = one entry here + client/themes/<id>.css (loaded lazily). */
export const THEMES: readonly ThemeOption[] = [
  { id: "default", label: "Default" },
  { id: "90s", label: "90s" },
  { id: "banana", label: "Banana" },
  { id: "gram", label: "Gram" },
  { id: "whosapp", label: "Whosapp" },
];

export const DEFAULT_THEME_ID = "default";
export const THEME_STORAGE_KEY = "theme";

/** Map a stored value to a valid theme id; anything unknown falls back to default. */
export function resolveTheme(saved: string | null): string {
  return THEMES.some((t) => t.id === saved)
    ? saved as string
    : DEFAULT_THEME_ID;
}

/**
 * Inject a theme's stylesheet once and resolve when it is usable. The inline
 * script in index.html injects the saved theme's <link> (same data-theme-css
 * marker) before first paint, so at startup this usually finds it already
 * present. Resolves on load errors too — a missing file just means the theme
 * renders with the default look rather than the switch hanging.
 */
function ensureThemeCss(id: string): Promise<void> {
  if (id === DEFAULT_THEME_ID) return Promise.resolve();
  if (document.head.querySelector(`link[data-theme-css="${id}"]`)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `/themes/${id}.css`;
    link.setAttribute("data-theme-css", id);
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.append(link);
  });
}

/** Point the <link id="favicon"> at this theme's wax-seal recolor. */
function applyFavicon(id: string): void {
  const link = document.getElementById("favicon") as HTMLLinkElement | null;
  if (link) link.href = `/favicons/${id}.svg`;
}

/** The most recently requested theme; guards against out-of-order CSS loads. */
let requestedTheme: string | null = null;

/** Apply the saved theme at startup. Read-only: never writes storage. */
export function initTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, blocked) — use the default.
  }
  const theme = resolveTheme(saved);
  requestedTheme = theme;
  // Set the attribute immediately: the inline index.html script has already
  // loaded the CSS in the common case, and this also corrects any unknown
  // stored id the inline script let through.
  document.documentElement.dataset.theme = theme;
  applyFavicon(theme);
  ensureThemeCss(theme);
}

/** Switch themes and persist the choice. */
export function applyTheme(id: string): void {
  const theme = resolveTheme(id);
  requestedTheme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Persistence is best-effort; the theme still applies this session.
  }
  // Flip the attribute only once the CSS is ready so the switch never shows
  // a half-themed frame; skip if another switch superseded this one.
  ensureThemeCss(theme).then(() => {
    if (requestedTheme === theme) {
      document.documentElement.dataset.theme = theme;
      applyFavicon(theme);
    }
  });
}

import { el } from "./dom.ts";
import { applyTheme, resolveTheme, THEMES } from "./themes.ts";

/**
 * Site-wide theme <select>, fixed top-right on every screen. Append to
 * document.body (NOT #app) so view re-renders never destroy it.
 */
export function renderThemePicker(parent: HTMLElement): HTMLSelectElement {
  const select = el("select", "theme-picker");
  select.setAttribute("aria-label", "Theme");
  for (const theme of THEMES) {
    const option = el("option");
    option.value = theme.id;
    option.textContent = theme.label;
    select.append(option);
  }
  select.value = resolveTheme(
    document.documentElement.dataset.theme ?? null,
  );
  select.addEventListener("change", () => applyTheme(select.value));
  parent.append(select);
  return select;
}

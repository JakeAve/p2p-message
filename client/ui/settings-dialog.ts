import { el } from "./dom.ts";
import { applyTheme, resolveTheme, THEMES } from "./themes.ts";

/** Inline gear icon; currentColor keeps it legible under every theme. */
const GEAR_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="3.2"/>' +
  '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.03-1.51 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.03 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03z"/>' +
  "</svg>";

/** Inline close (X) icon; currentColor keeps it legible under every theme. */
const CLOSE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M6 6l12 12M18 6L6 18"/>' +
  "</svg>";

/**
 * Site-wide settings: a gear button fixed top-right on every screen that
 * opens a modal dialog. Currently holds the theme select; future settings
 * append more fields to `.settings-body`. Append to document.body (NOT
 * #app) so view re-renders never destroy it.
 */
export function renderSettings(parent: HTMLElement): HTMLButtonElement {
  const button = el("button", "settings-btn");
  button.setAttribute("aria-label", "Settings");
  button.dataset.e2e = "settings";
  button.innerHTML = GEAR_SVG;

  const dialog = el("dialog", "settings-dialog");
  const body = el("div", "settings-body");
  const head = el("div", "settings-head");
  const title = el("h2");
  title.textContent = "Settings";
  const close = el("button", "settings-close");
  close.setAttribute("aria-label", "Close settings");
  close.innerHTML = CLOSE_SVG;
  close.addEventListener("click", () => dialog.close());
  head.append(title, close);

  const field = el("label", "field");
  const label = el("span", "field-label");
  label.textContent = "Theme";
  const select = el("select", "theme-select");
  select.setAttribute("aria-label", "Theme");
  for (const theme of THEMES) {
    const option = el("option");
    option.value = theme.id;
    option.textContent = theme.label;
    select.append(option);
  }
  select.addEventListener("change", () => applyTheme(select.value));
  field.append(label, select);

  body.append(head, field);
  dialog.append(body);

  button.addEventListener("click", () => {
    select.value = resolveTheme(document.documentElement.dataset.theme ?? null);
    dialog.showModal();
  });
  // Light dismiss: the padded content is .settings-body, so a click landing
  // on the <dialog> itself is a backdrop click. Escape closes natively.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  parent.append(button, dialog);
  return button;
}

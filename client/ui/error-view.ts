import { el } from "./dom.ts";
import type { Screen } from "./screens.ts";

/** Render a terminal screen (error or ended state) into `root`. */
export function renderScreen(root: HTMLElement, screen: Screen): void {
  root.innerHTML = "";
  const card = el("div", "card stack screen");
  const title = el("h1");
  title.textContent = screen.title;
  const body = el("p", "muted");
  body.textContent = screen.body;
  card.append(title, body);
  if (screen.startNew) {
    const actions = el("div", "actions");
    const link = el("a", "start-new");
    link.href = "/";
    link.textContent = "Start a new chat";
    actions.append(link);
    card.append(actions);
  }
  root.append(card);
}

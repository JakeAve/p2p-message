import { el } from "./dom.ts";
import {
  DEFAULT_GRACE_MS,
  DEFAULT_INVITE_MS,
  GRACE_PRESETS,
  INVITE_PRESETS,
  type Preset,
} from "./presets.ts";

export interface CreateOptions {
  inviteWindowMs: number;
  graceDurationMs: number;
  displayName?: string;
}

function presetFieldset(
  legendText: string,
  groupName: string,
  presets: Preset[],
  defaultMs: number,
): HTMLFieldSetElement {
  const fs = el("fieldset", "presets");
  const legend = el("legend");
  legend.textContent = legendText;
  const row = el("div", "preset-row");
  for (const preset of presets) {
    const label = el("label");
    const input = el("input");
    input.type = "radio";
    input.name = groupName;
    input.value = String(preset.ms);
    input.checked = preset.ms === defaultMs;
    const pill = el("span");
    pill.textContent = preset.label;
    label.append(input, pill);
    row.append(label);
  }
  fs.append(legend, row);
  return fs;
}

/** Spec §10.1 — the create page at `/`. */
export function renderCreateView(
  root: HTMLElement,
  handlers: { onCreate(opts: CreateOptions): void },
): void {
  root.innerHTML = "";
  const card = el("div", "card stack");

  const title = el("h1");
  title.textContent = "Send something sensitive, safely.";
  const intro = el("p", "muted");
  intro.textContent =
    "Create a one-time link, send it to one person, and chat end-to-end " +
    "encrypted. Nothing is stored on any server — when the chat ends, " +
    "it's gone.";

  const inviteFs = presetFieldset(
    "How long the invite link stays live",
    "invite",
    INVITE_PRESETS,
    DEFAULT_INVITE_MS,
  );
  const graceFs = presetFieldset(
    "How long to wait if someone disconnects",
    "grace",
    GRACE_PRESETS,
    DEFAULT_GRACE_MS,
  );

  const nameField = el("label", "field");
  const nameLabel = el("span", "field-label");
  nameLabel.textContent = "Display name (optional)";
  const nameInput = el("input");
  nameInput.type = "text";
  nameInput.maxLength = 40;
  nameInput.placeholder = "Shown to the other person";
  nameField.append(nameLabel, nameInput);

  const createBtn = el("button", "btn btn-primary");
  createBtn.textContent = "Create secure link";
  createBtn.addEventListener("click", () => {
    const invite = card.querySelector<HTMLInputElement>(
      'input[name="invite"]:checked',
    );
    const grace = card.querySelector<HTMLInputElement>(
      'input[name="grace"]:checked',
    );
    if (!invite || !grace) return; // defaults are pre-checked; unreachable
    createBtn.disabled = true;
    createBtn.textContent = "Creating…";
    handlers.onCreate({
      inviteWindowMs: Number(invite.value),
      graceDurationMs: Number(grace.value),
      displayName: nameInput.value.trim() || undefined,
    });
  });

  card.append(title, intro, inviteFs, graceFs, nameField, createBtn);
  root.append(card);
}

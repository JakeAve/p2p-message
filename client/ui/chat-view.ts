import { el } from "./dom.ts";
import {
  formatCountdown,
  MAX_MESSAGE_BYTES,
  utf8ByteLength,
} from "./format.ts";
import type { SessionStatus } from "../session.ts";

export interface ChatMessage {
  text: string;
  direction: "sent" | "received";
  timestamp: number;
}

export type ChatStatus =
  | { kind: "connecting" | "securing" | "secure" }
  | { kind: "reconnecting"; msRemaining: number };

export interface ChatViewController {
  addMessage(msg: ChatMessage): void;
  addSystemNote(text: string): void;
  setSafetyCode(code: string): void;
  setPeerName(name: string): void;
  setStatus(status: ChatStatus): void;
  /** Test hook only: reflects C5's raw SessionStatus as `data-status`. */
  setStatusAttr(status: SessionStatus): void;
  setComposerEnabled(enabled: boolean): void;
  destroy(): void;
}

/**
 * Spec §10.4 — message list (memory only), composer with the 4,000-byte
 * live counter, safety code in the header with the pinned explainer,
 * connection status (incl. grace countdown), End chat button.
 */
export function renderChatView(
  root: HTMLElement,
  handlers: { onSend(text: string): void; onEnd(): void },
): ChatViewController {
  root.innerHTML = "";
  const view = el("div", "chat");

  // Header: safety code + status + end button.
  const header = el("div", "chat-header");
  const safety = el("div", "safety");
  const safetyCode = el("div", "safety-code");
  safetyCode.dataset.e2e = "safety-code";
  safetyCode.textContent = "· · · · · ·"; // no code until first key-confirm
  const safetyHint = el("p", "safety-hint");
  safetyHint.textContent =
    "Both of you should see the same code. Confirm it over a phone call " +
    "or another channel if you're sending something sensitive.";
  safety.append(safetyCode, safetyHint);

  const right = el("div", "chat-header-right");
  const peerName = el("span", "peer-name");
  const statusPill = el("span", "status-pill connecting");
  statusPill.dataset.e2e = "status";
  statusPill.textContent = "Connecting…";

  // End chat: in-page confirm step (native confirm()/alert() can't be
  // dismissed by headless automation, and are poor UX anyway).
  const endBtn = el("button", "btn btn-quiet");
  endBtn.textContent = "End chat";
  endBtn.dataset.e2e = "end-chat";
  const endConfirmBtn = el("button", "btn btn-primary");
  endConfirmBtn.textContent = "Confirm end chat?";
  endConfirmBtn.dataset.e2e = "end-confirm";
  endConfirmBtn.hidden = true;
  endBtn.addEventListener("click", () => {
    endBtn.hidden = true;
    endConfirmBtn.hidden = false;
  });
  endConfirmBtn.addEventListener("click", () => {
    handlers.onEnd();
  });
  right.append(peerName, statusPill, endBtn, endConfirmBtn);
  header.append(safety, right);

  // Message list — memory/DOM only, never persisted anywhere.
  const messages = el("div", "messages");
  const scrollToEnd = () => {
    messages.scrollTop = messages.scrollHeight;
  };

  // Composer with live UTF-8 byte counter.
  const composer = el("div", "composer");
  const row = el("div", "composer-row");
  const textarea = el("textarea");
  textarea.placeholder = "Type a message…";
  textarea.rows = 1;
  textarea.dataset.e2e = "composer";
  const sendBtn = el("button", "btn btn-primary");
  sendBtn.textContent = "Send";
  sendBtn.dataset.e2e = "send";
  row.append(textarea, sendBtn);
  const meta = el("div", "composer-meta");
  const counter = el("span", "counter");
  const ephemeralNote = el("span", "ephemeral-note");
  ephemeralNote.textContent =
    "Messages exist only in these two open tabs — when the chat ends, they're gone.";
  meta.append(counter, ephemeralNote);
  composer.append(row, meta);

  let composerEnabled = false;
  const updateComposer = () => {
    const bytes = utf8ByteLength(textarea.value);
    counter.textContent = `${bytes} / ${MAX_MESSAGE_BYTES} bytes`;
    counter.classList.toggle("over", bytes > MAX_MESSAGE_BYTES);
    textarea.disabled = !composerEnabled;
    sendBtn.disabled = !composerEnabled ||
      textarea.value.trim().length === 0 ||
      bytes > MAX_MESSAGE_BYTES;
  };
  const send = () => {
    if (sendBtn.disabled) return;
    const text = textarea.value;
    textarea.value = "";
    updateComposer();
    handlers.onSend(text);
  };
  textarea.addEventListener("input", updateComposer);
  sendBtn.addEventListener("click", send);
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  updateComposer();

  view.append(header, messages, composer);
  root.append(view);

  return {
    addMessage(msg) {
      const bubble = el("div", `msg ${msg.direction}`);
      bubble.dataset.e2e = "message";
      bubble.textContent = msg.text;
      messages.append(bubble);
      scrollToEnd();
    },
    addSystemNote(text) {
      const note = el("div", "msg system");
      note.textContent = text;
      messages.append(note);
      scrollToEnd();
    },
    setSafetyCode(code) {
      safetyCode.textContent = code;
    },
    setPeerName(name) {
      peerName.textContent = name;
    },
    setStatus(status) {
      statusPill.className = `status-pill ${status.kind}`;
      if (status.kind === "reconnecting") {
        statusPill.textContent = `Reconnecting — ${
          formatCountdown(status.msRemaining)
        } left`;
      } else if (status.kind === "secure") {
        statusPill.textContent = "Secure";
      } else if (status.kind === "securing") {
        statusPill.textContent = "Securing…";
      } else {
        statusPill.textContent = "Connecting…";
      }
    },
    setStatusAttr(status) {
      statusPill.dataset.status = status;
    },
    setComposerEnabled(enabled) {
      composerEnabled = enabled;
      updateComposer();
    },
    destroy() {
      view.remove();
    },
  };
}

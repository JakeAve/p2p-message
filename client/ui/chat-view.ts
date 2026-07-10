import { el } from "./dom.ts";
import {
  formatCountdown,
  formatFileSize,
  formatMessageTime,
  MAX_MESSAGE_BYTES,
  utf8ByteLength,
} from "./format.ts";
import type { SessionStatus } from "../session.ts";

export interface ChatMessage {
  /** Present on sent messages (from sendChat) and id-carrying received ones. */
  id?: string;
  text: string;
  direction: "sent" | "received";
  timestamp: number;
}

export type ChatStatus =
  | { kind: "connecting" | "securing" | "secure" | "waiting" }
  | { kind: "reconnecting"; msRemaining: number };

export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  direction: "sent" | "received";
}

export interface ChatViewController {
  addMessage(msg: ChatMessage): void;
  addSystemNote(text: string): void;
  /** Flip a sent message to delivered (unknown ids are a no-op). */
  setDelivered(id: string): void;
  /** Show/hide the peer's typing dots. */
  setPeerTyping(visible: boolean): void;
  setSafetyCode(code: string): void;
  setPeerName(name: string): void;
  setStatus(status: ChatStatus): void;
  /** Test hook only: reflects C5's raw SessionStatus as `data-status`. */
  setStatusAttr(status: SessionStatus): void;
  setComposerEnabled(enabled: boolean): void;
  /** Render a pending attachment bubble with a progress ring and cancel. */
  addAttachment(att: ChatAttachment): void;
  setAttachmentProgress(
    id: string,
    bytesDone: number,
    bytesTotal: number,
  ): void;
  /** Swap the ring for an inline preview/tile plus a Save link. */
  completeAttachment(id: string, blob: Blob): void;
  failAttachment(
    id: string,
    opts: { message: string; canRetry: boolean },
  ): void;
  /** Revoke the object URL and remove the bubble (used by retry). */
  removeAttachment(id: string): void;
  destroy(): void;
}

const RING_RADIUS = 15;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const SVG_NS = "http://www.w3.org/2000/svg";

function makeProgressRing(): { svg: SVGSVGElement; fill: SVGCircleElement } {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 36 36");
  svg.setAttribute("class", "progress-ring");
  svg.dataset.e2e = "attachment-progress";
  const track = document.createElementNS(SVG_NS, "circle");
  track.setAttribute("class", "ring-track");
  const fill = document.createElementNS(SVG_NS, "circle");
  fill.setAttribute("class", "ring-fill");
  for (const c of [track, fill]) {
    c.setAttribute("cx", "18");
    c.setAttribute("cy", "18");
    c.setAttribute("r", String(RING_RADIUS));
  }
  fill.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  fill.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  svg.append(track, fill);
  return { svg, fill };
}

/**
 * Spec §10.4 — message list (memory only), composer with the 4,000-byte
 * live counter, safety code behind an info button in the header,
 * connection status (incl. grace countdown), End chat button.
 */
export function renderChatView(
  root: HTMLElement,
  handlers: {
    onSend(text: string): void;
    onSendFiles(files: File[]): void;
    onCancelAttachment(id: string): void;
    onRetryAttachment(id: string): void;
    onEnd(): void;
    /** Composer activity: called with whether it is now non-empty. */
    onTyping(nonEmpty: boolean): void;
  },
): ChatViewController {
  root.innerHTML = "";
  const view = el("div", "chat");

  // Header: safety code with its explainer behind an info button + status
  // + end button.
  const header = el("div", "chat-header");
  const safety = el("div", "safety");
  const safetyCode = el("div", "safety-code");
  safetyCode.dataset.e2e = "safety-code";
  safetyCode.textContent = "· · · · · ·"; // no code until first key-confirm
  const safetyToggle = el("button", "safety-toggle");
  safetyToggle.dataset.e2e = "safety-toggle";
  safetyToggle.setAttribute("aria-label", "About the safety code");
  safetyToggle.setAttribute("aria-expanded", "false");
  safetyToggle.textContent = "i";
  const safetyPopover = el("div", "safety-popover");
  safetyPopover.hidden = true;
  const safetyHint = el("p", "safety-hint");
  safetyHint.textContent =
    "Both of you should see the same code. Confirm it over a phone call " +
    "or another channel if you're sending something sensitive.";
  safetyPopover.append(safetyHint);
  const setSafetyOpen = (open: boolean) => {
    safetyPopover.hidden = !open;
    safetyToggle.setAttribute("aria-expanded", String(open));
  };
  safetyToggle.addEventListener("click", () => {
    setSafetyOpen(!!safetyPopover.hidden);
  });
  // Light dismiss: click anywhere else or Escape closes the popover.
  const onDocumentClick = (event: MouseEvent) => {
    if (!safetyPopover.hidden && !safety.contains(event.target as Node)) {
      setSafetyOpen(false);
    }
    if (!statusPopover.hidden && !status.contains(event.target as Node)) {
      setStatusOpen(false);
    }
  };
  document.addEventListener("click", onDocumentClick);
  const onDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setSafetyOpen(false);
      setStatusOpen(false);
    }
  };
  document.addEventListener("keydown", onDocumentKeydown);
  safety.append(safetyCode, safetyToggle, safetyPopover);

  const right = el("div", "chat-header-right");
  const peerName = el("span", "peer-name");
  const status = el("div", "status");
  const statusPill = el("button", "status-pill connecting");
  statusPill.dataset.e2e = "status";
  statusPill.setAttribute("aria-expanded", "false");
  statusPill.setAttribute(
    "aria-label",
    "Connection status: connecting. Click for details.",
  );
  statusPill.append(el("span", "status-dot"));
  const statusCountdown = el("span", "status-countdown");
  statusCountdown.hidden = true;
  const statusPopover = el("div", "status-popover");
  statusPopover.hidden = true;
  const statusHint = el("p", "status-hint");
  statusHint.textContent = "Waiting for the other person to join…";
  statusPopover.append(statusHint);
  const setStatusOpen = (open: boolean) => {
    statusPopover.hidden = !open;
    statusPill.setAttribute("aria-expanded", String(open));
  };
  statusPill.addEventListener("click", () => {
    setStatusOpen(!!statusPopover.hidden);
  });
  status.append(statusPill, statusCountdown, statusPopover);

  // End chat: native <dialog> confirmation (same pattern as the settings
  // modal) rather than window.confirm(), which is undismissable by headless
  // automation and poor UX.
  const endBtn = el("button", "btn btn-quiet");
  endBtn.textContent = "End chat";
  endBtn.dataset.e2e = "end-chat";
  const endDialog = el("dialog", "end-chat-dialog");
  const endBody = el("div", "end-chat-body");
  const endTitle = el("h2");
  endTitle.textContent = "End this chat?";
  const endHint = el("p");
  endHint.textContent =
    "All messages will be permanently deleted for both of you and " +
    "cannot be recovered.";
  const endActions = el("div", "dialog-actions");
  const endCancelBtn = el("button", "btn btn-quiet");
  endCancelBtn.textContent = "Cancel";
  endCancelBtn.dataset.e2e = "end-cancel";
  endCancelBtn.addEventListener("click", () => endDialog.close());
  const endConfirmBtn = el("button", "btn btn-danger");
  endConfirmBtn.textContent = "End chat";
  endConfirmBtn.dataset.e2e = "end-confirm";
  endConfirmBtn.addEventListener("click", () => {
    endDialog.close();
    handlers.onEnd();
  });
  endActions.append(endCancelBtn, endConfirmBtn);
  endBody.append(endTitle, endHint, endActions);
  endDialog.append(endBody);
  endBtn.addEventListener("click", () => endDialog.showModal());
  // Light dismiss: the padded content is .end-chat-body, so a click landing
  // on the <dialog> itself is a backdrop click. Escape closes natively.
  endDialog.addEventListener("click", (event) => {
    if (event.target === endDialog) endDialog.close();
  });
  right.append(peerName, status, endBtn);
  header.append(safety, right);

  // Message list — memory/DOM only, never persisted anywhere.
  const messages = el("div", "messages");
  const scrollToEnd = () => {
    messages.scrollTop = messages.scrollHeight;
  };
  // Received messages/notes only pull the view down if it was already
  // pinned to the bottom — otherwise someone scrolled up to reread earlier
  // messages while composing keeps their place.
  const isAtBottom = () =>
    messages.scrollHeight - messages.scrollTop - messages.clientHeight < 24;

  // Delivery state (memory/DOM only, like the messages themselves): which
  // sent ids are delivered, plus the single Sent/Delivered label that tracks
  // the newest sent bubble (spec: quiet by default; older state via tap).
  const sentDelivered = new Map<string, boolean>();
  let latestSentId: string | null = null;
  const deliveryLabel = el("div", "delivery-label");
  deliveryLabel.dataset.e2e = "delivery-label";
  deliveryLabel.hidden = true;

  // Attachment bubbles: pending progress ring -> preview/tile + Save link.
  type AttachmentRecord = {
    bubble: HTMLElement;
    body: HTMLElement;
    ringFill: SVGCircleElement | null;
    direction: "sent" | "received";
    name: string;
    size: number;
    mime: string;
    objectUrl: string | null;
  };
  const attachmentById = new Map<string, AttachmentRecord>();

  // Full-size image overlay (one shared <dialog>).
  const imageOverlay = el("dialog", "image-overlay");
  const overlayImg = el("img") as HTMLImageElement;
  overlayImg.alt = "";
  imageOverlay.append(overlayImg);
  imageOverlay.addEventListener("click", () => imageOverlay.close());

  // Tap-to-reveal: at most one open reveal line at a time.
  let openReveal: HTMLElement | null = null;
  let openRevealFor: HTMLElement | null = null;
  const closeReveal = () => {
    openReveal?.remove();
    openReveal = null;
    openRevealFor = null;
  };

  // Typing dots: a ghost received-style bubble pinned last in the list.
  const typingBubble = el("div", "msg received typing");
  typingBubble.dataset.e2e = "typing-indicator";
  typingBubble.setAttribute("role", "status");
  typingBubble.setAttribute("aria-label", "The other person is typing");
  typingBubble.append(el("span", "dot"), el("span", "dot"), el("span", "dot"));
  typingBubble.hidden = true;
  messages.append(typingBubble);

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
  const fileInput = el("input") as HTMLInputElement;
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.dataset.e2e = "file-input";
  const attachBtn = el("button", "btn attach-btn");
  attachBtn.textContent = "+";
  attachBtn.dataset.e2e = "attach";
  attachBtn.setAttribute("aria-label", "Send a file");
  // keep mobile keyboard alive, same as the send button
  attachBtn.addEventListener("mousedown", (event) => event.preventDefault());
  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = "";
    if (files.length > 0) handlers.onSendFiles(files);
  });
  row.append(attachBtn, textarea, sendBtn);
  const meta = el("div", "composer-meta");
  const counter = el("span", "counter");
  meta.append(counter);
  composer.append(row, meta, fileInput);

  let composerEnabled = false;
  const updateComposer = () => {
    const bytes = utf8ByteLength(textarea.value);
    counter.textContent = `${bytes} / ${MAX_MESSAGE_BYTES} bytes`;
    counter.classList.toggle("over", bytes > MAX_MESSAGE_BYTES);
    textarea.disabled = !composerEnabled;
    attachBtn.disabled = !composerEnabled;
    sendBtn.disabled = !composerEnabled ||
      textarea.value.trim().length === 0 ||
      bytes > MAX_MESSAGE_BYTES;
  };
  // Grow with the text up to the CSS max-height (then scroll). scrollHeight
  // excludes borders, so add them back for border-box sizing.
  const autosize = () => {
    textarea.style.height = "auto";
    const borders = textarea.offsetHeight - textarea.clientHeight;
    textarea.style.height = `${textarea.scrollHeight + borders}px`;
  };
  const send = () => {
    if (sendBtn.disabled) return;
    const text = textarea.value;
    textarea.value = "";
    updateComposer();
    autosize();
    handlers.onTyping(false);
    handlers.onSend(text);
  };
  textarea.addEventListener("input", () => {
    updateComposer();
    autosize();
    handlers.onTyping(textarea.value.trim().length > 0);
  });
  // keep mobile keyboard alive with mousedown event
  sendBtn.addEventListener("mousedown", (event) => event.preventDefault());
  sendBtn.addEventListener("click", send);
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  updateComposer();

  view.append(header, messages, composer, endDialog, imageOverlay);
  root.append(view);

  return {
    addMessage(msg) {
      const wasAtBottom = isAtBottom();
      const bubble = el("div", `msg ${msg.direction}`);
      bubble.dataset.e2e = "message";
      bubble.textContent = msg.text;
      bubble.addEventListener("click", () => {
        if (openRevealFor === bubble) {
          closeReveal(); // second tap closes
          return;
        }
        closeReveal();
        const reveal = el("div", `msg-reveal ${msg.direction}`);
        reveal.dataset.e2e = "msg-reveal";
        let text = formatMessageTime(msg.timestamp);
        if (msg.direction === "sent" && msg.id !== undefined) {
          text += sentDelivered.get(msg.id) ? " · Delivered" : " · Sent";
        }
        reveal.textContent = text;
        bubble.after(reveal);
        openReveal = reveal;
        openRevealFor = bubble;
      });
      messages.insertBefore(bubble, typingBubble); // dots stay last
      if (msg.direction === "sent" && msg.id !== undefined) {
        sentDelivered.set(msg.id, false);
        latestSentId = msg.id;
        deliveryLabel.textContent = "Sent";
        deliveryLabel.hidden = false;
        bubble.after(deliveryLabel); // label tracks the newest sent bubble
      }
      if (msg.direction === "sent" || wasAtBottom) scrollToEnd();
    },
    addSystemNote(text) {
      const wasAtBottom = isAtBottom();
      const note = el("div", "msg system");
      note.textContent = text;
      messages.insertBefore(note, typingBubble);
      if (wasAtBottom) scrollToEnd();
    },
    setDelivered(id) {
      if (!sentDelivered.has(id)) return; // unknown id: no-op (spec)
      sentDelivered.set(id, true);
      if (id === latestSentId) deliveryLabel.textContent = "Delivered";
    },
    setPeerTyping(visible) {
      typingBubble.hidden = !visible;
    },
    setSafetyCode(code) {
      safetyCode.textContent = code;
    },
    setPeerName(name) {
      peerName.textContent = name;
      typingBubble.setAttribute("aria-label", `${name} is typing`);
    },
    setStatus(status) {
      statusPill.className = `status-pill ${status.kind}`;
      statusCountdown.hidden = status.kind !== "reconnecting";
      if (status.kind === "reconnecting") {
        statusCountdown.textContent = `${
          formatCountdown(
            status.msRemaining,
          )
        } left`;
        statusPill.setAttribute(
          "aria-label",
          "Connection status: reconnecting. Click for details.",
        );
        statusHint.textContent =
          "The other person disconnected. Reconnecting before the chat ends…";
      } else if (status.kind === "secure") {
        statusPill.setAttribute(
          "aria-label",
          "Connection status: secure. Click for details.",
        );
        statusHint.textContent = "Your messages are end-to-end encrypted.";
      } else if (status.kind === "securing") {
        statusPill.setAttribute(
          "aria-label",
          "Connection status: securing. Click for details.",
        );
        statusHint.textContent = "Setting up end-to-end encryption…";
      } else if (status.kind === "waiting") {
        statusPill.setAttribute(
          "aria-label",
          "Connection status: waiting for the other person. Click for details.",
        );
        statusHint.textContent = "The other person isn't here yet. " +
          "You can switch apps — this page reconnects when you return.";
      } else {
        statusPill.setAttribute(
          "aria-label",
          "Connection status: connecting. Click for details.",
        );
        statusHint.textContent = "Waiting for the other person to join…";
      }
    },
    setStatusAttr(status) {
      statusPill.dataset.status = status;
    },
    setComposerEnabled(enabled) {
      composerEnabled = enabled;
      updateComposer();
    },
    addAttachment(att) {
      const wasAtBottom = isAtBottom();
      const bubble = el("div", `msg ${att.direction} attachment`);
      bubble.dataset.e2e = "attachment";
      bubble.dataset.id = att.id;
      const body = el("div", "attachment-body");
      const { svg, fill } = makeProgressRing();
      const info = el("div", "attachment-info");
      const nameEl = el("div", "attachment-name");
      nameEl.textContent = att.name;
      const sizeEl = el("div", "attachment-size");
      sizeEl.textContent = formatFileSize(att.size);
      info.append(nameEl, sizeEl);
      const cancelBtn = el("button", "attachment-cancel");
      cancelBtn.dataset.e2e = "attachment-cancel";
      cancelBtn.setAttribute("aria-label", "Cancel transfer");
      cancelBtn.textContent = "×";
      cancelBtn.addEventListener(
        "click",
        () => handlers.onCancelAttachment(att.id),
      );
      body.append(svg, info, cancelBtn);
      bubble.append(body);
      attachmentById.set(att.id, {
        bubble,
        body,
        ringFill: fill,
        direction: att.direction,
        name: att.name,
        size: att.size,
        mime: att.mime,
        objectUrl: null,
      });
      messages.insertBefore(bubble, typingBubble);
      if (att.direction === "sent") {
        sentDelivered.set(att.id, false);
        latestSentId = att.id;
        deliveryLabel.textContent = "Sent";
        deliveryLabel.hidden = false;
        bubble.after(deliveryLabel);
      }
      if (att.direction === "sent" || wasAtBottom) scrollToEnd();
    },
    setAttachmentProgress(id, bytesDone, bytesTotal) {
      const rec = attachmentById.get(id);
      if (!rec?.ringFill || bytesTotal === 0) return;
      const fraction = Math.min(1, bytesDone / bytesTotal);
      rec.ringFill.style.strokeDashoffset = String(
        RING_CIRCUMFERENCE * (1 - fraction),
      );
    },
    completeAttachment(id, blob) {
      const rec = attachmentById.get(id);
      if (!rec) return;
      const wasAtBottom = isAtBottom();
      const url = URL.createObjectURL(blob);
      rec.objectUrl = url;
      rec.ringFill = null;
      rec.body.innerHTML = "";
      if (rec.mime.startsWith("image/")) {
        const img = el("img", "attachment-preview") as HTMLImageElement;
        img.src = url;
        img.alt = rec.name;
        img.addEventListener("click", () => {
          overlayImg.src = url;
          imageOverlay.showModal();
        });
        rec.body.append(img);
      } else if (rec.mime.startsWith("video/")) {
        const video = el("video", "attachment-preview") as HTMLVideoElement;
        video.controls = true;
        video.src = url;
        rec.body.append(video);
      } else if (rec.mime.startsWith("audio/")) {
        const audio = el("audio") as HTMLAudioElement;
        audio.controls = true;
        audio.src = url;
        rec.body.append(audio);
      }
      const tile = el("div", "attachment-tile");
      const info = el("div", "attachment-info");
      const nameEl = el("div", "attachment-name");
      nameEl.textContent = rec.name;
      const sizeEl = el("div", "attachment-size");
      sizeEl.textContent = formatFileSize(rec.size);
      info.append(nameEl, sizeEl);
      const save = el("a", "btn attachment-save") as HTMLAnchorElement;
      save.dataset.e2e = "attachment-save";
      save.textContent = "Save";
      save.href = url;
      save.download = rec.name;
      tile.append(info, save);
      rec.body.append(tile);
      if (wasAtBottom) scrollToEnd();
    },
    failAttachment(id, opts) {
      const rec = attachmentById.get(id);
      if (!rec) return;
      rec.ringFill = null;
      rec.bubble.classList.add("attachment-failed");
      rec.body.innerHTML = "";
      const info = el("div", "attachment-info");
      const nameEl = el("div", "attachment-name");
      nameEl.textContent = rec.name;
      const note = el("div", "attachment-fail-note");
      note.textContent = opts.message;
      info.append(nameEl, note);
      rec.body.append(info);
      if (opts.canRetry) {
        const retry = el("button", "btn attachment-retry");
        retry.dataset.e2e = "attachment-retry";
        retry.textContent = "Retry";
        retry.addEventListener("click", () => handlers.onRetryAttachment(id));
        rec.body.append(retry);
      }
    },
    removeAttachment(id) {
      const rec = attachmentById.get(id);
      if (!rec) return;
      if (rec.objectUrl) URL.revokeObjectURL(rec.objectUrl);
      // The label is a SIBLING placed via bubble.after(deliveryLabel):
      // removing the bubble would leave it floating, so park it if it
      // currently tracks this bubble.
      if (latestSentId === id) {
        latestSentId = null;
        deliveryLabel.hidden = true;
        deliveryLabel.remove();
      }
      sentDelivered.delete(id);
      rec.bubble.remove();
      attachmentById.delete(id);
    },
    destroy() {
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onDocumentKeydown);
      for (const rec of attachmentById.values()) {
        if (rec.objectUrl) URL.revokeObjectURL(rec.objectUrl);
      }
      view.remove();
    },
  };
}

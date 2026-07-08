import { el } from "./dom.ts";
import { formatCountdown } from "./format.ts";
import { createQrSvg } from "./qr.ts";

export interface ShareView {
  destroy(): void;
  /** Patch the displayed link + QR in place (e.g. once a recovery token
   * arrives a moment after the share view was first rendered — see
   * client/app.ts and the stateless-room-recovery design's §3). */
  updateLink(link: string): void;
}

/**
 * Spec §10.2 — full-screen share overlay APPENDED over the (empty) chat.
 * Full link + copy button + client-side QR + invite countdown + the pinned
 * free-to-leave line. `destroy()` removes it and stops the countdown.
 */
export function renderShareView(
  root: HTMLElement,
  opts: { link: string; inviteWindowMs: number },
): ShareView {
  const overlay = el("div", "share-overlay");
  const card = el("div", "card stack share-card");

  const title = el("h1");
  title.textContent = "Your secure link is ready";
  const intro = el("p", "muted");
  intro.textContent =
    "Send this link to one person over a channel you trust. It works " +
    "exactly once, for exactly two people.";

  const linkRow = el("div", "share-link");
  const linkInput = el("input");
  linkInput.type = "text";
  linkInput.readOnly = true;
  linkInput.value = opts.link;
  linkInput.dataset.e2e = "share-link";
  linkInput.addEventListener("focus", () => linkInput.select());
  let currentLink = opts.link;
  const copyBtn = el("button", "btn btn-primary");
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(currentLink);
      copyBtn.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.textContent = "Copy";
      }, 1500);
    } catch {
      linkInput.select(); // clipboard unavailable — leave the link selected
    }
  });
  linkRow.append(linkInput, copyBtn);

  const qr = el("div", "qr");
  // QR is generated entirely client-side (the link embeds the fragment
  // secret) and inlined as SVG markup — no external fetch, CSP-safe.
  qr.innerHTML = createQrSvg(opts.link);

  const countdownLine = el("p", "muted");
  const countdown = el("span", "countdown");
  countdownLine.append("Invite expires in ", countdown);

  const keepOpen = el("p", "keep-open");
  keepOpen.textContent = "The invite stays live until the countdown ends.";

  card.append(title, intro, linkRow, qr, countdownLine, keepOpen);
  overlay.append(card);
  root.append(overlay);

  const deadline = Date.now() + opts.inviteWindowMs;
  const tick = () => {
    countdown.textContent = formatCountdown(Math.max(0, deadline - Date.now()));
  };
  tick();
  const timer = setInterval(tick, 1000);

  return {
    destroy() {
      clearInterval(timer);
      overlay.remove();
    },
    updateLink(link: string) {
      currentLink = link;
      linkInput.value = link;
      qr.innerHTML = createQrSvg(link);
    },
  };
}

import {
  base64urlToBytes,
  bytesToBase64url,
  derivePathToken,
  generateFragmentSecret,
} from "./crypto.ts";
import { SendUnavailableError, Session } from "./session.ts";
import {
  buildShareLink,
  fragmentMatchesPath,
  parseRoute,
} from "./ui/routing.ts";
import { type CreateOptions, renderCreateView } from "./ui/create-view.ts";
import { renderShareView, type ShareView } from "./ui/share-view.ts";
import { renderChatView } from "./ui/chat-view.ts";
import { renderScreen } from "./ui/error-view.ts";
import {
  INVALID_LINK_SCREEN,
  NOT_FOUND_SCREEN,
  screenForEndReason,
} from "./ui/screens.ts";

const root = document.getElementById("app") as HTMLElement;
const signalingUrl = `${
  location.protocol === "https:" ? "wss:" : "ws:"
}//${location.host}/ws`;

/** Wire a started-or-starting Session to the chat UI. */
function runSession(
  session: Session,
  share?: { link: string; inviteWindowMs: number },
): void {
  const chat = renderChatView(root, {
    onSend: async (text) => {
      try {
        await session.sendChat(text);
        chat.addMessage({ text, direction: "sent", timestamp: Date.now() });
      } catch (error) {
        if (error instanceof SendUnavailableError) {
          // Void behavior (spec §5): never queued, never retried.
          chat.addSystemNote(
            "Message not sent — the other person is unreachable right now.",
          );
        } else {
          throw error;
        }
      }
    },
    onEnd: () => session.end(),
  });

  // Creator: share overlay on top of the (empty) chat until the peer joins.
  let shareView: ShareView | null = share ? renderShareView(root, share) : null;
  let hadSecure = false;

  session.on((event) => {
    switch (event.type) {
      case "status":
        if (
          shareView &&
          (event.status === "securing" || event.status === "secure")
        ) {
          shareView.destroy();
          shareView = null;
        }
        if (event.status === "securing") {
          chat.setStatus({ kind: "securing" });
          chat.setComposerEnabled(false);
        }
        break;
      case "secure":
        chat.setSafetyCode(event.safetyCode);
        chat.setStatus({ kind: "secure" });
        chat.setComposerEnabled(true);
        if (hadSecure) {
          // Spec §8.3: the code changes on every rekey — say so.
          chat.addSystemNote(
            "Reconnected. The safety code has changed — compare it again before sharing anything sensitive.",
          );
        }
        hadSecure = true;
        break;
      case "chat":
        chat.addMessage({
          text: event.text,
          direction: "received",
          timestamp: event.timestamp,
        });
        break;
      case "peer-identity":
        chat.setPeerName(event.displayName);
        break;
      case "grace-countdown":
        chat.setStatus({
          kind: "reconnecting",
          msRemaining: event.msRemaining,
        });
        chat.setComposerEnabled(false);
        break;
      case "ended":
        shareView?.destroy();
        shareView = null;
        chat.destroy();
        renderScreen(root, screenForEndReason(event.reason));
        break;
    }
  });
}

async function startCreator(opts: CreateOptions): Promise<void> {
  // Spec §2: both secrets are generated client-side; the fragment never
  // leaves the browser.
  const fragmentSecret = generateFragmentSecret();
  const fragment = bytesToBase64url(fragmentSecret);
  const pathToken = await derivePathToken(fragmentSecret);
  const link = buildShareLink(location.origin, pathToken, fragment);
  // So a reload/crash after pairing can rejoin via the same recovery path a
  // joiner already uses (the address bar otherwise never leaves "/").
  history.replaceState(null, "", link);

  const session = new Session({
    role: "creator",
    fragmentSecret,
    signalingUrl,
    displayName: opts.displayName,
    inviteWindowMs: opts.inviteWindowMs,
    graceDurationMs: opts.graceDurationMs,
  });
  runSession(session, { link, inviteWindowMs: opts.inviteWindowMs });
  await session.start();
}

async function startJoiner(pathToken: string, fragment: string): Promise<void> {
  // Spec §2: refuse before ANY network traffic if the fragment doesn't
  // re-derive the path token (catches mangled copy/paste).
  if (!(await fragmentMatchesPath(fragment, pathToken))) {
    renderScreen(root, INVALID_LINK_SCREEN);
    return;
  }
  const session = new Session({
    role: "joiner",
    fragmentSecret: base64urlToBytes(fragment),
    signalingUrl,
  });
  runSession(session);
  await session.start();
}

async function main(): Promise<void> {
  const route = parseRoute(location.pathname, location.hash);
  switch (route.view) {
    case "create":
      renderCreateView(root, {
        onCreate: (opts) => {
          startCreator(opts).catch((error) => console.error(error));
        },
      });
      break;
    case "join":
      await startJoiner(route.pathToken, route.fragment);
      break;
    case "invalid-link":
      renderScreen(root, INVALID_LINK_SCREEN);
      break;
    case "not-found":
      renderScreen(root, NOT_FOUND_SCREEN);
      break;
  }
}

main().catch((error) => console.error(error));

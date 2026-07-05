import type { EndReason } from "../session.ts";

/** A terminal page: error or ended state. Rendered by ui/error-view.ts. */
export interface Screen {
  title: string;
  body: string;
  /** Show the "Start a new chat" link back to `/`. */
  startNew: boolean;
}

const GONE = "The conversation is gone. Nothing was stored on any server.";

/** Map a session end reason to its terminal screen (spec §10.3, §10.5). */
export function screenForEndReason(reason: EndReason): Screen {
  switch (reason) {
    case "you-ended":
      return { title: "Chat ended", body: GONE, startNew: true };
    case "peer-ended":
      return {
        title: "The other person ended the chat",
        body: GONE,
        startNew: true,
      };
    case "grace-expired":
      return {
        title: "Connection lost",
        body: `The other person didn't reconnect in time. ${GONE}`,
        startNew: true,
      };
    case "invite-expired":
      return {
        title: "This link has expired",
        body: "No one joined within the invite window, so the room closed. " +
          "Nothing was stored. Create a fresh link to try again.",
        startNew: true,
      };
    case "creator-left":
      return {
        title: "This room is closed",
        body: "The person who created the link closed their tab before you " +
          "connected, so the room no longer exists. Nothing was stored.",
        startNew: true,
      };
    case "key-confirm-failed":
      return {
        title: "Secure connection failed",
        body: "Couldn't establish a secure connection — the link may have " +
          "been used by someone else.",
        startNew: true,
      };
    case "room-not-found":
      return {
        title: "This link isn't active",
        body: "It may have expired, already been used, or the chat may be " +
          "over. Nothing was stored.",
        startNew: true,
      };
    case "room-full":
      return {
        title: "This room is full",
        body: "Two people are already connected. A room only ever holds " +
          "two — if that's not you, treat the link as used.",
        startNew: true,
      };
    case "rate-limited":
      return {
        title: "Too many requests",
        body: "The server is rate-limiting your network right now. Wait a " +
          "minute and try again.",
        startNew: true,
      };
    case "signaling-lost":
      return {
        title: "Lost contact with the server",
        body: `The chat can't continue. ${GONE}`,
        startNew: true,
      };
    case "version-mismatch":
      return VERSION_MISMATCH_SCREEN;
  }
}

/** Fragment/path mismatch detected before any network call (spec §2). */
export const INVALID_LINK_SCREEN: Screen = {
  title: "This link looks damaged",
  body: "The link's secret doesn't match its address — it was probably " +
    "truncated or altered when it was copied. Ask the sender for the link " +
    "again and open it exactly as sent. No connection was attempted.",
  startNew: false,
};

export const NOT_FOUND_SCREEN: Screen = {
  title: "Page not found",
  body: "There's nothing at this address.",
  startNew: true,
};

/** Spec §7.4: a peer speaking an unknown protocol version. */
export const VERSION_MISMATCH_SCREEN: Screen = {
  title: "Update required",
  body: "The other person's app speaks a different protocol version. Both " +
    "of you should reload the page, then create a fresh link.",
  startNew: true,
};

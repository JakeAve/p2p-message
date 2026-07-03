import { assert, assertEquals } from "@std/assert";
import {
  INVALID_LINK_SCREEN,
  NOT_FOUND_SCREEN,
  screenForEndReason,
  VERSION_MISMATCH_SCREEN,
} from "./screens.ts";
import type { EndReason } from "../session.ts";

const ALL_REASONS: EndReason[] = [
  "you-ended",
  "peer-ended",
  "invite-expired",
  "grace-expired",
  "creator-left",
  "key-confirm-failed",
  "room-not-found",
  "room-full",
  "rate-limited",
  "signaling-lost",
  "version-mismatch",
];

Deno.test("every EndReason maps to a screen with title, body, and a start-new link", () => {
  for (const reason of ALL_REASONS) {
    const screen = screenForEndReason(reason);
    assert(screen.title.length > 0, `${reason} needs a title`);
    assert(screen.body.length > 0, `${reason} needs a body`);
    assertEquals(screen.startNew, true, `${reason} should offer a fresh start`);
  }
});

Deno.test("key-confirm failure uses the pinned copy verbatim (C7)", () => {
  assertEquals(
    screenForEndReason("key-confirm-failed").body,
    "Couldn't establish a secure connection — the link may have been used by someone else.",
  );
});

Deno.test("terminal ended screens state the conversation is gone and nothing was stored", () => {
  for (const reason of ["you-ended", "peer-ended", "grace-expired"] as const) {
    const body = screenForEndReason(reason).body;
    assert(body.includes("gone"), `${reason}: ${body}`);
    assert(body.includes("Nothing was stored"), `${reason}: ${body}`);
  }
});

Deno.test("distinct screens for room-not-found and room-full", () => {
  const notFound = screenForEndReason("room-not-found");
  const full = screenForEndReason("room-full");
  assert(notFound.title !== full.title);
  assert(notFound.body !== full.body);
});

Deno.test("standalone screens exist and never auto-retry the same link", () => {
  assert(INVALID_LINK_SCREEN.title.length > 0);
  assertEquals(INVALID_LINK_SCREEN.startNew, false); // a damaged link needs re-sending, not a new chat
  assert(NOT_FOUND_SCREEN.title.length > 0);
  assert(VERSION_MISMATCH_SCREEN.title.length > 0);
});

import { assertEquals } from "@std/assert";
import {
  TYPING_FAILSAFE_MS,
  TYPING_REFRESH_MS,
  TypingSender,
  TypingTracker,
} from "./typing.ts";
import { ManualTimers } from "../test-fakes.ts";

function makeSender() {
  const timers = new ManualTimers();
  const sent: boolean[] = [];
  const sender = new TypingSender(
    timers,
    (active: boolean) => sent.push(active),
  );
  return { timers, sent, sender };
}

Deno.test("TypingSender: first keystroke sends true; repeats within the refresh window don't", async () => {
  const { timers, sent, sender } = makeSender();
  sender.update(true);
  sender.update(true);
  await timers.tick(TYPING_REFRESH_MS - 1);
  sender.update(true);
  assertEquals(sent, [true]);
});

Deno.test("TypingSender: continued typing re-sends true every TYPING_REFRESH_MS", async () => {
  const { timers, sent, sender } = makeSender();
  sender.update(true);
  await timers.tick(TYPING_REFRESH_MS);
  sender.update(true);
  await timers.tick(TYPING_REFRESH_MS);
  sender.update(true);
  assertEquals(sent, [true, true, true]);
});

Deno.test("TypingSender: emptying sends false once; re-typing sends true immediately", () => {
  const { sent, sender } = makeSender();
  sender.update(true);
  sender.update(false);
  sender.update(false); // already inactive: no duplicate false
  sender.update(true); // fresh burst: true right away, no throttle carryover
  assertEquals(sent, [true, false, true]);
});

Deno.test("TypingSender: empty composer sends nothing when never active", () => {
  const { sent, sender } = makeSender();
  sender.update(false);
  assertEquals(sent, []);
});

function makeTracker() {
  const timers = new ManualTimers();
  const changes: boolean[] = [];
  const tracker = new TypingTracker(
    timers,
    (visible: boolean) => changes.push(visible),
  );
  return { timers, changes, tracker };
}

Deno.test("TypingTracker: shows once per appearance — repeats only restart the failsafe", async () => {
  const { timers, changes, tracker } = makeTracker();
  tracker.signal(true);
  await timers.tick(TYPING_FAILSAFE_MS - 1_000);
  tracker.signal(true); // refresh arrives before expiry
  await timers.tick(TYPING_FAILSAFE_MS - 1_000); // original deadline passes; refreshed one hasn't
  assertEquals(changes, [true]); // still visible, announced exactly once
});

Deno.test("TypingTracker: hides after TYPING_FAILSAFE_MS without a refresh", async () => {
  const { timers, changes, tracker } = makeTracker();
  tracker.signal(true);
  await timers.tick(TYPING_FAILSAFE_MS);
  assertEquals(changes, [true, false]);
});

Deno.test("TypingTracker: explicit stop and hide() cancel the failsafe cleanly", async () => {
  const { timers, changes, tracker } = makeTracker();
  tracker.signal(true);
  tracker.signal(false);
  await timers.tick(TYPING_FAILSAFE_MS * 2); // stale timer must not re-fire
  tracker.hide(); // already hidden: no duplicate false
  assertEquals(changes, [true, false]);
});

// client/session_test.ts
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  DEFAULT_GRACE_MS,
  DEFAULT_INVITE_WINDOW_MS,
  SendUnavailableError,
  Session,
  type SessionEvent,
} from "./session.ts";
import { derivePathToken, generateFragmentSecret } from "./crypto.ts";
import { FakeTransport, flushAsync, ManualTimers } from "./test-fakes.ts";

function collect(session: Session): SessionEvent[] {
  const events: SessionEvent[] = [];
  session.on((e) => events.push(e));
  return events;
}

export function waitForEvent<T extends SessionEvent["type"]>(
  session: Session,
  type: T,
  timeoutMs = 2000,
): Promise<Extract<SessionEvent, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out waiting for "${type}" event`));
    }, timeoutMs);
    const unsub = session.on((e) => {
      if (e.type === type) {
        clearTimeout(timer);
        unsub();
        resolve(e as Extract<SessionEvent, { type: T }>);
      }
    });
  });
}

function makeCreator(
  transport = new FakeTransport(),
  timers = new ManualTimers(),
) {
  const fragmentSecret = generateFragmentSecret();
  const session = new Session(
    { role: "creator", fragmentSecret, signalingUrl: "ws://x.test/ws" },
    { transport, timers },
  );
  return { session, transport, timers, fragmentSecret };
}

function makeJoiner(
  transport = new FakeTransport(),
  timers = new ManualTimers(),
) {
  const fragmentSecret = generateFragmentSecret();
  const session = new Session(
    { role: "joiner", fragmentSecret, signalingUrl: "ws://x.test/ws" },
    { transport, timers },
  );
  return { session, transport, timers, fragmentSecret };
}

Deno.test("status is connecting before start()", () => {
  const { session } = makeCreator();
  assertEquals(session.status, "connecting");
});

Deno.test("creator start(): derives path token, creates room with defaults, waits for peer", async () => {
  const { session, transport, fragmentSecret } = makeCreator();
  const events = collect(session);
  await session.start();
  const token = await derivePathToken(fragmentSecret);
  assertEquals(token.length, 22);
  assertEquals(transport.calls[0], "connect");
  assertEquals(
    transport.calls[1],
    `create:${token}:${DEFAULT_INVITE_WINDOW_MS}:${DEFAULT_GRACE_MS}`,
  );
  assertEquals(session.status, "waiting-for-peer");
  assertEquals(events, [{ type: "status", status: "waiting-for-peer" }]);
});

Deno.test("creator start() passes custom inviteWindowMs/graceDurationMs through", async () => {
  const transport = new FakeTransport();
  const fragmentSecret = generateFragmentSecret();
  const session = new Session(
    {
      role: "creator",
      fragmentSecret,
      signalingUrl: "ws://x.test/ws",
      inviteWindowMs: 1_800_000,
      graceDurationMs: 600_000,
    },
    { transport, timers: new ManualTimers() },
  );
  await session.start();
  const token = await derivePathToken(fragmentSecret);
  assertEquals(transport.calls[1], `create:${token}:1800000:600000`);
});

Deno.test("joiner start(): joins the derived room and resolves on joined ack", async () => {
  const { session, transport, fragmentSecret } = makeJoiner();
  await session.start();
  const token = await derivePathToken(fragmentSecret);
  assertEquals(transport.calls, ["connect", `join:${token}`]);
  assertEquals(session.status, "connecting"); // securing only once the DataChannel opens
});

Deno.test("start() may only be called once", async () => {
  const { session } = makeCreator();
  await session.start();
  await assertRejects(() => session.start());
});

Deno.test("join errors map to EndReasons: room-not-found / room-full / rate-limited", async () => {
  for (
    const [code, reason] of [
      ["room-not-found", "room-not-found"],
      ["room-full", "room-full"],
      ["rate-limited", "rate-limited"],
    ] as const
  ) {
    const transport = new FakeTransport();
    transport.respondToJoin = [{ type: "server-error", code }];
    const { session } = makeJoiner(transport);
    const events = collect(session);
    await assertRejects(() => session.start());
    assertEquals(session.status, "ended");
    assert(
      events.some((e) => e.type === "ended" && e.reason === reason),
      `expected ended:${reason} for error:${code}`,
    );
  }
});

Deno.test("room-closed while waiting maps 1:1 to EndReason", async () => {
  const { session, transport } = makeCreator();
  const events = collect(session);
  await session.start();
  transport.emit({ type: "room-closed", reason: "invite-expired" });
  await flushAsync();
  assertEquals(session.status, "ended");
  assert(
    events.some((e) => e.type === "ended" && e.reason === "invite-expired"),
  );
});

Deno.test("signaling loss while waiting-for-peer ends with signaling-lost", async () => {
  const { session, transport } = makeCreator();
  const events = collect(session);
  await session.start();
  transport.emit({ type: "signaling-lost" });
  await flushAsync();
  assert(
    events.some((e) => e.type === "ended" && e.reason === "signaling-lost"),
  );
});

Deno.test("sendChat throws SendUnavailableError unless status is secure — and nothing is queued", async () => {
  const { session, transport } = makeCreator();
  await session.start();
  await assertRejects(() => session.sendChat("hello"), SendUnavailableError);
  assertEquals(transport.sentData, []); // void behavior: never buffered anywhere
});

Deno.test("end() before secure: leave + local ended you-ended, no payload sent", async () => {
  const { session, transport } = makeCreator();
  const events = collect(session);
  await session.start();
  session.end();
  assertEquals(session.status, "ended");
  assert(events.some((e) => e.type === "ended" && e.reason === "you-ended"));
  await flushAsync();
  assert(transport.calls.includes("leave"));
  assert(transport.calls.includes("close"));
  assertEquals(transport.sentData, []);
});

Deno.test("events after ended are ignored", async () => {
  const { session, transport } = makeCreator();
  const events = collect(session);
  await session.start();
  session.end();
  transport.emit({ type: "room-closed", reason: "creator-left" });
  await flushAsync();
  const endedEvents = events.filter((e) => e.type === "ended");
  assertEquals(endedEvents, [{ type: "ended", reason: "you-ended" }]);
});

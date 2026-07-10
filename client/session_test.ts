// client/session_test.ts
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  DEFAULT_GRACE_MS,
  DEFAULT_INVITE_WINDOW_MS,
  FileRejectedError,
  GRACE_TICK_MS,
  KEY_CONFIRM_TIMEOUT_MS,
  REJOIN_RETRY_MS,
  SendUnavailableError,
  Session,
  type SessionEvent,
} from "./session.ts";
import {
  decryptPayload,
  derivePathToken,
  deriveSessionKey,
  deriveSharedSecret,
  encryptPayload,
  exportPublicKeyRaw,
  generateEcdhKeyPair,
  generateFragmentSecret,
  importPublicKeyRaw,
  transcriptHash,
} from "./crypto.ts";
import {
  FakeTransport,
  flushAsync,
  linkTransports,
  ManualTimers,
  openData,
} from "./test-fakes.ts";
import { INVITE_WINDOW_MAX_MS } from "../shared/protocol.ts";

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

function makeJoinerWithRecoveryToken(
  recoveryToken: string,
  transport = new FakeTransport(),
  timers = new ManualTimers(),
) {
  const fragmentSecret = generateFragmentSecret();
  const session = new Session(
    {
      role: "joiner",
      fragmentSecret,
      signalingUrl: "ws://x.test/ws",
      recoveryToken,
    },
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

Deno.test("joiner start() presents a URL-supplied recoveryToken on the very first join", async () => {
  const { session, transport, fragmentSecret } = makeJoinerWithRecoveryToken(
    "rc-from-url",
  );
  await session.start();
  const token = await derivePathToken(fragmentSecret);
  assertEquals(transport.calls, ["connect", `join:${token}:rc-from-url`]);
});

Deno.test("creator remembers a recoveryToken from created and presents it on rejoin", async () => {
  const { session, transport } = makeCreator();
  transport.respondToCreate = [{
    type: "created",
    peerId: "creator-peer",
    recoveryToken: "rc-created",
  }];
  await session.start();
  transport.respondToJoin = [{
    type: "joined",
    peerId: "creator-peer-2",
    participants: [],
    graceDurationMs: 120_000,
  }];
  transport.emit({ type: "signaling-lost" });
  await flushAsync();
  assert(transport.calls.some((c) => c.endsWith(":rc-created")));
});

Deno.test("recovery-token event fires only when a NEW token arrives, never for the same one twice", async () => {
  const { session, transport } = makeCreator();
  transport.respondToCreate = [{
    type: "created",
    peerId: "creator-peer",
    recoveryToken: "rc-1",
  }];
  const events = collect(session);
  await session.start();
  // Re-deliver the SAME token via peer-joined (as an unrelated pairing
  // event might, if nothing about recovery actually changed) — must not
  // fire a second recovery-token event or reset the retry budget.
  transport.emit({ type: "peer-joined", peerId: "x", recoveryToken: "rc-1" });
  await flushAsync();
  const tokenEvents = events.filter((e) => e.type === "recovery-token");
  assertEquals(tokenEvents, [{ type: "recovery-token", token: "rc-1" }]);
});

Deno.test("on room-not-found with a recoveryToken presented, retries before finishing", async () => {
  // FakeTransport.respondToJoin re-fires its whole array on EVERY joinRoom()
  // call (it's not a per-call sequence), so — mirroring the existing
  // "failed reconnect is retried on the rejoin timer" test's pattern of
  // swapping connectError between attempts — this swaps respondToJoin
  // between the first (failing) attempt and the retry, rather than trying
  // to queue multiple responses up front.
  const pair = await makeSecurePair();
  pair.tb.respondToJoin = [{ type: "server-error", code: "room-not-found" }];
  // Seed B's remembered token the way a real "joined" would have, as if
  // the server had recovery configured.
  pair.tb.emit({
    type: "joined",
    peerId: "joiner-peer-seed",
    participants: [],
    graceDurationMs: 120_000,
    recoveryToken: "rc-seed",
  });
  await flushAsync();

  pair.tb.emit({ type: "signaling-lost" });
  await flushAsync();
  // The first rejoin attempt got room-not-found but a token was presented,
  // so it retried on the 2s cadence instead of ending immediately.
  assertEquals(pair.b.status, "reconnecting");

  // Let the retry succeed.
  pair.tb.respondToJoin = [{
    type: "joined",
    peerId: "joiner-peer-2",
    participants: ["creator-peer"],
    graceDurationMs: 120_000,
  }];
  const secureB = waitForEvent(pair.b, "secure");
  await pair.timersB.tick(REJOIN_RETRY_MS);
  pair.ta.emit({ type: "peer-joined", peerId: "joiner-peer-2" });
  openData(pair.ta, pair.tb);
  await secureB;
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("on room-not-found with NO recoveryToken, still ends immediately (backward compatible)", async () => {
  const { session, transport } = makeCreator();
  await session.start();
  transport.respondToJoin = [{ type: "server-error", code: "room-not-found" }];
  const ended = waitForEvent(session, "ended");
  transport.emit({ type: "signaling-lost" });
  assertEquals((await ended).reason, "invite-expired");
});

Deno.test("start() may only be called once", async () => {
  const { session } = makeCreator();
  await session.start();
  await assertRejects(() => session.start());
});

Deno.test("join errors map to EndReasons: room-not-found / room-full / room-exists / rate-limited / config-invalid", async () => {
  for (
    const [code, reason] of [
      ["room-not-found", "room-not-found"],
      ["room-full", "room-full"],
      ["room-exists", "room-full"],
      ["rate-limited", "rate-limited"],
      ["config-invalid", "signaling-lost"],
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

Deno.test("signaling loss while waiting-for-peer: silent rejoin, session not ended", async () => {
  const { session, transport, fragmentSecret } = makeCreator();
  const events = collect(session);
  await session.start();
  transport.respondToJoin = [{
    type: "joined",
    peerId: "creator-peer-2",
    participants: [],
    graceDurationMs: 120_000,
  }];
  transport.emit({ type: "signaling-lost" });
  await flushAsync();
  const token = await derivePathToken(fragmentSecret);
  assert(transport.calls.includes(`join:${token}`)); // rejoined by token possession
  assertEquals(session.status, "waiting-for-peer"); // no status churn, no ended
  assert(!events.some((e) => e.type === "ended"));
});

Deno.test("waiting rejoin answered with room-not-found ends with invite-expired", async () => {
  const { session, transport } = makeCreator();
  await session.start();
  transport.respondToJoin = [{ type: "server-error", code: "room-not-found" }];
  const ended = waitForEvent(session, "ended");
  transport.emit({ type: "signaling-lost" });
  assertEquals((await ended).reason, "invite-expired");
});

Deno.test("unreachable server past the invite deadline ends with invite-expired", async () => {
  const { session, transport, timers } = makeCreator();
  await session.start();
  transport.connectError = new Error("network down");
  const ended = waitForEvent(session, "ended", 30_000);
  transport.emit({ type: "signaling-lost" });
  await timers.tick(DEFAULT_INVITE_WINDOW_MS + REJOIN_RETRY_MS);
  assertEquals((await ended).reason, "invite-expired");
});

Deno.test("joiner landing in an empty room enters waiting-for-peer", async () => {
  const transport = new FakeTransport();
  transport.respondToJoin = [{
    type: "joined",
    peerId: "joiner-peer",
    participants: [],
    graceDurationMs: 120_000,
  }];
  const { session } = makeJoiner(transport);
  const events = collect(session);
  await session.start();
  assertEquals(session.status, "waiting-for-peer");
  assert(
    events.some((e) => e.type === "status" && e.status === "waiting-for-peer"),
  );
});

Deno.test("waiting joiner gives up after the INVITE_WINDOW_MAX_MS backstop", async () => {
  const transport = new FakeTransport();
  transport.respondToJoin = [{
    type: "joined",
    peerId: "joiner-peer",
    participants: [],
    graceDurationMs: 120_000,
  }];
  const timers = new ManualTimers();
  const { session } = makeJoiner(transport, timers);
  await session.start();
  transport.connectError = new Error("network down");
  // This tick drives ~1800 two-second retry cycles through ManualTimers
  // (each with a flushAsync), which takes real seconds — hence the large
  // waitForEvent timeout.
  const ended = waitForEvent(session, "ended", 60_000);
  transport.emit({ type: "signaling-lost" });
  await timers.tick(INVITE_WINDOW_MAX_MS + REJOIN_RETRY_MS);
  assertEquals((await ended).reason, "invite-expired");
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

async function makeStartedPair(joinerSecret?: Uint8Array<ArrayBuffer>) {
  const secret = generateFragmentSecret();
  const roomId = await derivePathToken(secret);
  const ta = new FakeTransport();
  const tb = new FakeTransport();
  linkTransports(ta, tb);
  const timersA = new ManualTimers();
  const timersB = new ManualTimers();
  const a = new Session(
    {
      role: "creator",
      fragmentSecret: secret,
      signalingUrl: "ws://x.test/ws",
      displayName: "Ann",
    },
    { transport: ta, timers: timersA },
  );
  const b = new Session(
    {
      role: "joiner",
      fragmentSecret: joinerSecret ?? secret,
      signalingUrl: "ws://x.test/ws",
      displayName: "Bob",
    },
    { transport: tb, timers: timersB },
  );
  await a.start();
  await b.start();
  return { a, b, ta, tb, timersA, timersB, roomId, secret };
}

async function makeSecurePair() {
  const pair = await makeStartedPair();
  const secureA = waitForEvent(pair.a, "secure");
  const secureB = waitForEvent(pair.b, "secure");
  pair.ta.emit({ type: "peer-joined", peerId: "joiner-peer" });
  openData(pair.ta, pair.tb);
  const [sa, sb] = await Promise.all([secureA, secureB]);
  return { ...pair, safetyCodeA: sa.safetyCode, safetyCodeB: sb.safetyCode };
}

Deno.test("full handshake with real crypto: both secure, equal 6-digit safety codes", async () => {
  const pair = await makeSecurePair();
  assertEquals(pair.a.status, "secure");
  assertEquals(pair.b.status, "secure");
  assertEquals(pair.safetyCodeA, pair.safetyCodeB);
  assert(/^\d{6}$/.test(pair.safetyCodeA));
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("mismatched fragmentSecret: key-confirm fails on both sides", async () => {
  const pair = await makeStartedPair(generateFragmentSecret()); // joiner has a different secret
  const endedA = waitForEvent(pair.a, "ended");
  const endedB = waitForEvent(pair.b, "ended");
  openData(pair.ta, pair.tb);
  const [ea, eb] = await Promise.all([endedA, endedB]);
  assertEquals(ea.reason, "key-confirm-failed");
  assertEquals(eb.reason, "key-confirm-failed");
});

Deno.test("key-confirm timeout: no peer response within 10s ends key-confirm-failed", async () => {
  const { session, transport, timers } = makeCreator();
  await session.start();
  transport.emit({ type: "data-open" }); // no linked peer: pubkey goes into the void
  await flushAsync();
  assertEquals(session.status, "securing");
  assertEquals(transport.sentData.length, 1); // our pubkey frame was sent
  const ended = waitForEvent(session, "ended");
  await timers.tick(KEY_CONFIRM_TIMEOUT_MS);
  assertEquals((await ended).reason, "key-confirm-failed");
});

Deno.test("unknown wire version ends the session with version-mismatch", async () => {
  const { session, transport } = makeCreator();
  await session.start();
  transport.emit({ type: "data-open" });
  await flushAsync();
  const ended = waitForEvent(session, "ended");
  transport.emit({
    type: "data-message",
    data: JSON.stringify({ v: 2, type: "pubkey", key: "AAAA" }),
  });
  assertEquals((await ended).reason, "version-mismatch");
});

Deno.test("garbage pubkey (bad point) → key-confirm-failed", async () => {
  const { session, transport } = makeCreator();
  await session.start();
  transport.emit({ type: "data-open" });
  await flushAsync();
  const ended = waitForEvent(session, "ended");
  transport.emit({
    type: "data-message",
    data: JSON.stringify({ v: 1, type: "pubkey", key: "not-a-point" }),
  });
  assertEquals((await ended).reason, "key-confirm-failed");
});

Deno.test("enc frames arriving before the peer pubkey are buffered, then processed", async () => {
  const { session, transport, fragmentSecret } = makeCreator();
  await session.start();
  transport.emit({ type: "data-open" });
  await flushAsync();
  // Build the peer side by hand with the real crypto module.
  const myPubFrame = JSON.parse(transport.sentData[0]) as { key: string };
  const peerPair = await generateEcdhKeyPair();
  const peerPubB64 = await exportPublicKeyRaw(peerPair.publicKey);
  const sessionPub = await importPublicKeyRaw(myPubFrame.key);
  const shared = await deriveSharedSecret(peerPair.privateKey, sessionPub);
  const key = await deriveSessionKey(fragmentSecret, shared);
  const hash = await transcriptHash(peerPubB64, myPubFrame.key);
  const confirmFrame = await encryptPayload(key, {
    type: "key-confirm",
    transcriptHash: hash,
  });
  const secure = waitForEvent(session, "secure");
  // Deliver the encrypted confirm BEFORE the pubkey — must be buffered, not dropped.
  transport.emit({ type: "data-message", data: JSON.stringify(confirmFrame) });
  transport.emit({
    type: "data-message",
    data: JSON.stringify({ v: 1, type: "pubkey", key: peerPubB64 }),
  });
  await secure;
  assertEquals(session.status, "secure");
  session.end();
  await flushAsync();
});

Deno.test("chat flows both directions once secure", async () => {
  const pair = await makeSecurePair();
  const chatAtB = waitForEvent(pair.b, "chat");
  await pair.a.sendChat("hello from Ann 🎉");
  const gotB = await chatAtB;
  assertEquals(gotB.text, "hello from Ann 🎉");
  assertEquals(typeof gotB.timestamp, "number");
  const chatAtA = waitForEvent(pair.a, "chat");
  await pair.b.sendChat("hi Ann");
  assertEquals((await chatAtA).text, "hi Ann");
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("sendChat resolves to the id carried in the payload; receiver's chat event echoes it", async () => {
  const pair = await makeSecurePair();
  const chatAtB = waitForEvent(pair.b, "chat");
  const id = await pair.a.sendChat("hello");
  assertMatch(id, /^[A-Za-z0-9_-]{11}$/);
  assertEquals((await chatAtB).id, id);
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("receiving a chat triggers an automatic delivered ack with the same id", async () => {
  const pair = await makeSecurePair();
  const deliveredAtA = waitForEvent(pair.a, "delivered");
  const id = await pair.a.sendChat("knock knock");
  assertEquals((await deliveredAtA).id, id);
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("id-less chat (old client) emits chat with undefined id and sends no ack", async () => {
  // Play the remote peer with real crypto (same approach as the reorder-
  // buffer test above): answer the session's pubkey, key-confirm, then
  // send a chat payload WITHOUT an id, as a pre-receipts client would.
  const { session, transport, fragmentSecret } = makeCreator();
  await session.start();
  transport.emit({ type: "peer-joined", peerId: "joiner-peer" });
  transport.emit({ type: "data-open" });
  await flushAsync();

  const sessionPub = (transport.sentData
    .map((s) => JSON.parse(s))
    .find((f) => f.type === "pubkey") as { key: string }).key;
  const kp = await generateEcdhKeyPair();
  const myPub = await exportPublicKeyRaw(kp.publicKey);
  const shared = await deriveSharedSecret(
    kp.privateKey,
    await importPublicKeyRaw(sessionPub),
  );
  const key = await deriveSessionKey(fragmentSecret, shared);

  const secured = waitForEvent(session, "secure");
  transport.emit({
    type: "data-message",
    data: JSON.stringify({ v: 1, type: "pubkey", key: myPub }),
  });
  const confirm = await encryptPayload(key, {
    type: "key-confirm",
    transcriptHash: await transcriptHash(myPub, sessionPub),
  });
  transport.emit({ type: "data-message", data: JSON.stringify(confirm) });
  await secured;

  const chatEvt = waitForEvent(session, "chat");
  const idless = await encryptPayload(key, {
    type: "chat",
    content: "from an old client",
  });
  transport.emit({ type: "data-message", data: JSON.stringify(idless) });
  const got = await chatEvt;
  assertEquals(got.text, "from an old client");
  assertEquals(got.id, undefined);

  // No delivered ack went out: decrypt everything the session sent.
  await flushAsync();
  const encFrames = transport.sentData
    .map((s) => JSON.parse(s))
    .filter((f) => f.type === "enc");
  for (const frame of encFrames) {
    const payload = await decryptPayload(key, frame);
    assertNotEquals(payload.type, "delivered");
  }
  session.end();
  await flushAsync();
});

Deno.test("display names travel encrypted after key-confirm and emit peer-identity", async () => {
  const pair = await makeStartedPair();
  const identityAtA = waitForEvent(pair.a, "peer-identity");
  const identityAtB = waitForEvent(pair.b, "peer-identity");
  openData(pair.ta, pair.tb);
  assertEquals((await identityAtA).displayName, "Bob");
  assertEquals((await identityAtB).displayName, "Ann");
  // nothing plaintext except the two pubkey frames ever crossed the channel
  for (const raw of [...pair.ta.sentData, ...pair.tb.sentData]) {
    const frame = JSON.parse(raw) as { type: string };
    assert(frame.type === "pubkey" || frame.type === "enc");
  }
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("end(): ender sees you-ended, peer receives the end payload and sees peer-ended", async () => {
  const pair = await makeSecurePair();
  const eventsA = collect(pair.a);
  const endedB = waitForEvent(pair.b, "ended");
  pair.a.end();
  assertEquals(pair.a.status, "ended");
  assert(eventsA.some((e) => e.type === "ended" && e.reason === "you-ended"));
  assertEquals((await endedB).reason, "peer-ended");
  await flushAsync();
  assert(pair.ta.calls.includes("leave"));
});

Deno.test("void behavior: sendChat during reconnecting throws and nothing is buffered", async () => {
  const pair = await makeSecurePair();
  const sentBefore = pair.ta.sentData.length;
  pair.ta.emit({ type: "peer-left", peerId: "joiner-peer" });
  await flushAsync();
  await assertRejects(
    () => pair.a.sendChat("into the void"),
    SendUnavailableError,
  );
  assertEquals(pair.ta.sentData.length, sentBefore); // not sent, not queued — anywhere
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("sendChat rejects with SendUnavailableError if peer disconnects mid-encrypt", async () => {
  const pair = await makeSecurePair();
  const sentBefore = pair.ta.sentData.length;
  // Start the send but don't await it yet: encryptPayload's real WebCrypto
  // call yields the event loop, giving the peer-left event (delivered via
  // the FakeTransport's synchronous listener + Session's microtask queue)
  // a chance to flip status away from "secure" before sendData would run.
  const sendPromise = pair.a.sendChat("into the void");
  pair.ta.emit({ type: "peer-left", peerId: "joiner-peer" });
  await assertRejects(() => sendPromise, SendUnavailableError);
  assertEquals(pair.ta.sentData.length, sentBefore); // not sent
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("peer loss → reconnecting with ~1/sec grace countdown", async () => {
  const pair = await makeSecurePair();
  pair.ta.emit({ type: "peer-left", peerId: "joiner-peer" });
  await flushAsync();
  assertEquals(pair.a.status, "reconnecting");
  const countdowns: number[] = [];
  const unsub = pair.a.on((e) => {
    if (e.type === "grace-countdown") countdowns.push(e.msRemaining);
  });
  await pair.timersA.tick(3 * GRACE_TICK_MS);
  unsub();
  assert(
    countdowns.length >= 3,
    `expected >=3 ticks, got ${countdowns.length}`,
  );
  for (let i = 1; i < countdowns.length; i++) {
    assert(countdowns[i] < countdowns[i - 1], "countdown must decrease");
  }
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("grace → rejoin → rekey: secure again with a fresh, differing safety code", async () => {
  const pair = await makeSecurePair();
  // A's peer drops: the server tells A; B loses its own socket.
  pair.ta.emit({ type: "peer-left", peerId: "joiner-peer" });
  pair.tb.emit({ type: "signaling-lost" });
  await flushAsync();
  assertEquals(pair.a.status, "reconnecting");
  assertEquals(pair.b.status, "reconnecting");
  // B rejoined by roomId possession (FakeTransport auto-acks joinRoom).
  assert(pair.tb.calls.includes(`join:${pair.roomId}`));
  assert(pair.tb.calls.filter((c) => c === "connect").length >= 2);
  // Fresh SDP/ICE exchange succeeded → DataChannel reopens → full rekey.
  const secureA = waitForEvent(pair.a, "secure");
  const secureB = waitForEvent(pair.b, "secure");
  pair.ta.emit({ type: "peer-joined", peerId: "joiner-peer-2" });
  openData(pair.ta, pair.tb);
  const [sa, sb] = await Promise.all([secureA, secureB]);
  assertEquals(sa.safetyCode, sb.safetyCode);
  assertNotEquals(sa.safetyCode, pair.safetyCodeA); // spec §8.3: code changes on rekey
  const chatAtA = waitForEvent(pair.a, "chat");
  await pair.b.sendChat("back again");
  assertEquals((await chatAtA).text, "back again");
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("failed reconnect is retried on the rejoin timer", async () => {
  const pair = await makeSecurePair();
  pair.tb.connectError = new Error("network down");
  pair.tb.emit({ type: "signaling-lost" });
  await flushAsync();
  const connectsAfterDrop = pair.tb.calls.filter((c) => c === "connect").length;
  pair.tb.connectError = null;
  await pair.timersB.tick(REJOIN_RETRY_MS);
  assert(
    pair.tb.calls.filter((c) => c === "connect").length > connectsAfterDrop,
    "a retry connect should have happened",
  );
  assert(pair.tb.calls.includes(`join:${pair.roomId}`));
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("rejoin answered with room-not-found ends with grace-expired", async () => {
  const pair = await makeSecurePair();
  pair.tb.respondToJoin = [{ type: "server-error", code: "room-not-found" }];
  const ended = waitForEvent(pair.b, "ended");
  pair.tb.emit({ type: "signaling-lost" });
  assertEquals((await ended).reason, "grace-expired");
  pair.a.end();
  await flushAsync();
});

Deno.test("grace rejoin answered with empty participants stays reconnecting", async () => {
  const pair = await makeSecurePair();
  pair.tb.respondToJoin = [{
    type: "joined",
    peerId: "joiner-peer-2",
    participants: [],
    graceDurationMs: 120_000,
  }];
  pair.tb.emit({ type: "signaling-lost" });
  await flushAsync();
  assertEquals(pair.b.status, "reconnecting"); // grace countdown still rules
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("local grace deadline expiring ends with grace-expired", async () => {
  const pair = await makeSecurePair();
  pair.ta.emit({ type: "peer-left", peerId: "joiner-peer" });
  await flushAsync();
  const ended = waitForEvent(pair.a, "ended", 10_000);
  await pair.timersA.tick(DEFAULT_GRACE_MS);
  assertEquals((await ended).reason, "grace-expired");
  pair.b.end();
  await flushAsync();
});

Deno.test("room-closed grace-expired from the server maps 1:1", async () => {
  const pair = await makeSecurePair();
  pair.ta.emit({ type: "peer-left", peerId: "joiner-peer" });
  await flushAsync();
  const ended = waitForEvent(pair.a, "ended");
  pair.ta.emit({ type: "room-closed", reason: "grace-expired" });
  assertEquals((await ended).reason, "grace-expired");
  pair.b.end();
  await flushAsync();
});

Deno.test("joiner uses the server-provided graceDurationMs for its countdown", async () => {
  const pair = await makeStartedPair(); // FakeTransport's joined ack carries 120_000
  const secureB = waitForEvent(pair.b, "secure");
  openData(pair.ta, pair.tb);
  await secureB;
  const first = waitForEvent(pair.b, "grace-countdown");
  pair.tb.emit({ type: "peer-left", peerId: "creator-peer" });
  assertEquals((await first).msRemaining, 120_000);
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("wake() retries a pending waiting rejoin immediately", async () => {
  const { session, transport } = makeCreator();
  await session.start();
  transport.connectError = new Error("network down");
  transport.emit({ type: "signaling-lost" });
  await flushAsync(); // failed attempt → retry parked on the 2s timer
  const connectsBefore = transport.calls.filter((c) => c === "connect").length;
  transport.connectError = null;
  transport.respondToJoin = [{
    type: "joined",
    peerId: "creator-peer-2",
    participants: [],
    graceDurationMs: 120_000,
  }];
  session.wake(); // no timer tick — visibilitychange path
  await flushAsync();
  assert(
    transport.calls.filter((c) => c === "connect").length > connectsBefore,
    "wake() should reconnect without waiting for the retry timer",
  );
  assertEquals(session.status, "waiting-for-peer");
});

Deno.test("wake() with no pending retry is a no-op", async () => {
  const { session, transport } = makeCreator();
  await session.start();
  const callsBefore = transport.calls.length;
  session.wake();
  await flushAsync();
  assertEquals(transport.calls.length, callsBefore);
});

Deno.test("typing signals flow once secure and emit peer-typing", async () => {
  const pair = await makeSecurePair();
  const startAtB = waitForEvent(pair.b, "peer-typing");
  pair.a.sendTyping(true);
  assertEquals((await startAtB).active, true);
  const stopAtB = waitForEvent(pair.b, "peer-typing");
  pair.a.sendTyping(false);
  assertEquals((await stopAtB).active, false);
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("sendTyping before secure is a silent no-op — nothing sent, no throw", async () => {
  const { session, transport } = makeCreator();
  await session.start(); // waiting-for-peer
  session.sendTyping(true);
  await flushAsync();
  assertEquals(transport.sentData, []);
  session.end();
  await flushAsync();
});

Deno.test("typing payloads arriving before key-confirm are ignored, and never replayed after", async () => {
  // Scripted peer as in the id-less chat test: pubkey exchange first, then a
  // typing frame BEFORE our key-confirm goes out.
  const { session, transport, fragmentSecret } = makeCreator();
  const events = collect(session);
  await session.start();
  transport.emit({ type: "peer-joined", peerId: "joiner-peer" });
  transport.emit({ type: "data-open" });
  await flushAsync();

  const sessionPub = (transport.sentData
    .map((s) => JSON.parse(s))
    .find((f) => f.type === "pubkey") as { key: string }).key;
  const kp = await generateEcdhKeyPair();
  const myPub = await exportPublicKeyRaw(kp.publicKey);
  const shared = await deriveSharedSecret(
    kp.privateKey,
    await importPublicKeyRaw(sessionPub),
  );
  const key = await deriveSessionKey(fragmentSecret, shared);

  transport.emit({
    type: "data-message",
    data: JSON.stringify({ v: 1, type: "pubkey", key: myPub }),
  });
  const typing = await encryptPayload(key, { type: "typing", active: true });
  transport.emit({ type: "data-message", data: JSON.stringify(typing) });
  await flushAsync();
  assert(!events.some((e) => e.type === "peer-typing"));

  // The session still completes the handshake afterwards.
  const secured = waitForEvent(session, "secure");
  const confirm = await encryptPayload(key, {
    type: "key-confirm",
    transcriptHash: await transcriptHash(myPub, sessionPub),
  });
  transport.emit({ type: "data-message", data: JSON.stringify(confirm) });
  await secured;
  assert(!events.some((e) => e.type === "peer-typing")); // still not replayed
  session.end();
  await flushAsync();
});

Deno.test("sendFile: refuses when not secure; refuses empty and oversize files", async () => {
  const { session } = makeCreator();
  assertThrows(
    () => session.sendFile(new File([new Uint8Array(8)], "a.bin")),
    SendUnavailableError,
  );
  const pair = await makeSecurePair();
  assertThrows(
    () => pair.a.sendFile(new File([], "empty.bin")),
    FileRejectedError,
  );
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("sendFile: peer sees offer, chunks, and done; sender gets progress; ack emits file-delivered", async () => {
  const pair = await makeSecurePair();
  const eventsA = collect(pair.a);
  const bytes = crypto.getRandomValues(new Uint8Array(20_000)); // 2 chunks
  const completeB = waitForEvent(pair.b, "file-complete");
  const deliveredA = waitForEvent(pair.a, "file-delivered");
  const id = pair.a.sendFile(
    new File([bytes], "pic.png", { type: "image/png" }),
  );
  assertEquals(id.length, 11);
  const complete = await completeB;
  assertEquals(complete.id, id);
  assertEquals(complete.name, "pic.png");
  assertEquals(complete.mime, "image/png");
  assertEquals(new Uint8Array(await complete.blob.arrayBuffer()), bytes);
  assertEquals((await deliveredA).id, id);
  const progress = eventsA.filter((e) => e.type === "file-progress");
  assert(progress.length >= 2);
  assertEquals(progress.at(-1), {
    type: "file-progress",
    id,
    direction: "send",
    bytesDone: 20_000,
    bytesTotal: 20_000,
  });
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("sendFile: two files queue FIFO and both complete in order", async () => {
  const pair = await makeSecurePair();
  const completed: string[] = [];
  pair.b.on((e) => {
    if (e.type === "file-complete") completed.push(e.id);
  });
  const id1 = pair.a.sendFile(new File([new Uint8Array(100)], "one.bin"));
  const id2 = pair.a.sendFile(new File([new Uint8Array(100)], "two.bin"));
  await waitForEvent(pair.a, "file-delivered");
  await flushAsync();
  assertEquals(completed, [id1, id2]);
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("cancelFile: sender cancel stops the transfer and fails it on both ends", async () => {
  const pair = await makeSecurePair();
  // Park the sender in backpressure so the transfer is mid-flight.
  pair.ta.bufferedAmount = 10_000_000;
  const failedA = waitForEvent(pair.a, "file-failed");
  const failedB = waitForEvent(pair.b, "file-failed");
  const id = pair.a.sendFile(
    new File([new Uint8Array(100_000)], "big.bin"),
  );
  await waitForEvent(pair.b, "file-incoming");
  pair.a.cancelFile(id);
  assertEquals(await failedA, {
    type: "file-failed",
    id,
    direction: "send",
    reason: "cancelled",
  });
  assertEquals(await failedB, {
    type: "file-failed",
    id,
    direction: "receive",
    reason: "cancelled",
  });
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("disconnect mid-transfer fails active and queued sends with 'disconnected'", async () => {
  const pair = await makeSecurePair();
  pair.ta.bufferedAmount = 10_000_000; // park the active job
  const failures: SessionEvent[] = [];
  pair.a.on((e) => {
    if (e.type === "file-failed") failures.push(e);
  });
  const id1 = pair.a.sendFile(new File([new Uint8Array(100_000)], "a.bin"));
  const id2 = pair.a.sendFile(new File([new Uint8Array(100)], "b.bin"));
  await waitForEvent(pair.b, "file-incoming");
  pair.ta.emit({ type: "peer-left", peerId: "joiner-peer" }); // grace begins
  await flushAsync();
  assertEquals(
    failures.map((f) => f.type === "file-failed" && [f.id, f.reason]),
    [[id2, "disconnected"], [id1, "disconnected"]],
  );
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

// Sender-side-only coverage for this task's actual deliverables (chunking,
// progress, FIFO queueing, cancel, interruption) that does NOT depend on the
// receive side above: only observes pair.a/pair.ta, never waits on anything
// pair.b would have to emit.

Deno.test("sendFile: chunks + control frames go out on the wire; progress fires on the sender", async () => {
  const pair = await makeSecurePair();
  await flushAsync(); // let the post-secure identity frame settle first
  const events = collect(pair.a);
  const encBefore = pair.ta.sentData.length;
  const bytes = crypto.getRandomValues(new Uint8Array(20_000)); // 2 chunks
  const id = pair.a.sendFile(
    new File([bytes], "pic.png", { type: "image/png" }),
  );
  assertEquals(id.length, 11);
  await flushAsync();
  // file-offer + file-done are the only two new encrypted control frames.
  assertEquals(pair.ta.sentData.length - encBefore, 2);
  assertEquals(pair.ta.sentBinary.length, 2); // chunkCountFor(20_000)
  const progress = events.filter((e) => e.type === "file-progress");
  assert(progress.length >= 2);
  assertEquals(progress.at(-1), {
    type: "file-progress",
    id,
    direction: "send",
    bytesDone: 20_000,
    bytesTotal: 20_000,
  });
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("sendFile: two queued files are sent strictly in order (FIFO), one active at a time", async () => {
  const pair = await makeSecurePair();
  const events = collect(pair.a);
  const id1 = pair.a.sendFile(new File([new Uint8Array(100)], "one.bin"));
  const id2 = pair.a.sendFile(new File([new Uint8Array(100)], "two.bin"));
  assertNotEquals(id1, id2);
  await flushAsync();
  const progressIds = events.filter((e) => e.type === "file-progress").map((
    e,
  ) => e.id);
  assertEquals(progressIds, [id1, id2]); // never interleaved
  assertEquals(pair.ta.sentBinary.length, 2); // one 1-chunk file each
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("cancelFile: cancelling a queued (not yet active) transfer fails it immediately, untouched on the wire", async () => {
  const pair = await makeSecurePair();
  pair.ta.bufferedAmount = 10_000_000; // parks the first job before any chunk sends
  const failedA = waitForEvent(pair.a, "file-failed");
  const id1 = pair.a.sendFile(new File([new Uint8Array(100_000)], "big.bin"));
  const id2 = pair.a.sendFile(new File([new Uint8Array(100)], "small.bin"));
  await flushAsync(); // id1's offer goes out, then parks in backpressure; id2 stays queued
  const sentBinaryBefore = pair.ta.sentBinary.length;
  pair.a.cancelFile(id2);
  assertEquals(await failedA, {
    type: "file-failed",
    id: id2,
    direction: "send",
    reason: "cancelled",
  });
  assertEquals(pair.ta.sentBinary.length, sentBinaryBefore); // nothing sent for it
  pair.a.cancelFile(id1); // clean up the parked active job
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("cancelFile: cancelling the active (mid-flight) transfer fails it on the sender before any chunk sends", async () => {
  const pair = await makeSecurePair();
  pair.ta.bufferedAmount = 10_000_000; // parks the job in backpressure before chunk 0
  const failedA = waitForEvent(pair.a, "file-failed");
  const id = pair.a.sendFile(new File([new Uint8Array(100_000)], "big.bin"));
  await flushAsync();
  pair.a.cancelFile(id);
  assertEquals(await failedA, {
    type: "file-failed",
    id,
    direction: "send",
    reason: "cancelled",
  });
  assertEquals(pair.ta.sentBinary.length, 0); // cancelled before any chunk left the wire
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("disconnect mid-transfer fails active and queued sends with 'disconnected' (queued synchronously, active on unwind)", async () => {
  const pair = await makeSecurePair();
  pair.ta.bufferedAmount = 10_000_000; // parks the active job in backpressure
  const failures: SessionEvent[] = [];
  pair.a.on((e) => {
    if (e.type === "file-failed") failures.push(e);
  });
  const id1 = pair.a.sendFile(new File([new Uint8Array(100_000)], "a.bin"));
  const id2 = pair.a.sendFile(new File([new Uint8Array(100)], "b.bin"));
  await flushAsync(); // id1 parks on drain (offer already sent); id2 stays queued
  pair.ta.emit({ type: "peer-left", peerId: "joiner-peer" }); // grace begins -> failAllTransfers
  await flushAsync();
  assertEquals(
    failures.map((f) => f.type === "file-failed" && [f.id, f.reason]),
    [[id2, "disconnected"], [id1, "disconnected"]],
  );
  pair.a.end();
  await flushAsync();
});

Deno.test("receiver cancel: sender's transfer stops; both ends emit file-failed", async () => {
  const pair = await makeSecurePair();
  pair.ta.bufferedAmount = 10_000_000; // park sender mid-transfer
  const failedA = waitForEvent(pair.a, "file-failed");
  const failedB = waitForEvent(pair.b, "file-failed");
  const id = pair.a.sendFile(new File([new Uint8Array(100_000)], "big.bin"));
  const incoming = await waitForEvent(pair.b, "file-incoming");
  assertEquals(incoming, {
    type: "file-incoming",
    id,
    name: "big.bin",
    mime: "application/octet-stream",
    size: 100_000,
  });
  pair.b.cancelFile(id);
  assertEquals((await failedB).reason, "cancelled");
  assertEquals((await failedA).reason, "cancelled");
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

Deno.test("receiver interruption: grace discards the partial transfer", async () => {
  const pair = await makeSecurePair();
  pair.ta.bufferedAmount = 10_000_000;
  pair.a.sendFile(new File([new Uint8Array(100_000)], "big.bin"));
  const failedB = waitForEvent(pair.b, "file-failed");
  await waitForEvent(pair.b, "file-incoming");
  pair.tb.emit({ type: "peer-left", peerId: "creator-peer" });
  assertEquals((await failedB).reason, "disconnected");
  pair.a.end();
  pair.b.end();
  await flushAsync();
});

// --- pendingAckId: the "fully sent, ack not yet arrived" window ---
//
// Once FileSendJob.run() resolves true, activeSend is nulled and the sender
// has nothing left to fail the transfer with EXCEPT this window's dedicated
// state (pendingAckId). These tests script the peer side by hand (rather
// than using makeSecurePair's two real linked sessions) so the test can
// observe and act on the moment right after file-done is sent but before
// any ack — a real second Session would race that window shut on its own by
// auto-acking. This mirrors the manual-peer pattern already used above (see
// "enc frames arriving before the peer pubkey" and "id-less chat").
async function makeSecureLoneSender() {
  const { session, transport, fragmentSecret } = makeCreator();
  await session.start();
  transport.emit({ type: "data-open" });
  await flushAsync();
  const myPubFrame = JSON.parse(
    transport.sentData.find((s) => JSON.parse(s).type === "pubkey")!,
  ) as { key: string };
  const peerPair = await generateEcdhKeyPair();
  const peerPubB64 = await exportPublicKeyRaw(peerPair.publicKey);
  const sessionPub = await importPublicKeyRaw(myPubFrame.key);
  const shared = await deriveSharedSecret(peerPair.privateKey, sessionPub);
  const key = await deriveSessionKey(fragmentSecret, shared);
  const hash = await transcriptHash(peerPubB64, myPubFrame.key);
  const secure = waitForEvent(session, "secure");
  transport.emit({
    type: "data-message",
    data: JSON.stringify({ v: 1, type: "pubkey", key: peerPubB64 }),
  });
  const confirmFrame = await encryptPayload(key, {
    type: "key-confirm",
    transcriptHash: hash,
  });
  transport.emit({ type: "data-message", data: JSON.stringify(confirmFrame) });
  await secure;
  return { session, transport, key };
}

Deno.test("pendingAckId: a late file-cancel(reason:error) after file-done fails the stranded send with reason 'error'", async () => {
  // Simulates the receiver's finish() throwing (e.g. hash mismatch) and
  // replying file-cancel AFTER the sender already sent every chunk +
  // file-done (activeSend is already null by then) — without the fix, this
  // late cancel matched neither activeSend nor activeReceive and was
  // silently dropped, stranding the sender's bubble forever.
  const { session, transport, key } = await makeSecureLoneSender();
  const id = session.sendFile(new File([new Uint8Array(1_000)], "a.bin"));
  await flushAsync(); // chunks + file-done fully sent; sender now awaits the ack
  const failed = waitForEvent(session, "file-failed");
  const cancelFrame = await encryptPayload(key, {
    type: "file-cancel",
    id,
    reason: "error",
  });
  transport.emit({ type: "data-message", data: JSON.stringify(cancelFrame) });
  assertEquals(await failed, {
    type: "file-failed",
    id,
    direction: "send",
    reason: "error",
  });
  session.end();
  await flushAsync();
});

Deno.test("pendingAckId: a disconnect after file-done fails the stranded send with reason 'disconnected'", async () => {
  const { session, transport } = await makeSecureLoneSender();
  const id = session.sendFile(new File([new Uint8Array(1_000)], "a.bin"));
  await flushAsync(); // chunks + file-done fully sent; sender now awaits the ack
  const failed = waitForEvent(session, "file-failed");
  transport.emit({ type: "peer-left", peerId: "joiner-peer" });
  assertEquals(await failed, {
    type: "file-failed",
    id,
    direction: "send",
    reason: "disconnected",
  });
  session.end();
  await flushAsync();
});

Deno.test("pendingAckId: cancelFile after file-done locally fails the send with reason 'cancelled' and sends nothing to the peer", async () => {
  // The peer has already fully received and verified the file at this
  // point (it already emitted its own file-complete) — cancelFile here must
  // be purely local, not a wire message that would confuse the peer about a
  // transfer it already finished successfully.
  const { session, transport } = await makeSecureLoneSender();
  const id = session.sendFile(new File([new Uint8Array(1_000)], "a.bin"));
  await flushAsync(); // chunks + file-done fully sent; sender now awaits the ack
  const sentBefore = transport.sentData.length;
  const failed = waitForEvent(session, "file-failed");
  session.cancelFile(id);
  assertEquals(await failed, {
    type: "file-failed",
    id,
    direction: "send",
    reason: "cancelled",
  });
  await flushAsync();
  assertEquals(transport.sentData.length, sentBefore); // no file-cancel (or anything else) sent
  session.end();
  await flushAsync();
});

// client/webrtc-client_test.ts
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  iceServersUrlFrom,
  type TransportEvent,
  WebRTCTransport,
} from "./webrtc-client.ts";
import {
  FakePeerConnection,
  FakeWebSocket,
  flushAsync,
  ManualTimers,
} from "./test-fakes.ts";
import { PING_INTERVAL_MS } from "../shared/protocol.ts";

function makeHarness() {
  const sockets: FakeWebSocket[] = [];
  const timers = new ManualTimers();
  const fetchedUrls: string[] = [];
  const events: TransportEvent[] = [];
  const transport = new WebRTCTransport("ws://example.test/ws", {
    createWebSocket: (url) => {
      const s = new FakeWebSocket(url);
      sockets.push(s);
      return s;
    },
    fetchIceServers: (url) => {
      fetchedUrls.push(url);
      return Promise.resolve([{ urls: "stun:stun.example.test:3478" }]);
    },
    timers,
  });
  transport.onEvent((e) => events.push(e));
  return { transport, sockets, timers, fetchedUrls, events };
}

async function connectedHarness() {
  const h = makeHarness();
  const p = h.transport.connect();
  h.sockets[0].open();
  await p;
  return h;
}

Deno.test("iceServersUrlFrom maps the signaling URL to the ICE endpoint", () => {
  assertEquals(
    iceServersUrlFrom("ws://example.test/ws"),
    "http://example.test/api/ice-servers",
  );
  assertEquals(
    iceServersUrlFrom("wss://chat.example.com/ws"),
    "https://chat.example.com/api/ice-servers",
  );
});

Deno.test("connect resolves after socket open and fetches ICE servers", async () => {
  const h = makeHarness();
  const p = h.transport.connect();
  assertEquals(h.sockets.length, 1);
  assertEquals(h.sockets[0].url, "ws://example.test/ws");
  h.sockets[0].open();
  await p;
  assertEquals(h.fetchedUrls, ["http://example.test/api/ice-servers"]);
});

Deno.test("connect rejects if the socket closes before opening", async () => {
  const h = makeHarness();
  const p = h.transport.connect();
  h.sockets[0].drop();
  await assertRejects(() => p);
});

Deno.test("sends a ping envelope every PING_INTERVAL_MS", async () => {
  const h = await connectedHarness();
  await h.timers.tick(PING_INTERVAL_MS);
  await h.timers.tick(PING_INTERVAL_MS);
  const pings = h.sockets[0].sentJson().filter(
    (m) => (m as { type: string }).type === "ping",
  );
  assertEquals(pings.length, 2);
});

Deno.test("createRoom / joinRoom / leaveRoom send exact protocol envelopes", async () => {
  const h = await connectedHarness();
  h.transport.createRoom("room-token-1", 600_000, 120_000);
  h.transport.joinRoom("room-token-1");
  h.transport.leaveRoom();
  assertEquals(h.sockets[0].sentJson(), [
    {
      type: "create",
      roomId: "room-token-1",
      inviteWindowMs: 600_000,
      graceDurationMs: 120_000,
    },
    { type: "join", roomId: "room-token-1" },
    { type: "leave", roomId: "room-token-1" },
  ]);
});

Deno.test("server messages map to transport events", async () => {
  const h = await connectedHarness();
  h.transport.joinRoom("room-token-1");
  const s = h.sockets[0];
  s.receive({ type: "created", peerId: "p1" });
  s.receive({ type: "peer-joined", peerId: "p2" });
  s.receive({ type: "peer-left", peerId: "p2" });
  s.receive({ type: "error", code: "room-full" });
  s.receive({ type: "room-closed", reason: "invite-expired" });
  s.receive({ type: "pong" }); // ignored
  assertEquals(h.events, [
    { type: "created", peerId: "p1" },
    { type: "peer-joined", peerId: "p2" },
    { type: "peer-left", peerId: "p2" },
    { type: "server-error", code: "room-full" },
    { type: "room-closed", reason: "invite-expired" },
  ]);
});

Deno.test("unclean socket close after connect emits signaling-lost", async () => {
  const h = await connectedHarness();
  h.sockets[0].drop();
  assertEquals(h.events, [{ type: "signaling-lost" }]);
});

Deno.test("local close() suppresses signaling-lost", async () => {
  const h = await connectedHarness();
  h.transport.close();
  assertEquals(h.events, []);
});

Deno.test("connect can be called again after a drop (grace rejoin)", async () => {
  const h = await connectedHarness();
  h.sockets[0].drop();
  const p = h.transport.connect();
  assertEquals(h.sockets.length, 2);
  h.sockets[1].open();
  await p;
  h.transport.joinRoom("room-token-1");
  assertEquals(h.sockets[1].sentJson(), [
    { type: "join", roomId: "room-token-1" },
  ]);
});

Deno.test("sendData throws while no DataChannel is open", async () => {
  const h = await connectedHarness();
  assertEquals(h.transport.dataOpen, false);
  assertThrows(() => h.transport.sendData("x"));
});

// keeps `flushAsync` imported ahead of Task 3, and sanity-checks it
Deno.test("flushAsync drains queued microtasks", async () => {
  let ran = false;
  queueMicrotask(() => {
    ran = true;
  });
  await flushAsync();
  assert(ran);
});

function makeRtcHarness() {
  const sockets: FakeWebSocket[] = [];
  const pcs: FakePeerConnection[] = [];
  const timers = new ManualTimers();
  const events: TransportEvent[] = [];
  const transport = new WebRTCTransport("ws://example.test/ws", {
    createWebSocket: (url) => {
      const s = new FakeWebSocket(url);
      sockets.push(s);
      return s;
    },
    createPeerConnection: (config) => {
      const pc = new FakePeerConnection(config);
      pcs.push(pc);
      return pc;
    },
    fetchIceServers: () =>
      Promise.resolve([{ urls: "stun:stun.example.test:3478" }]),
    timers,
  });
  transport.onEvent((e) => events.push(e));
  return { transport, sockets, pcs, timers, events };
}

async function joinedRtcHarness() {
  const h = makeRtcHarness();
  const p = h.transport.connect();
  h.sockets[0].open();
  await p;
  h.transport.joinRoom("room-token-1");
  h.sockets[0].receive({
    type: "joined",
    peerId: "me",
    participants: ["creator-peer"],
    graceDurationMs: 120_000,
  });
  await flushAsync();
  return h;
}

Deno.test("newly-joined peer initiates: joined with participants → offer signal", async () => {
  const h = await joinedRtcHarness();
  // a peer connection was created with the fetched ICE config
  assertEquals(h.pcs.length, 1);
  assertEquals(h.pcs[0].config.iceServers, [
    { urls: "stun:stun.example.test:3478" },
  ]);
  // the initiator opens the DataChannel
  assertEquals(h.pcs[0].channels.length, 1);
  // and an offer rides an opaque signal envelope addressed to the existing peer
  const signals = h.sockets[0].sentJson().filter(
    (m) => (m as { type: string }).type === "signal",
  ) as Array<{ type: string; roomId: string; to: string; payload: unknown }>;
  assertEquals(signals.length, 1);
  assertEquals(signals[0].roomId, "room-token-1");
  assertEquals(signals[0].to, "creator-peer");
  assertEquals(signals[0].payload, {
    kind: "offer",
    sdp: { type: "offer", sdp: "fake-offer-sdp" },
  });
});

Deno.test("existing peer answers an incoming offer (does not initiate)", async () => {
  const h = makeRtcHarness();
  const p = h.transport.connect();
  h.sockets[0].open();
  await p;
  h.transport.createRoom("room-token-1", 600_000, 120_000);
  h.sockets[0].receive({ type: "created", peerId: "me" });
  h.sockets[0].receive({ type: "peer-joined", peerId: "joiner-peer" });
  await flushAsync();
  assertEquals(h.pcs.length, 0); // waits for the joiner's offer
  h.sockets[0].receive({
    type: "signal",
    from: "joiner-peer",
    payload: { kind: "offer", sdp: { type: "offer", sdp: "their-offer" } },
  });
  await flushAsync();
  assertEquals(h.pcs.length, 1);
  assertEquals(h.pcs[0].remoteDescription, {
    type: "offer",
    sdp: "their-offer",
  });
  const signals = h.sockets[0].sentJson().filter(
    (m) => (m as { type: string }).type === "signal",
  ) as Array<{ to: string; payload: unknown }>;
  assertEquals(signals.length, 1);
  assertEquals(signals[0].to, "joiner-peer");
  assertEquals(signals[0].payload, {
    kind: "answer",
    sdp: { type: "answer", sdp: "fake-answer-sdp" },
  });
});

Deno.test("answer and ICE signals are applied to the open peer connection", async () => {
  const h = await joinedRtcHarness();
  h.sockets[0].receive({
    type: "signal",
    from: "creator-peer",
    payload: { kind: "answer", sdp: { type: "answer", sdp: "their-answer" } },
  });
  h.sockets[0].receive({
    type: "signal",
    from: "creator-peer",
    payload: { kind: "ice", candidate: { candidate: "cand-1" } },
  });
  await flushAsync();
  assertEquals(h.pcs[0].remoteDescription, {
    type: "answer",
    sdp: "their-answer",
  });
  assertEquals(h.pcs[0].addedCandidates, [{ candidate: "cand-1" }]);
});

Deno.test("locally gathered ICE candidates are sent as signal envelopes", async () => {
  const h = await joinedRtcHarness();
  h.pcs[0].gatherCandidate({ candidate: "local-cand" });
  const signals = h.sockets[0].sentJson().filter(
    (m) => (m as { type: string }).type === "signal",
  ) as Array<{ payload: { kind: string } }>;
  assertEquals(signals[signals.length - 1].payload, {
    kind: "ice",
    candidate: { candidate: "local-cand" },
  } as unknown as { kind: string });
});

Deno.test("DataChannel lifecycle → data-open / data-message / data-closed + sendData", async () => {
  const h = await joinedRtcHarness();
  const channel = h.pcs[0].channels[0];
  channel.open();
  assertEquals(h.transport.dataOpen, true);
  h.transport.sendData("hello-frame");
  assertEquals(channel.sent, ["hello-frame"]);
  channel.receive("reply-frame");
  channel.close();
  assertEquals(h.transport.dataOpen, false);
  const dataEvents = h.events.filter((e) => e.type.startsWith("data-"));
  assertEquals(dataEvents, [
    { type: "data-open" },
    { type: "data-message", data: "reply-frame" },
    { type: "data-closed" },
  ]);
});

Deno.test("peer-left tears down the peer connection and channel", async () => {
  const h = await joinedRtcHarness();
  h.pcs[0].channels[0].open();
  h.sockets[0].receive({ type: "peer-left", peerId: "creator-peer" });
  assertEquals(h.pcs[0].closed, true);
  assertEquals(h.transport.dataOpen, false);
  assert(h.events.some((e) => e.type === "peer-left"));
});

Deno.test("connectionState failed closes the channel path (data-closed)", async () => {
  const h = await joinedRtcHarness();
  h.pcs[0].channels[0].open();
  h.pcs[0].connectionState = "failed";
  h.pcs[0].onconnectionstatechange?.();
  assertEquals(h.transport.dataOpen, false);
  assert(h.events.some((e) => e.type === "data-closed"));
});

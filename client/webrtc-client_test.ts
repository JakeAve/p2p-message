// client/webrtc-client_test.ts
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  iceServersUrlFrom,
  type TransportEvent,
  WebRTCTransport,
} from "./webrtc-client.ts";
import { FakeWebSocket, flushAsync, ManualTimers } from "./test-fakes.ts";
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

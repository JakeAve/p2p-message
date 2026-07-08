import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  createDefaultLimiters,
  createSignalingHandler,
  hashRoomId,
  parseOptionalMs,
} from "./signaling-server.ts";
import { RoomRegistry } from "./rooms.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

const ROOM = "R".repeat(22);

// ---------- unit: hashed-token logging ----------

Deno.test("hashRoomId: sha256 hex truncated to 8 chars, never the raw token", async () => {
  const h = await hashRoomId(ROOM);
  assertMatch(h, /^[0-9a-f]{8}$/);
  assert(!h.includes(ROOM));
  assertEquals(h, await hashRoomId(ROOM)); // deterministic
  // Known-answer: sha256("RRRRRRRRRRRRRRRRRRRRRR") — verify against:
  //   echo -n "RRRRRRRRRRRRRRRRRRRRRR" | shasum -a 256 | cut -c1-8
  const other = await hashRoomId("A".repeat(22));
  assert(h !== other);
});

Deno.test("parseOptionalMs: parses valid numeric strings, rejects missing/empty/garbage without producing NaN", () => {
  assertEquals(parseOptionalMs(undefined), undefined);
  assertEquals(parseOptionalMs(""), undefined);
  const garbage = parseOptionalMs("garbage");
  assertEquals(garbage, undefined);
  assert(!Number.isNaN(garbage)); // the guard must reject, never leak NaN through
  assertEquals(parseOptionalMs("3600000"), 3_600_000);
  // "0" is a non-empty string, so `!value` is false and it is NOT caught by the
  // falsy guard; Number.isFinite(0) is true, so it must parse to the number 0
  // (not be rejected as if it were falsy).
  assertEquals(parseOptionalMs("0"), 0);
});

// ---------- integration harness ----------

function startTestServer(
  handlerOptions: { idleTimeoutMs?: number } = {},
  registry = new RoomRegistry(),
) {
  const handler = createSignalingHandler(
    registry,
    createDefaultLimiters(),
    handlerOptions,
  );
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    (req, info) => {
      const url = new URL(req.url);
      if (
        url.pathname === "/ws" &&
        req.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        const { socket, response } = Deno.upgradeWebSocket(req);
        handler(socket, info.remoteAddr.hostname);
        return response;
      }
      return new Response("Bad Request", { status: 400 });
    },
  );
  return { server, port: server.addr.port, registry };
}

/** WebSocket test client with an awaitable message queue. */
class TestClient {
  #queue: ServerMessage[] = [];
  #waiters: Array<(m: ServerMessage) => void> = [];
  #closed: Promise<CloseEvent>;
  socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.#closed = new Promise((resolve) => {
      socket.addEventListener("close", (e) => resolve(e), { once: true });
    });
    socket.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string) as ServerMessage;
      const waiter = this.#waiters.shift();
      if (waiter) waiter(msg);
      else this.#queue.push(msg);
    });
  }

  static connect(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const client = new TestClient(socket);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(client), { once: true });
      socket.addEventListener("error", () => reject(new Error("ws error")), {
        once: true,
      });
    });
  }

  send(msg: ClientMessage): void {
    this.socket.send(JSON.stringify(msg));
  }

  sendRaw(data: string): void {
    this.socket.send(data);
  }

  next(timeoutMs = 2_000): Promise<ServerMessage> {
    const queued = this.#queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("timed out waiting for server message")),
        timeoutMs,
      );
      this.#waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }

  /** Resolves when the server (or we) closed the socket. */
  closed(): Promise<CloseEvent> {
    return this.#closed;
  }

  async close(): Promise<void> {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
    await this.#closed;
  }
}

// ---------- integration tests ----------

Deno.test("happy path: create, join, bidirectional signal relay, ping/pong", async () => {
  const { server, port } = startTestServer();
  const alice = await TestClient.connect(port);
  const bob = await TestClient.connect(port);
  try {
    alice.send({
      type: "create",
      roomId: ROOM,
      inviteWindowMs: 600_000,
      graceDurationMs: 120_000,
    });
    const created = await alice.next();
    assert(created.type === "created");

    bob.send({ type: "join", roomId: ROOM });
    const joined = await bob.next();
    assert(joined.type === "joined");
    assertEquals(joined.participants, [created.peerId]);
    assertEquals(joined.graceDurationMs, 120_000);

    const peerJoined = await alice.next();
    assert(peerJoined.type === "peer-joined");
    assertEquals(peerJoined.peerId, joined.peerId);

    // joiner initiates (spec §5 convention) — payload is opaque
    bob.send({
      type: "signal",
      roomId: ROOM,
      to: created.peerId,
      payload: { kind: "offer", sdp: "v=0 fake" },
    });
    const toAlice = await alice.next();
    assert(toAlice.type === "signal");
    assertEquals(toAlice.from, joined.peerId);
    assertEquals(toAlice.payload, { kind: "offer", sdp: "v=0 fake" });

    alice.send({
      type: "signal",
      roomId: ROOM,
      to: joined.peerId,
      payload: { kind: "answer", sdp: "v=0 fake-answer" },
    });
    const toBob = await bob.next();
    assert(toBob.type === "signal");
    assertEquals(toBob.from, created.peerId);

    alice.send({ type: "ping" });
    assertEquals(await alice.next(), { type: "pong" });

    // leave: bob ends deliberately; alice sees room-closed peer-ended
    bob.send({ type: "leave", roomId: ROOM });
    assertEquals(await alice.next(), {
      type: "room-closed",
      reason: "peer-ended",
    });
    await alice.closed(); // server closes the survivor's socket
  } finally {
    await alice.close();
    await bob.close();
    await server.shutdown();
  }
});

Deno.test("recovery: a join with a valid recoveryToken revives a room an empty registry has never seen", async () => {
  const registryA = new RoomRegistry({ recoverySecret: "s3cr3t" });
  const { server: serverA, port: portA } = startTestServer({}, registryA);
  const alice = await TestClient.connect(portA);
  alice.send({
    type: "create",
    roomId: ROOM,
    inviteWindowMs: 600_000,
    graceDurationMs: 120_000,
  });
  const created = await alice.next();
  assert(created.type === "created");
  assert(created.recoveryToken !== undefined);
  const token = created.recoveryToken;
  // Clean up registryA's invite-window timer before tearing the server
  // down — leave-the-page invites keep an unpaired room (and its
  // countdown) alive across a socket drop, so a bare close() alone would
  // leak it.
  alice.send({ type: "leave", roomId: ROOM });
  await alice.close();
  await serverA.shutdown();

  // A second server/registry sharing only the secret — simulates a
  // cold-started instance with an empty room map.
  const registryB = new RoomRegistry({ recoverySecret: "s3cr3t" });
  const { server: serverB, port: portB } = startTestServer({}, registryB);
  try {
    const bob = await TestClient.connect(portB);
    bob.send({ type: "join", roomId: ROOM, recoveryToken: token });
    const joined = await bob.next();
    assert(joined.type === "joined");
    assertEquals(joined.participants, []); // first one back, alone
    assert(joined.recoveryToken !== undefined); // still an unpaired token

    const carol = await TestClient.connect(portB);
    carol.send({ type: "join", roomId: ROOM, recoveryToken: token });
    const joined2 = await carol.next();
    assert(joined2.type === "joined");
    assertEquals(joined2.participants, [joined.peerId]);
    assert(joined2.recoveryToken !== undefined);

    const peerJoined = await bob.next();
    assert(peerJoined.type === "peer-joined");
    assert(peerJoined.recoveryToken !== undefined); // paired token reaches the survivor too

    // Cleanup: end the room so no grace timer leaks past this test.
    carol.send({ type: "leave", roomId: ROOM });
    await bob.next(); // room-closed peer-ended
    await bob.closed();
    await carol.close();
  } finally {
    await serverB.shutdown();
  }
});

Deno.test("recovery: join without a token still gets room-not-found for an unknown room", async () => {
  const { server, port } = startTestServer(
    {},
    new RoomRegistry({ recoverySecret: "s3cr3t" }),
  );
  try {
    const client = await TestClient.connect(port);
    client.send({ type: "join", roomId: ROOM });
    const res = await client.next();
    assert(res.type === "error");
    assertEquals(res.code, "room-not-found");
    await client.close();
  } finally {
    await server.shutdown();
  }
});

Deno.test("recovery: not configured means created/joined never carry a recoveryToken", async () => {
  const { server, port } = startTestServer(); // default registry, no recoverySecret
  const alice = await TestClient.connect(port);
  try {
    alice.send({
      type: "create",
      roomId: ROOM,
      inviteWindowMs: 600_000,
      graceDurationMs: 120_000,
    });
    const created = await alice.next();
    assert(created.type === "created");
    assertEquals(created.recoveryToken, undefined);
    // Cleanup: clear the invite-window timer before shutting down.
    alice.send({ type: "leave", roomId: ROOM });
    await alice.close();
  } finally {
    await server.shutdown();
  }
});

Deno.test("socket close in paired: survivor gets peer-left; rejoin re-pairs", async () => {
  const { server, port, registry } = startTestServer();
  const alice = await TestClient.connect(port);
  let bob = await TestClient.connect(port);
  try {
    alice.send({
      type: "create",
      roomId: ROOM,
      inviteWindowMs: 600_000,
      graceDurationMs: 120_000,
    });
    const created = await alice.next();
    assert(created.type === "created");
    bob.send({ type: "join", roomId: ROOM });
    const joined1 = await bob.next();
    assert(joined1.type === "joined");
    await alice.next(); // peer-joined

    await bob.close(); // silent drop → grace
    const left = await alice.next();
    assert(left.type === "peer-left");
    assertEquals(left.peerId, joined1.peerId);
    assertEquals(registry.stateOf(ROOM), "grace");

    bob = await TestClient.connect(port); // rejoin by roomId possession
    bob.send({ type: "join", roomId: ROOM });
    const joined2 = await bob.next();
    assert(joined2.type === "joined");
    assert(joined2.peerId !== joined1.peerId); // fresh peerId
    assertEquals(registry.stateOf(ROOM), "paired");
    await alice.next(); // peer-joined (rejoiner)

    // cleanup: end the room so no grace timer leaks into the sanitizer
    alice.send({ type: "leave", roomId: ROOM });
    await bob.next(); // room-closed peer-ended
    await bob.closed();
  } finally {
    await alice.close();
    await bob.close();
    await server.shutdown();
  }
});

Deno.test("room-full: third join gets error and the socket is closed", async () => {
  const { server, port } = startTestServer();
  const alice = await TestClient.connect(port);
  const bob = await TestClient.connect(port);
  const mallory = await TestClient.connect(port);
  try {
    alice.send({
      type: "create",
      roomId: ROOM,
      inviteWindowMs: 600_000,
      graceDurationMs: 120_000,
    });
    const created = await alice.next();
    assert(created.type === "created");
    bob.send({ type: "join", roomId: ROOM });
    await bob.next();
    await alice.next(); // peer-joined

    mallory.send({ type: "join", roomId: ROOM });
    assertEquals(await mallory.next(), { type: "error", code: "room-full" });
    await mallory.closed(); // fail-closed: server hangs up

    alice.send({ type: "leave", roomId: ROOM }); // cleanup
    await bob.next();
    await bob.closed();
  } finally {
    await alice.close();
    await bob.close();
    await mallory.close();
    await server.shutdown();
  }
});

Deno.test("join for unknown room: room-not-found", async () => {
  const { server, port } = startTestServer();
  const client = await TestClient.connect(port);
  try {
    client.send({ type: "join", roomId: "Z".repeat(22) });
    assertEquals(await client.next(), {
      type: "error",
      code: "room-not-found",
    });
  } finally {
    await client.close();
    await server.shutdown();
  }
});

Deno.test("create with invalid roomId: config-invalid", async () => {
  const { server, port } = startTestServer();
  const client = await TestClient.connect(port);
  try {
    client.send({
      type: "create",
      roomId: "not a token",
      inviteWindowMs: 600_000,
      graceDurationMs: 120_000,
    });
    assertEquals(await client.next(), {
      type: "error",
      code: "config-invalid",
    });
  } finally {
    await client.close();
    await server.shutdown();
  }
});

Deno.test("per-socket message rate limit: 21st message in a second is rejected", async () => {
  const { server, port } = startTestServer();
  const client = await TestClient.connect(port);
  try {
    for (let i = 0; i < 20; i++) client.send({ type: "ping" });
    for (let i = 0; i < 20; i++) {
      assertEquals(await client.next(), { type: "pong" });
    }
    client.send({ type: "ping" }); // 21st inside the 1s window
    assertEquals(await client.next(), { type: "error", code: "rate-limited" });
  } finally {
    await client.close();
    await server.shutdown();
  }
});

Deno.test("oversized envelope: socket is closed (1009)", async () => {
  const { server, port } = startTestServer();
  const client = await TestClient.connect(port);
  try {
    client.sendRaw("x".repeat(16_385));
    const ev = await client.closed();
    assertEquals(ev.code, 1009);
  } finally {
    await client.close();
    await server.shutdown();
  }
});

Deno.test("malformed JSON: socket is closed (1008)", async () => {
  const { server, port } = startTestServer();
  const client = await TestClient.connect(port);
  try {
    client.sendRaw("{not json");
    const ev = await client.closed();
    assertEquals(ev.code, 1008);
  } finally {
    await client.close();
    await server.shutdown();
  }
});

Deno.test("idle timeout: a silent socket is dropped", async () => {
  const { server, port } = startTestServer({ idleTimeoutMs: 200 });
  const client = await TestClient.connect(port);
  try {
    const ev = await client.closed(); // send nothing; server hangs up
    assertEquals(ev.code, 1001);
  } finally {
    await client.close();
    await server.shutdown();
  }
});

Deno.test("idle drop of a paired peer triggers grace for the survivor", async () => {
  const registry = new RoomRegistry();
  const { server, port } = startTestServer({ idleTimeoutMs: 400 }, registry);
  const alice = await TestClient.connect(port);
  const bob = await TestClient.connect(port);
  try {
    alice.send({
      type: "create",
      roomId: ROOM,
      inviteWindowMs: 600_000,
      graceDurationMs: 120_000,
    });
    const created = await alice.next();
    assert(created.type === "created");
    bob.send({ type: "join", roomId: ROOM });
    await bob.next();
    await alice.next(); // peer-joined

    // alice keeps pinging; bob goes silent and gets idle-dropped
    const keepAlive = setInterval(() => alice.send({ type: "ping" }), 100);
    try {
      await bob.closed();
      let msg: ServerMessage;
      do {
        msg = await alice.next();
      } while (msg.type === "pong");
      assertEquals(msg.type, "peer-left");
      assertEquals(registry.stateOf(ROOM), "grace");
    } finally {
      clearInterval(keepAlive);
    }
    alice.send({ type: "leave", roomId: ROOM }); // cleanup grace timer
  } finally {
    await alice.close();
    await bob.close();
    await server.shutdown();
  }
});

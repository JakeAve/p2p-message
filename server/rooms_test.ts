import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  clampGrace,
  clampInviteWindow,
  MAX_ROOMS,
  type PeerLink,
  RoomRegistry,
} from "./rooms.ts";
import type { ServerMessage } from "../shared/protocol.ts";

// ---------- helpers ----------

class FakeClock {
  now = 0;
  #timers = new Map<number, { fire: number; fn: () => void }>();
  #nextId = 1;

  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.#nextId++;
    this.#timers.set(id, { fire: this.now + ms, fn });
    return id;
  };

  clearTimeout = (id: number): void => {
    this.#timers.delete(id);
  };

  getNow = (): number => this.now;

  get pendingTimers(): number {
    return this.#timers.size;
  }

  advance(ms: number): void {
    this.now += ms;
    const due = [...this.#timers.entries()]
      .filter(([, t]) => t.fire <= this.now)
      .sort((a, b) => a[1].fire - b[1].fire);
    for (const [id, t] of due) {
      this.#timers.delete(id);
      t.fn();
    }
  }
}

class FakeLink implements PeerLink {
  sent: ServerMessage[] = [];
  closed = false;
  send(msg: ServerMessage): void {
    this.sent.push(msg);
  }
  close(): void {
    this.closed = true;
  }
}

function makeRegistry(clock: FakeClock, maxRooms?: number): RoomRegistry {
  return new RoomRegistry({
    maxRooms,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.getNow,
  });
}

const ROOM_A = "A".repeat(22);
const ROOM_B = "B".repeat(22);

// ---------- clamps ----------

Deno.test("clampInviteWindow clamps to 30s–1hr", () => {
  assertEquals(clampInviteWindow(0), 30_000);
  assertEquals(clampInviteWindow(29_999), 30_000);
  assertEquals(clampInviteWindow(30_000), 30_000);
  assertEquals(clampInviteWindow(600_000), 600_000);
  assertEquals(clampInviteWindow(3_600_000), 3_600_000);
  assertEquals(clampInviteWindow(3_600_001), 3_600_000);
  assertEquals(clampInviteWindow(Infinity), 3_600_000);
  assertEquals(clampInviteWindow(-5), 30_000);
});

Deno.test("clampGrace clamps to 15s–30min", () => {
  assertEquals(clampGrace(0), 15_000);
  assertEquals(clampGrace(15_000), 15_000);
  assertEquals(clampGrace(120_000), 120_000);
  assertEquals(clampGrace(1_800_000), 1_800_000);
  assertEquals(clampGrace(1_800_001), 1_800_000);
});

// ---------- create ----------

Deno.test("create: waiting room with a UUID peerId", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  const creator = new FakeLink();
  const result = registry.create(ROOM_A, 600_000, 120_000, creator);
  assert(result.ok);
  // crypto.randomUUID shape
  assertEquals(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      result.peerId,
    ),
    true,
  );
  assertEquals(registry.roomCount, 1);
  assertEquals(registry.stateOf(ROOM_A), "waiting");
  assertEquals(creator.sent, []); // direct ack is the caller's job
});

Deno.test("create: config-invalid for malformed roomId", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  for (const bad of ["short", "A".repeat(23), "A".repeat(21) + "+", ""]) {
    const result = registry.create(bad, 600_000, 120_000, new FakeLink());
    assertFalse(result.ok);
    if (!result.ok) assertEquals(result.code, "config-invalid");
  }
  assertEquals(registry.roomCount, 0);
});

Deno.test("create: config-invalid for non-finite timer values", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  const r1 = registry.create(ROOM_A, NaN, 120_000, new FakeLink());
  assertFalse(r1.ok);
  if (!r1.ok) assertEquals(r1.code, "config-invalid");
  const r2 = registry.create(ROOM_A, 600_000, Infinity, new FakeLink());
  assertFalse(r2.ok);
  if (!r2.ok) assertEquals(r2.code, "config-invalid");
});

Deno.test("create: room-exists for a live roomId", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  assert(registry.create(ROOM_A, 600_000, 120_000, new FakeLink()).ok);
  const dup = registry.create(ROOM_A, 600_000, 120_000, new FakeLink());
  assertFalse(dup.ok);
  if (!dup.ok) assertEquals(dup.code, "room-exists");
});

Deno.test("create: rate-limited at the global room cap", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock, 1); // injectable cap so the test is fast
  assert(registry.create(ROOM_A, 600_000, 120_000, new FakeLink()).ok);
  const over = registry.create(ROOM_B, 600_000, 120_000, new FakeLink());
  assertFalse(over.ok);
  if (!over.ok) assertEquals(over.code, "rate-limited");
  assertEquals(MAX_ROOMS, 10_000); // default cap pinned by spec §8.2
});

// ---------- join ----------

Deno.test("join: waiting → paired, participants listed, creator notified", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  const creator = new FakeLink();
  const created = registry.create(ROOM_A, 600_000, 999_999_999, creator);
  assert(created.ok);
  const joiner = new FakeLink();
  const joined = registry.join(ROOM_A, joiner);
  assert(joined.ok);
  if (joined.ok) {
    assertEquals(joined.participants, [created.peerId]);
    assertEquals(joined.graceDurationMs, 1_800_000); // clamped to 30 min
    assert(joined.peerId !== created.peerId);
    assertEquals(creator.sent, [
      { type: "peer-joined", peerId: joined.peerId },
    ]);
  }
  assertEquals(registry.stateOf(ROOM_A), "paired");
  assertEquals(clock.pendingTimers, 0); // invite timer cancelled on pairing
});

Deno.test("join: room-not-found for unknown or malformed roomId", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  const r1 = registry.join(ROOM_A, new FakeLink());
  assertFalse(r1.ok);
  if (!r1.ok) assertEquals(r1.code, "room-not-found");
  const r2 = registry.join("not-a-token", new FakeLink());
  assertFalse(r2.ok);
  if (!r2.ok) assertEquals(r2.code, "room-not-found");
});

Deno.test("join: room-full for a third join; no peer-joined leaks", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  const creator = new FakeLink();
  const joiner = new FakeLink();
  assert(registry.create(ROOM_A, 600_000, 120_000, creator).ok);
  assert(registry.join(ROOM_A, joiner).ok);
  const sentBefore = creator.sent.length + joiner.sent.length;
  const third = registry.join(ROOM_A, new FakeLink());
  assertFalse(third.ok);
  if (!third.ok) assertEquals(third.code, "room-full");
  assertEquals(creator.sent.length + joiner.sent.length, sentBefore);
  assertEquals(registry.stateOf(ROOM_A), "paired");
});

// ---------- signal ----------

Deno.test("signal: routed opaquely to the target peer only", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  const creator = new FakeLink();
  const joiner = new FakeLink();
  const created = registry.create(ROOM_A, 600_000, 120_000, creator);
  assert(created.ok);
  const joined = registry.join(ROOM_A, joiner);
  assert(joined.ok);
  if (!created.ok || !joined.ok) return;
  creator.sent = []; // drop the peer-joined

  const payload = { sdp: "v=0 fake-offer" };
  registry.signal(ROOM_A, joined.peerId, created.peerId, payload);
  assertEquals(creator.sent, [
    { type: "signal", from: joined.peerId, payload },
  ]);
  assertEquals(joiner.sent, []);

  // unknown target / unknown room: silently dropped, no throw, no oracle
  registry.signal(ROOM_A, created.peerId, "no-such-peer", payload);
  registry.signal(ROOM_B, created.peerId, joined.peerId, payload);
  assertEquals(joiner.sent, []);
});

// ---------- leave ----------

Deno.test("leave in paired: closes room, remaining peer gets peer-ended", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  const creator = new FakeLink();
  const joiner = new FakeLink();
  const created = registry.create(ROOM_A, 600_000, 120_000, creator);
  assert(created.ok);
  assert(registry.join(ROOM_A, joiner).ok);
  if (!created.ok) return;
  joiner.sent = [];

  registry.leave(ROOM_A, created.peerId);
  assertEquals(joiner.sent, [{ type: "room-closed", reason: "peer-ended" }]);
  assert(joiner.closed);
  assertFalse(creator.closed); // the leaver's own socket is left to the caller
  assertEquals(registry.roomCount, 0);
  assertEquals(clock.pendingTimers, 0);
});

Deno.test("leave in waiting: creator abandons, room evaporates", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  const creator = new FakeLink();
  const created = registry.create(ROOM_A, 600_000, 120_000, creator);
  assert(created.ok);
  if (!created.ok) return;
  registry.leave(ROOM_A, created.peerId);
  assertEquals(registry.roomCount, 0);
  assertEquals(clock.pendingTimers, 0);
  const rejoin = registry.join(ROOM_A, new FakeLink());
  assertFalse(rejoin.ok);
  if (!rejoin.ok) assertEquals(rejoin.code, "room-not-found");
});

// ---------- timers: invite window ----------

Deno.test("invite expiry: waiting room closes, creator notified and closed", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  const creator = new FakeLink();
  assert(registry.create(ROOM_A, 600_000, 120_000, creator).ok);
  clock.advance(599_999);
  assertEquals(registry.roomCount, 1);
  clock.advance(1);
  assertEquals(creator.sent, [
    { type: "room-closed", reason: "invite-expired" },
  ]);
  assert(creator.closed);
  assertEquals(registry.roomCount, 0);
  assertEquals(clock.pendingTimers, 0);
});

Deno.test("invite window is clamped: below-min create expires at 30s", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  const creator = new FakeLink();
  assert(registry.create(ROOM_A, 1, 120_000, creator).ok);
  clock.advance(29_999);
  assertEquals(registry.roomCount, 1);
  clock.advance(1);
  assertEquals(registry.roomCount, 0);
});

Deno.test("creator drop in waiting: room survives, invite timer keeps running", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  const creator = new FakeLink();
  const created = registry.create(ROOM_A, 600_000, 120_000, creator);
  assert(created.ok);
  if (!created.ok) return;
  registry.disconnect(ROOM_A, created.peerId);
  assertEquals(registry.roomCount, 1);
  assertEquals(registry.stateOf(ROOM_A), "waiting");
  assertEquals(clock.pendingTimers, 1); // invite countdown untouched
  assertEquals(creator.sent, []); // nobody left to notify
});

Deno.test("join into a 0-socket waiting room: empty participants, still waiting", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  const created = registry.create(ROOM_A, 600_000, 120_000, new FakeLink());
  assert(created.ok);
  if (!created.ok) return;
  registry.disconnect(ROOM_A, created.peerId);
  const friend = new FakeLink();
  const joined = registry.join(ROOM_A, friend);
  assert(joined.ok);
  if (!joined.ok) return;
  assertEquals(joined.participants, []);
  assertEquals(registry.stateOf(ROOM_A), "waiting");
  assertEquals(friend.sent, []); // no peer-joined broadcast to the newcomer
});

Deno.test("creator rejoin pairs the room, stops the invite countdown, notifies the waiting joiner", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  const created = registry.create(ROOM_A, 600_000, 120_000, new FakeLink());
  assert(created.ok);
  if (!created.ok) return;
  registry.disconnect(ROOM_A, created.peerId);
  const friend = new FakeLink();
  const friendJoin = registry.join(ROOM_A, friend);
  assert(friendJoin.ok);
  if (!friendJoin.ok) return;
  const back = new FakeLink();
  const rejoined = registry.join(ROOM_A, back);
  assert(rejoined.ok);
  if (!rejoined.ok) return;
  assertEquals(registry.stateOf(ROOM_A), "paired");
  assertEquals(clock.pendingTimers, 0); // invite countdown stopped by pairing
  assertEquals(rejoined.participants, [friendJoin.peerId]);
  assertEquals(friend.sent, [{ type: "peer-joined", peerId: rejoined.peerId }]);
});

Deno.test("invite expiry closes a 0-socket waiting room", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  const created = registry.create(ROOM_A, 600_000, 120_000, new FakeLink());
  assert(created.ok);
  if (!created.ok) return;
  registry.disconnect(ROOM_A, created.peerId);
  clock.advance(600_000);
  assertEquals(registry.roomCount, 0);
  assertEquals(clock.pendingTimers, 0);
});

Deno.test("waiting joiner drop: room stays waiting until expiry", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  const created = registry.create(ROOM_A, 600_000, 120_000, new FakeLink());
  assert(created.ok);
  if (!created.ok) return;
  registry.disconnect(ROOM_A, created.peerId);
  const friend = new FakeLink();
  const joined = registry.join(ROOM_A, friend);
  assert(joined.ok);
  if (!joined.ok) return;
  registry.disconnect(ROOM_A, joined.peerId); // friend leaves too
  assertEquals(registry.stateOf(ROOM_A), "waiting");
  assertEquals(clock.pendingTimers, 1); // still only the invite countdown
  clock.advance(600_000);
  assertEquals(registry.roomCount, 0);
});

Deno.test("invite expiry closes a waiting room holding a lone joiner", () => {
  const clock = new FakeClock();
  const registry = makeRegistry(clock);
  const created = registry.create(ROOM_A, 600_000, 120_000, new FakeLink());
  assert(created.ok);
  if (!created.ok) return;
  registry.disconnect(ROOM_A, created.peerId);
  clock.advance(60_000);
  const friend = new FakeLink();
  const joined = registry.join(ROOM_A, friend);
  assert(joined.ok);
  clock.advance(540_000); // t = 600_000: original invite deadline, never reset
  assertEquals(registry.roomCount, 0);
  assertEquals(friend.sent, [{
    type: "room-closed",
    reason: "invite-expired",
  }]);
  assert(friend.closed);
});

// ---------- timers: grace ----------

/** create + join, returns ids and links with broadcast noise cleared. */
function pairedRoom(clock: FakeClock, graceMs = 120_000) {
  const registry = makeRegistry(clock);
  const creator = new FakeLink();
  const joiner = new FakeLink();
  const created = registry.create(ROOM_A, 600_000, graceMs, creator);
  if (!created.ok) throw new Error("create failed");
  const joined = registry.join(ROOM_A, joiner);
  if (!joined.ok) throw new Error("join failed");
  creator.sent = [];
  joiner.sent = [];
  return {
    registry,
    creator,
    joiner,
    creatorId: created.peerId,
    joinerId: joined.peerId,
  };
}

Deno.test("disconnect in paired: grace starts, survivor gets peer-left", () => {
  const clock = new FakeClock();
  const { registry, creator, joinerId } = pairedRoom(clock);
  registry.disconnect(ROOM_A, joinerId);
  assertEquals(registry.stateOf(ROOM_A), "grace");
  assertEquals(creator.sent, [{ type: "peer-left", peerId: joinerId }]);
  assertEquals(clock.pendingTimers, 1);
});

Deno.test("grace expiry: survivor gets room-closed grace-expired", () => {
  const clock = new FakeClock();
  const { registry, creator, joinerId } = pairedRoom(clock, 120_000);
  registry.disconnect(ROOM_A, joinerId);
  clock.advance(119_999);
  assertEquals(registry.roomCount, 1);
  clock.advance(1);
  assertEquals(creator.sent, [
    { type: "peer-left", peerId: joinerId },
    { type: "room-closed", reason: "grace-expired" },
  ]);
  assert(creator.closed);
  assertEquals(registry.roomCount, 0);
  assertEquals(clock.pendingTimers, 0);
});

Deno.test("rejoin during grace: fresh peerId, back to paired, timer cancelled", () => {
  const clock = new FakeClock();
  const { registry, creator, joinerId } = pairedRoom(clock, 120_000);
  registry.disconnect(ROOM_A, joinerId);
  clock.advance(60_000); // halfway through grace

  const rejoiner = new FakeLink();
  const rejoined = registry.join(ROOM_A, rejoiner);
  assert(rejoined.ok);
  if (!rejoined.ok) return;
  assert(rejoined.peerId !== joinerId); // fresh peerId (spec §5)
  assertEquals(rejoined.graceDurationMs, 120_000);
  assertEquals(registry.stateOf(ROOM_A), "paired");
  assertEquals(clock.pendingTimers, 0); // grace timer cancelled
  assertEquals(creator.sent, [
    { type: "peer-left", peerId: joinerId },
    { type: "peer-joined", peerId: rejoined.peerId },
  ]);

  clock.advance(600_000); // long past both windows: room lives on
  assertEquals(registry.roomCount, 1);
});

Deno.test("grace timer NOT extended when the second peer also drops", () => {
  const clock = new FakeClock();
  const { registry, creatorId, joinerId } = pairedRoom(clock, 120_000);
  registry.disconnect(ROOM_A, joinerId); // t=0: grace deadline = 120_000
  clock.advance(60_000);
  registry.disconnect(ROOM_A, creatorId); // t=60_000: second drop
  assertEquals(registry.stateOf(ROOM_A), "grace");
  assertEquals(clock.pendingTimers, 1); // same timer, untouched
  clock.advance(59_999); // t=119_999
  assertEquals(registry.roomCount, 1);
  clock.advance(1); // t=120_000: original deadline
  assertEquals(registry.roomCount, 0);
  assertEquals(clock.pendingTimers, 0);
});

Deno.test("rejoin into an empty grace room keeps grace running until second peer", () => {
  const clock = new FakeClock();
  const { registry, creatorId, joinerId } = pairedRoom(clock, 120_000);
  registry.disconnect(ROOM_A, joinerId);
  registry.disconnect(ROOM_A, creatorId); // both gone, grace running
  clock.advance(30_000);

  const back1 = new FakeLink();
  const r1 = registry.join(ROOM_A, back1);
  assert(r1.ok);
  assertEquals(registry.stateOf(ROOM_A), "grace"); // 1 socket: still grace
  assertEquals(clock.pendingTimers, 1);

  const back2 = new FakeLink();
  const r2 = registry.join(ROOM_A, back2);
  assert(r2.ok);
  assertEquals(registry.stateOf(ROOM_A), "paired"); // 2 sockets: paired again
  assertEquals(clock.pendingTimers, 0);
});

Deno.test("invite window never applies again after first pairing", () => {
  const clock = new FakeClock();
  // Tiny invite window (clamps to 30s), long grace.
  const registry = makeRegistry(clock);
  const creator = new FakeLink();
  const created = registry.create(ROOM_A, 30_000, 1_800_000, creator);
  assert(created.ok);
  const joiner = new FakeLink();
  const joined = registry.join(ROOM_A, joiner);
  assert(joined.ok);
  if (!joined.ok) return;
  registry.disconnect(ROOM_A, joined.peerId); // → grace (30 min)
  clock.advance(60_000); // well past the invite window
  assertEquals(registry.roomCount, 1); // governed by grace alone (spec §5)
});

Deno.test("leave during grace closes the room (peer-ended to no one left)", () => {
  const clock = new FakeClock();
  const { registry, creatorId, joinerId, joiner } = pairedRoom(clock, 120_000);
  registry.disconnect(ROOM_A, creatorId); // → grace
  joiner.sent = [];
  registry.leave(ROOM_A, joinerId); // survivor deliberately ends
  assertEquals(registry.roomCount, 0);
  assertEquals(clock.pendingTimers, 0);
  assertEquals(joiner.sent, []); // the leaver gets nothing back
});

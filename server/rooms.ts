import {
  type ErrorCode,
  GRACE_MAX_MS,
  GRACE_MIN_MS,
  INVITE_WINDOW_MAX_MS,
  INVITE_WINDOW_MIN_MS,
  PATH_TOKEN_RE,
  type RoomClosedReason,
  type ServerMessage,
} from "../shared/protocol.ts";

export function clampInviteWindow(ms: number): number {
  return Math.min(Math.max(ms, INVITE_WINDOW_MIN_MS), INVITE_WINDOW_MAX_MS);
}

export function clampGrace(ms: number): number {
  return Math.min(Math.max(ms, GRACE_MIN_MS), GRACE_MAX_MS);
}

/** Transport abstraction so the registry is testable without sockets. */
export interface PeerLink {
  send(msg: ServerMessage): void;
  close(): void;
}

export interface RegistryOptions {
  maxRooms?: number;
  setTimeout?: (fn: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
  now?: () => number;
}

export type CreateResult =
  | { ok: true; peerId: string }
  | { ok: false; code: ErrorCode };

export type JoinResult =
  | {
    ok: true;
    peerId: string;
    participants: string[];
    graceDurationMs: number;
  }
  | { ok: false; code: ErrorCode };

type RoomState = "waiting" | "paired" | "grace";

interface Room {
  id: string;
  state: RoomState;
  peers: Map<string, PeerLink>; // capacity 2, hard-coded (spec §5)
  creatorPeerId: string;
  inviteWindowMs: number; // applies only in "waiting"
  graceDurationMs: number; // applies only in "grace"
  deadline?: number; // epoch ms; single active countdown
  timer?: number;
  createdAt: number;
}

export const MAX_ROOMS = 10_000; // spec §8.2 global cap

const CAPACITY = 2;

/**
 * Spec §5 room state machine. `waiting` and `grace` are mutually exclusive —
 * a room has at most one live countdown; `deadline`/`timer` are repurposed
 * between them, never run in parallel. Closed rooms are deleted immediately.
 */
export class RoomRegistry {
  #rooms = new Map<string, Room>();
  #maxRooms: number;
  #setTimeout: (fn: () => void, ms: number) => number;
  #clearTimeout: (id: number) => void;
  #now: () => number;

  constructor(options: RegistryOptions = {}) {
    this.#maxRooms = options.maxRooms ?? MAX_ROOMS;
    this.#setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimeout = options.clearTimeout ?? ((id) => clearTimeout(id));
    this.#now = options.now ?? Date.now;
  }

  get roomCount(): number {
    return this.#rooms.size;
  }

  stateOf(roomId: string): RoomState | undefined {
    return this.#rooms.get(roomId)?.state;
  }

  create(
    roomId: string,
    inviteWindowMs: number,
    graceDurationMs: number,
    link: PeerLink,
  ): CreateResult {
    if (
      !PATH_TOKEN_RE.test(roomId) ||
      !Number.isFinite(inviteWindowMs) ||
      !Number.isFinite(graceDurationMs)
    ) {
      return { ok: false, code: "config-invalid" };
    }
    if (this.#rooms.has(roomId)) {
      return { ok: false, code: "room-exists" };
    }
    if (this.#rooms.size >= this.#maxRooms) {
      return { ok: false, code: "rate-limited" };
    }
    const peerId = crypto.randomUUID();
    const room: Room = {
      id: roomId,
      state: "waiting",
      peers: new Map([[peerId, link]]),
      creatorPeerId: peerId,
      inviteWindowMs: clampInviteWindow(inviteWindowMs),
      graceDurationMs: clampGrace(graceDurationMs),
      createdAt: this.#now(),
    };
    this.#rooms.set(roomId, room);
    this.#startCountdown(
      room,
      room.inviteWindowMs,
      () => this.#closeRoom(room, "invite-expired"),
    );
    return { ok: true, peerId };
  }

  join(roomId: string, link: PeerLink): JoinResult {
    const room = this.#rooms.get(roomId);
    if (!room) {
      // Malformed and unknown roomIds get the same answer: no such room.
      return { ok: false, code: "room-not-found" };
    }
    if (room.peers.size >= CAPACITY) {
      // Fail-closed: no peer-joined broadcast, no metadata for a third party.
      return { ok: false, code: "room-full" };
    }
    const peerId = crypto.randomUUID();
    const participants = [...room.peers.keys()];
    for (const existing of room.peers.values()) {
      existing.send({ type: "peer-joined", peerId });
    }
    room.peers.set(peerId, link);
    if (room.peers.size === CAPACITY) {
      // waiting → paired (first pairing kills the invite window for good)
      // or grace → paired (rejoin; grace timer cancelled, spec §5).
      this.#stopCountdown(room);
      room.state = "paired";
    }
    // If a grace-state room went 0 → 1 sockets, it stays in "grace" with the
    // original deadline untouched (single room-level grace timer, spec §5).
    return {
      ok: true,
      peerId,
      participants,
      graceDurationMs: room.graceDurationMs,
    };
  }

  signal(
    roomId: string,
    fromPeerId: string,
    to: string,
    payload: unknown,
  ): void {
    const room = this.#rooms.get(roomId);
    if (!room || !room.peers.has(fromPeerId)) return;
    const target = room.peers.get(to);
    if (!target) return; // dumb relay: unknown target is silently dropped
    target.send({ type: "signal", from: fromPeerId, payload });
  }

  /** Deliberate leave ("End chat"). Closes the room for everyone else. */
  leave(roomId: string, peerId: string): void {
    const room = this.#rooms.get(roomId);
    if (!room || !room.peers.has(peerId)) return;
    room.peers.delete(peerId);
    this.#closeRoom(room, "peer-ended");
  }

  /** Socket dropped without a leave (close event, idle timeout). */
  disconnect(roomId: string, peerId: string): void {
    const room = this.#rooms.get(roomId);
    if (!room || !room.peers.has(peerId)) return;
    room.peers.delete(peerId);

    switch (room.state) {
      case "waiting":
        // Creator must keep the tab open during waiting (spec §1/§5):
        // creator drop closes the room immediately. Nobody left to notify.
        this.#deleteRoom(room);
        break;
      case "paired": {
        // First drop while the other peer remains: start the single
        // room-level grace countdown and tell the survivor.
        room.state = "grace";
        this.#startCountdown(
          room,
          room.graceDurationMs,
          () => this.#closeRoom(room, "grace-expired"),
        );
        for (const remaining of room.peers.values()) {
          remaining.send({ type: "peer-left", peerId });
        }
        break;
      }
      case "grace":
        // Second peer also dropped: the grace timer is NOT reset or
        // extended (spec §5). Room may sit at 0 sockets until expiry
        // or a rejoin.
        break;
    }
  }

  #startCountdown(room: Room, ms: number, onExpire: () => void): void {
    this.#stopCountdown(room);
    room.deadline = this.#now() + ms;
    room.timer = this.#setTimeout(onExpire, ms);
  }

  #stopCountdown(room: Room): void {
    if (room.timer !== undefined) {
      this.#clearTimeout(room.timer);
      room.timer = undefined;
      room.deadline = undefined;
    }
  }

  #closeRoom(room: Room, reason: RoomClosedReason): void {
    for (const link of room.peers.values()) {
      link.send({ type: "room-closed", reason });
      link.close();
    }
    this.#deleteRoom(room);
  }

  #deleteRoom(room: Room): void {
    this.#stopCountdown(room);
    room.peers.clear();
    this.#rooms.delete(room.id);
  }
}

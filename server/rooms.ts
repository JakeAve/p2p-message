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
import { signRecoveryToken, verifyRecoveryToken } from "./room-recovery.ts";

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
  /** Stable HMAC key for signed room-recovery tokens. Unset = feature off. */
  recoverySecret?: string;
  /** Upper bound on a *paired* room's recovery, measured from pairedAt. */
  recoveryMaxAgeMs?: number;
}

export type CreateResult =
  | { ok: true; peerId: string; recoveryToken?: string }
  | { ok: false; code: ErrorCode };

export type JoinResult =
  | {
    ok: true;
    peerId: string;
    participants: string[];
    graceDurationMs: number;
    recoveryToken?: string;
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
  /** null until the room first reaches CAPACITY; re-stamped on every later
   * genuine two-party re-pair, never advanced by a solo recovery alone. */
  pairedAt: number | null;
}

export const MAX_ROOMS = 10_000; // spec §8.2 global cap
export const DEFAULT_RECOVERY_MAX_AGE_MS = 21_600_000; // 6 hours

const CAPACITY = 2;

/**
 * Spec §5 room state machine. `waiting` and `grace` are mutually exclusive —
 * a room has at most one live countdown; `deadline`/`timer` are repurposed
 * between them, never run in parallel. Closed rooms are deleted immediately.
 *
 * Stateless room recovery (docs/superpowers/specs/2026-07-07-stateless-room-
 * recovery-design.md): when recoverySecret is configured, create()/pairing
 * issue a signed capability token; join() on a map-miss verifies a presented
 * token and synthesizes the room in the correct state before falling through
 * to the normal join path unchanged.
 */
export class RoomRegistry {
  #rooms = new Map<string, Room>();
  #maxRooms: number;
  #setTimeout: (fn: () => void, ms: number) => number;
  #clearTimeout: (id: number) => void;
  #now: () => number;
  #recoverySecret: string | undefined;
  #recoveryMaxAgeMs: number;

  constructor(options: RegistryOptions = {}) {
    this.#maxRooms = options.maxRooms ?? MAX_ROOMS;
    this.#setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimeout = options.clearTimeout ?? ((id) => clearTimeout(id));
    this.#now = options.now ?? Date.now;
    this.#recoverySecret = options.recoverySecret;
    this.#recoveryMaxAgeMs = options.recoveryMaxAgeMs ??
      DEFAULT_RECOVERY_MAX_AGE_MS;
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
      pairedAt: null,
    };
    this.#rooms.set(roomId, room);
    this.#startCountdown(
      room,
      room.inviteWindowMs,
      () => this.#closeRoom(room, "invite-expired"),
    );
    const recoveryToken = this.#issueToken(room);
    return {
      ok: true,
      peerId,
      ...(recoveryToken !== undefined ? { recoveryToken } : {}),
    };
  }

  join(roomId: string, link: PeerLink, recoveryToken?: string): JoinResult {
    let room = this.#rooms.get(roomId);
    if (!room) {
      room = this.#recoverRoom(roomId, recoveryToken);
      if (!room) {
        return { ok: false, code: "room-not-found" };
      }
    }
    if (room.peers.size >= CAPACITY) {
      // Fail-closed: no peer-joined broadcast, no metadata for a third party.
      return { ok: false, code: "room-full" };
    }
    const peerId = crypto.randomUUID();
    const participants = [...room.peers.keys()];
    const willPair = room.peers.size + 1 === CAPACITY;
    if (willPair) {
      // waiting → paired (first pairing kills the invite window for good)
      // or grace → paired (rejoin; grace timer cancelled, spec §5).
      // Also true for a room recovery just synthesized (§4 of the design).
      this.#stopCountdown(room);
      room.state = "paired";
      room.pairedAt = this.#now();
    }
    // Computed AFTER the pairedAt stamp above, so a pairing join's token
    // reflects the room's new paired state for both the joiner (JoinResult)
    // and the already-waiting peer (peer-joined, below).
    const recoveryTokenOut = this.#issueToken(room);
    for (const existing of room.peers.values()) {
      existing.send({
        type: "peer-joined",
        peerId,
        ...(recoveryTokenOut !== undefined
          ? { recoveryToken: recoveryTokenOut }
          : {}),
      });
    }
    room.peers.set(peerId, link);
    // If a grace-state room went 0 → 1 sockets (not pairing yet), it stays
    // in "grace" with the original deadline untouched (single room-level
    // grace timer, spec §5).
    return {
      ok: true,
      peerId,
      participants,
      graceDurationMs: room.graceDurationMs,
      ...(recoveryTokenOut !== undefined
        ? { recoveryToken: recoveryTokenOut }
        : {}),
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
        // Leave-the-page invites: a waiting room survives socket loss with
        // the same zero-socket posture as "grace". The invite countdown
        // keeps running and still closes the room at expiry; rejoin is by
        // token possession (plain join). "waiting" holds at most one
        // socket, so there is never anyone left to notify here.
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

  #issueToken(room: Room): string | undefined {
    if (!this.#recoverySecret) return undefined;
    return signRecoveryToken({
      roomId: room.id,
      createdAt: room.createdAt,
      pairedAt: room.pairedAt,
      inviteWindowMs: room.inviteWindowMs,
      graceDurationMs: room.graceDurationMs,
    }, this.#recoverySecret);
  }

  /**
   * Verify a presented recovery token and, if valid and still within its
   * age bound, synthesize a fresh Room for it — in "waiting" (with the
   * *remaining* invite budget) if never paired, or "grace" (a fresh
   * countdown starting now) if it was. Returns undefined on any failure,
   * which join() treats identically to "no such room."
   */
  #recoverRoom(roomId: string, token: string | undefined): Room | undefined {
    if (!token || !this.#recoverySecret) return undefined;
    const payload = verifyRecoveryToken(token, this.#recoverySecret);
    if (!payload || payload.roomId !== roomId) return undefined;
    if (this.#rooms.size >= this.#maxRooms) return undefined;

    const now = this.#now();
    const base = {
      id: roomId,
      peers: new Map<string, PeerLink>(),
      creatorPeerId: "", // unknown after recovery; never read elsewhere
      inviteWindowMs: payload.inviteWindowMs,
      graceDurationMs: payload.graceDurationMs,
      createdAt: payload.createdAt,
    };

    let room: Room;
    if (payload.pairedAt === null) {
      if (now - payload.createdAt > payload.inviteWindowMs) return undefined;
      room = { ...base, state: "waiting", pairedAt: null };
      this.#rooms.set(roomId, room);
      const remaining = payload.createdAt + payload.inviteWindowMs - now;
      this.#startCountdown(
        room,
        remaining,
        () => this.#closeRoom(room, "invite-expired"),
      );
    } else {
      if (now - payload.pairedAt > this.#recoveryMaxAgeMs) return undefined;
      room = { ...base, state: "grace", pairedAt: payload.pairedAt };
      this.#rooms.set(roomId, room);
      this.#startCountdown(
        room,
        room.graceDurationMs,
        () => this.#closeRoom(room, "grace-expired"),
      );
    }
    return room;
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

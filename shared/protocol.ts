// Signaling wire protocol — shared between server (plan 2) and client (plan 3).
// BINDING CONTRACT (docs/todo/00-overview.md C3): do not rename or reshape.

// Client → Server
export type ClientMessage =
  | {
    type: "create";
    roomId: string;
    inviteWindowMs: number;
    graceDurationMs: number;
  }
  | { type: "join"; roomId: string; recoveryToken?: string }
  | { type: "signal"; roomId: string; to: string; payload: unknown } // SDP or ICE, opaque
  | { type: "leave"; roomId: string }
  | { type: "ping" };

// Server → Client
export type ServerMessage =
  | { type: "created"; peerId: string; recoveryToken?: string }
  | {
    type: "joined";
    peerId: string;
    participants: string[];
    graceDurationMs: number;
    recoveryToken?: string;
  }
  | { type: "peer-joined"; peerId: string; recoveryToken?: string }
  | { type: "signal"; from: string; payload: unknown }
  | { type: "peer-left"; peerId: string }
  | { type: "error"; code: ErrorCode }
  | { type: "room-closed"; reason: RoomClosedReason }
  | { type: "pong" };

export type ErrorCode =
  | "room-not-found" // join for a roomId with no live room
  | "room-full" // room already at capacity
  | "room-exists" // create for a roomId already live
  | "config-invalid" // create with malformed roomId or non-finite timer values
  | "rate-limited";

export type RoomClosedReason =
  | "invite-expired"
  | "grace-expired"
  | "creator-left"
  | "peer-ended";

// Path tokens are SHA-256(fragment secret) truncated to 128 bits, base64url:
// always exactly 22 chars of the base64url alphabet (spec §2).
export const PATH_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

export const INVITE_WINDOW_MIN_MS = 30_000; // 30 s
export const INVITE_WINDOW_MAX_MS = 3_600_000; // 1 hr
export const GRACE_MIN_MS = 15_000; // 15 s
export const GRACE_MAX_MS = 1_800_000; // 30 min

export const PING_INTERVAL_MS = 25_000; // client sends ping every 25 s
export const IDLE_TIMEOUT_MS = 60_000; // server drops a socket silent this long (2 missed pings)
export const MAX_ENVELOPE_BYTES = 16_384; // per signaling message (spec §8.2)

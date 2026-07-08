import {
  type ClientMessage,
  IDLE_TIMEOUT_MS,
  MAX_ENVELOPE_BYTES,
  type ServerMessage,
} from "../shared/protocol.ts";
import { type PeerLink, RoomRegistry } from "./rooms.ts";
import { SlidingWindowLimiter } from "./rate-limit.ts";

/**
 * The only permitted log form of a path token: sha256 hex, first 8 chars
 * (spec §8.2 — never log the raw token).
 */
export async function hashRoomId(roomId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(roomId),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

export interface SignalingLimiters {
  wsConn: SlidingWindowLimiter; // per IP
  create: SlidingWindowLimiter; // per IP
  join: SlidingWindowLimiter; // per IP
  message: SlidingWindowLimiter; // per socket
}

/** Spec §8.2 starting values. */
export function createDefaultLimiters(): SignalingLimiters {
  return {
    wsConn: new SlidingWindowLimiter(10, 60_000),
    create: new SlidingWindowLimiter(10, 60_000),
    join: new SlidingWindowLimiter(30, 60_000),
    message: new SlidingWindowLimiter(20, 1_000),
  };
}

export interface HandlerOptions {
  idleTimeoutMs?: number;
}

export type ConnectionHandler = (socket: WebSocket, remoteIp: string) => void;

export function createSignalingHandler(
  registry: RoomRegistry = new RoomRegistry(),
  limiters: SignalingLimiters = createDefaultLimiters(),
  options: HandlerOptions = {},
): ConnectionHandler {
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const encoder = new TextEncoder();

  return (socket, remoteIp) => {
    // Rate-limiter key for this socket; never used in the protocol.
    const socketId = crypto.randomUUID();
    let roomId: string | undefined;
    let peerId: string | undefined;
    let idleTimer: number | undefined;

    const send = (msg: ServerMessage) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    };

    const link: PeerLink = {
      send,
      close: () => socket.close(1000),
    };

    const resetIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => socket.close(1001, "idle"), idleTimeoutMs);
    };

    socket.onopen = () => {
      if (!limiters.wsConn.check(remoteIp)) {
        socket.close(1013, "rate-limited");
        return;
      }
      resetIdle();
    };

    socket.onmessage = (event) => {
      resetIdle();
      if (
        typeof event.data !== "string" ||
        encoder.encode(event.data).length > MAX_ENVELOPE_BYTES
      ) {
        socket.close(1009, "message too large");
        return;
      }
      if (!limiters.message.check(socketId)) {
        send({ type: "error", code: "rate-limited" });
        return;
      }

      let msg: ClientMessage;
      try {
        msg = JSON.parse(event.data) as ClientMessage;
      } catch {
        socket.close(1008, "malformed message");
        return;
      }

      switch (msg.type) {
        case "ping":
          send({ type: "pong" });
          break;

        case "create": {
          if (peerId !== undefined) {
            send({ type: "error", code: "config-invalid" }); // one room per socket
            break;
          }
          if (!limiters.create.check(remoteIp)) {
            send({ type: "error", code: "rate-limited" });
            break;
          }
          const result = registry.create(
            msg.roomId,
            msg.inviteWindowMs,
            msg.graceDurationMs,
            link,
          );
          if (!result.ok) {
            send({ type: "error", code: result.code });
            break;
          }
          roomId = msg.roomId;
          peerId = result.peerId;
          // Hashed token only — fire and forget (no await in the handler).
          hashRoomId(msg.roomId).then((h) => console.log(`room ${h}: created`));
          send({
            type: "created",
            peerId: result.peerId,
            ...(result.recoveryToken !== undefined
              ? { recoveryToken: result.recoveryToken }
              : {}),
          });
          break;
        }

        case "join": {
          if (peerId !== undefined) {
            send({ type: "error", code: "config-invalid" });
            break;
          }
          if (!limiters.join.check(remoteIp)) {
            send({ type: "error", code: "rate-limited" });
            break;
          }
          const result = registry.join(msg.roomId, link, msg.recoveryToken);
          if (!result.ok) {
            send({ type: "error", code: result.code });
            if (result.code === "room-full") {
              // Fail-closed (spec §5): a third party gets no handshake metadata.
              socket.close(1008, "room-full");
            }
            break;
          }
          roomId = msg.roomId;
          peerId = result.peerId;
          send({
            type: "joined",
            peerId: result.peerId,
            participants: result.participants,
            graceDurationMs: result.graceDurationMs,
            ...(result.recoveryToken !== undefined
              ? { recoveryToken: result.recoveryToken }
              : {}),
          });
          break;
        }

        case "signal":
          // Opaque relay: route by to/from only, never parse the payload.
          if (
            roomId !== undefined && peerId !== undefined &&
            msg.roomId === roomId
          ) {
            registry.signal(roomId, peerId, msg.to, msg.payload);
          }
          break;

        case "leave": {
          if (roomId === undefined || peerId === undefined) break;
          const r = roomId;
          const p = peerId;
          roomId = undefined;
          peerId = undefined; // so onclose doesn't double-report as a drop
          registry.leave(r, p);
          break;
        }
      }
    };

    socket.onclose = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      if (roomId !== undefined && peerId !== undefined) {
        registry.disconnect(roomId, peerId);
        roomId = undefined;
        peerId = undefined;
      }
    };

    socket.onerror = () => {
      // onclose always follows; nothing to do (and nothing worth logging
      // that wouldn't risk leaking connection metadata).
    };
  };
}

function parseOptionalMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Default wiring for main.ts: one process-wide registry and limiter set. */
export const handleConnection: ConnectionHandler = createSignalingHandler(
  new RoomRegistry({
    recoverySecret: Deno.env.get("ROOM_RECOVERY_SECRET"),
    recoveryMaxAgeMs: parseOptionalMs(
      Deno.env.get("ROOM_RECOVERY_MAX_AGE_MS"),
    ),
  }),
);

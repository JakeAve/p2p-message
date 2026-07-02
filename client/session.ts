// client/session.ts
// The single API the UI talks to (contract C5). Wraps signaling + WebRTC
// (via the Transport interface) + crypto into a status-driven state machine.
import { derivePathToken, encryptPayload } from "./crypto.ts";
import type { ErrorCode } from "../shared/protocol.ts";
import {
  realTimers,
  type TimerApi,
  type Transport,
  type TransportEvent,
  WebRTCTransport,
} from "./webrtc-client.ts";

export type SessionStatus =
  | "connecting" // signaling socket + room create/join in flight
  | "waiting-for-peer" // creator, invite window running
  | "securing" // DataChannel open, handshake/key-confirm in flight
  | "secure" // chat may flow
  | "reconnecting" // grace: peer lost, room still alive
  | "ended";

export type EndReason =
  | "you-ended"
  | "peer-ended"
  | "invite-expired"
  | "grace-expired"
  | "creator-left"
  | "key-confirm-failed"
  | "room-not-found"
  | "room-full"
  | "rate-limited"
  | "signaling-lost"
  | "version-mismatch";

export type SessionEvent =
  | { type: "status"; status: SessionStatus }
  | { type: "secure"; safetyCode: string } // fired on every (re)key
  | { type: "chat"; text: string; timestamp: number } // from peer
  | { type: "peer-identity"; displayName: string }
  | { type: "grace-countdown"; msRemaining: number } // ~1/sec while reconnecting
  | { type: "ended"; reason: EndReason };

export interface SessionOptions {
  role: "creator" | "joiner";
  fragmentSecret: Uint8Array<ArrayBuffer>;
  signalingUrl: string; // ws(s)://host/ws
  displayName?: string;
  inviteWindowMs?: number; // creator only
  graceDurationMs?: number; // creator only
}

/** Test seam (superset of C5): inject a fake transport and manual timers. */
export interface SessionDeps {
  transport?: Transport;
  timers?: TimerApi;
}

export class SendUnavailableError extends Error {
  constructor() {
    super("cannot send: the session is not secure");
    this.name = "SendUnavailableError";
  }
}

export const KEY_CONFIRM_TIMEOUT_MS = 10_000;
export const REJOIN_RETRY_MS = 2_000;
export const GRACE_TICK_MS = 1_000;
export const DEFAULT_INVITE_WINDOW_MS = 600_000; // 10 min (spec §5 preset default)
export const DEFAULT_GRACE_MS = 120_000; // 2 min (spec §5 preset default)

export class Session {
  private readonly opts: SessionOptions;
  private readonly transport: Transport;
  private readonly timers: TimerApi;
  private readonly listeners = new Set<(e: SessionEvent) => void>();

  private _status: SessionStatus = "connecting";
  private roomId = "";
  private graceDurationMs: number;
  private started = false;
  private startAck:
    | { resolve: () => void; reject: (err: Error) => void }
    | null = null;
  /** Serialized event queue: one handler finishes before the next starts. */
  private rx: Promise<void> = Promise.resolve();

  private sessionKey: CryptoKey | null = null;

  constructor(opts: SessionOptions, deps: SessionDeps = {}) {
    this.opts = opts;
    this.timers = deps.timers ?? realTimers;
    this.transport = deps.transport ?? new WebRTCTransport(opts.signalingUrl);
    this.graceDurationMs = opts.graceDurationMs ?? DEFAULT_GRACE_MS;
    this.transport.onEvent((e) => this.enqueue(e));
  }

  get status(): SessionStatus {
    return this._status;
  }

  on(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("start() may only be called once");
    }
    this.started = true;
    this.roomId = await derivePathToken(this.opts.fragmentSecret);
    await this.transport.connect();
    const ack = new Promise<void>((resolve, reject) => {
      this.startAck = { resolve, reject };
    });
    if (this.opts.role === "creator") {
      this.transport.createRoom(
        this.roomId,
        this.opts.inviteWindowMs ?? DEFAULT_INVITE_WINDOW_MS,
        this.graceDurationMs,
      );
    } else {
      this.transport.joinRoom(this.roomId);
    }
    await ack;
  }

  async sendChat(text: string): Promise<void> {
    // Void behavior (spec §5): never queue. Unless the session is secure and
    // the channel is open right now, the message is refused, not buffered.
    if (
      this._status !== "secure" || !this.sessionKey || !this.transport.dataOpen
    ) {
      throw new SendUnavailableError();
    }
    const frame = await encryptPayload(this.sessionKey, {
      type: "chat",
      content: text,
    });
    this.transport.sendData(JSON.stringify(frame));
  }

  end(): void {
    if (this._status === "ended") return;
    const key = this.sessionKey;
    const wasSecure = this._status === "secure";
    const transport = this.transport;
    // Best-effort "end" payload + leave, then transport teardown (C5).
    void (async () => {
      if (wasSecure && key && transport.dataOpen) {
        try {
          const frame = await encryptPayload(key, { type: "end" });
          transport.sendData(JSON.stringify(frame));
        } catch {
          // best effort
        }
      }
      try {
        transport.leaveRoom();
      } catch {
        // best effort
      }
      transport.close();
    })();
    this.finish("you-ended", false);
  }

  // --- internals ---

  private enqueue(e: TransportEvent): void {
    this.rx = this.rx
      .then(() => this.handleEvent(e))
      .catch(() => {
        // Unexpected handler failure: fail closed rather than hang.
        this.finish("signaling-lost");
      });
  }

  private emit(e: SessionEvent): void {
    for (const listener of [...this.listeners]) listener(e);
  }

  private setStatus(status: SessionStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit({ type: "status", status });
  }

  private ackStart(): void {
    this.startAck?.resolve();
    this.startAck = null;
  }

  private handleEvent(e: TransportEvent): void {
    if (this._status === "ended") return;
    switch (e.type) {
      case "created":
        this.setStatus("waiting-for-peer");
        this.ackStart();
        break;
      case "joined":
        this.graceDurationMs = e.graceDurationMs;
        this.ackStart();
        break;
      case "peer-joined":
        break; // status changes when the DataChannel opens
      case "data-open":
        this.setStatus("securing");
        break;
      case "data-message":
        break; // handshake handling: Task 5
      case "data-closed":
      case "peer-left":
        break; // grace handling: Task 7
      case "server-error":
        this.handleServerError(e.code);
        break;
      case "room-closed":
        this.finish(e.reason);
        break;
      case "signaling-lost":
        this.finish("signaling-lost");
        break;
    }
  }

  private handleServerError(code: ErrorCode): void {
    let reason: EndReason;
    if (code === "room-not-found") {
      // On a grace rejoin, "not found" means the room died while we were away.
      reason = this._status === "reconnecting"
        ? "grace-expired"
        : "room-not-found";
    } else if (code === "room-full" || code === "room-exists") {
      reason = "room-full";
    } else if (code === "rate-limited") {
      reason = "rate-limited";
    } else {
      reason = "signaling-lost"; // config-invalid: server clamps silently, should not occur
    }
    this.finish(reason);
  }

  private finish(reason: EndReason, closeTransport = true): void {
    if (this._status === "ended") return;
    this.sessionKey = null;
    const pendingAck = this.startAck;
    this.startAck = null;
    this.setStatus("ended");
    this.emit({ type: "ended", reason });
    pendingAck?.reject(new Error(`session ended: ${reason}`));
    if (closeTransport) {
      this.transport.close();
    }
  }
}

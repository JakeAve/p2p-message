// client/session.ts
// The single API the UI talks to (contract C5). Wraps signaling + WebRTC
// (via the Transport interface) + crypto into a status-driven state machine.
import {
  decryptPayload,
  derivePathToken,
  deriveSafetyCode,
  deriveSessionKey,
  deriveSharedSecret,
  encryptPayload,
  exportPublicKeyRaw,
  generateEcdhKeyPair,
  importPublicKeyRaw,
  transcriptHash,
} from "./crypto.ts";
import {
  type EncryptedFrame,
  type Frame,
  parseFrame,
  type Payload,
  WIRE_VERSION,
  WireError,
} from "../shared/wire.ts";
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

  // Handshake state — fully reset on every (re)key by resetHandshakeState().
  private sessionKey: CryptoKey | null = null;
  private keyPair: CryptoKeyPair | null = null;
  private myPubB64 = "";
  private safetyCode = "";
  private expectedTranscriptHash = "";
  private confirmVerified = false;
  /** Inbound-only reorder buffer (spec §5): enc frames pre-key-derivation. */
  private preKeyBuffer: EncryptedFrame[] = [];
  private confirmTimer: number | null = null;

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

  private async handleEvent(e: TransportEvent): Promise<void> {
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
        await this.beginHandshake();
        break;
      case "data-message":
        await this.handleRaw(e.data);
        break;
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

  /** Spec §7.1: fresh ephemeral ECDH keys on every DataChannel open (first connect and every rekey). */
  private async beginHandshake(): Promise<void> {
    this.resetHandshakeState();
    this.keyPair = await generateEcdhKeyPair();
    this.myPubB64 = await exportPublicKeyRaw(this.keyPair.publicKey);
    this.transport.sendData(
      JSON.stringify({ v: WIRE_VERSION, type: "pubkey", key: this.myPubB64 }),
    );
    this.confirmTimer = this.timers.setTimeout(
      () => this.failHandshake(),
      KEY_CONFIRM_TIMEOUT_MS,
    );
  }

  private resetHandshakeState(): void {
    if (this.confirmTimer !== null) {
      this.timers.clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
    this.sessionKey = null;
    this.keyPair = null;
    this.myPubB64 = "";
    this.safetyCode = "";
    this.expectedTranscriptHash = "";
    this.confirmVerified = false;
    this.preKeyBuffer = [];
  }

  private async handleRaw(raw: string): Promise<void> {
    let frame: Frame;
    try {
      frame = parseFrame(raw);
    } catch (err) {
      if (err instanceof WireError && err.code === "bad-version") {
        // Unknown wire version is a version-mismatch at any stage (spec §7.4)
        this.failHandshake("version-mismatch");
        return;
      }
      if (!this.confirmVerified) this.failHandshake();
      // post-confirm: ignore malformed frames rather than killing a live chat
      return;
    }
    if (frame.type === "pubkey") {
      await this.handlePeerPubkey(frame.key);
      return;
    }
    if (!this.sessionKey) {
      // The allowed inbound exception (spec §5): hold frames that raced ahead
      // of key derivation; processed in order right after the key exists.
      this.preKeyBuffer.push(frame);
      return;
    }
    await this.handleEncrypted(frame);
  }

  private async handlePeerPubkey(peerPubB64: string): Promise<void> {
    if (!this.keyPair || this.sessionKey) return; // out-of-phase or duplicate pubkey
    try {
      const peerKey = await importPublicKeyRaw(peerPubB64);
      const shared = await deriveSharedSecret(this.keyPair.privateKey, peerKey);
      this.sessionKey = await deriveSessionKey(
        this.opts.fragmentSecret,
        shared,
      );
      this.safetyCode = await deriveSafetyCode(
        this.opts.fragmentSecret,
        shared,
      );
      this.expectedTranscriptHash = await transcriptHash(
        this.myPubB64,
        peerPubB64,
      );
      const confirm = await encryptPayload(this.sessionKey, {
        type: "key-confirm",
        transcriptHash: this.expectedTranscriptHash,
      });
      this.transport.sendData(JSON.stringify(confirm));
    } catch {
      this.failHandshake();
      return;
    }
    const buffered = this.preKeyBuffer;
    this.preKeyBuffer = [];
    for (const frame of buffered) {
      await this.handleEncrypted(frame);
    }
  }

  private async handleEncrypted(frame: EncryptedFrame): Promise<void> {
    if (!this.sessionKey) return;
    let payload: Payload;
    try {
      payload = await decryptPayload(this.sessionKey, frame);
    } catch {
      // Wrong key (fragment mismatch) or corrupt frame. Pre-confirm this is
      // the loud failure the spec requires; post-confirm we ignore it.
      if (!this.confirmVerified) this.failHandshake();
      return;
    }
    this.handlePayload(payload);
  }

  private handlePayload(payload: Payload): void {
    if (payload.type === "key-confirm") {
      if (
        this.expectedTranscriptHash !== "" &&
        payload.transcriptHash === this.expectedTranscriptHash
      ) {
        this.confirmVerified = true;
        this.becomeSecure();
      } else {
        this.failHandshake();
      }
    }
    // chat / identity / end payloads: Task 6
  }

  private becomeSecure(): void {
    if (this.confirmTimer !== null) {
      this.timers.clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
    this.setStatus("secure");
    this.emit({ type: "secure", safetyCode: this.safetyCode });
  }

  private failHandshake(reason: EndReason = "key-confirm-failed"): void {
    if (this._status === "ended") return;
    try {
      this.transport.leaveRoom();
    } catch {
      // best effort
    }
    this.finish(reason);
  }

  private finish(reason: EndReason, closeTransport = true): void {
    if (this._status === "ended") return;
    this.resetHandshakeState();
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

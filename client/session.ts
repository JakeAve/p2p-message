// client/session.ts
// The single API the UI talks to (contract C5). Wraps signaling + WebRTC
// (via the Transport interface) + crypto into a status-driven state machine.
import {
  BinaryFrameError,
  decryptPayload,
  derivePathToken,
  deriveSafetyCode,
  deriveSessionKey,
  deriveSharedSecret,
  encryptPayload,
  exportPublicKeyRaw,
  generateEcdhKeyPair,
  generateMessageId,
  importPublicKeyRaw,
  transcriptHash,
} from "./crypto.ts";
import {
  type EncryptedFrame,
  type Frame,
  MAX_FILE_BYTES,
  MAX_FILE_NAME_CHARS,
  parseFrame,
  type Payload,
  WIRE_VERSION,
  WireError,
} from "../shared/wire.ts";
import { type ErrorCode, INVITE_WINDOW_MAX_MS } from "../shared/protocol.ts";
import {
  realTimers,
  type TimerApi,
  type Transport,
  type TransportEvent,
  WebRTCTransport,
} from "./webrtc-client.ts";
import {
  type FileFailReason,
  FileReceiveJob,
  FileSendJob,
  validateOffer,
} from "./file-transfer.ts";

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
  | { type: "chat"; text: string; timestamp: number; id?: string } // from peer
  | { type: "delivered"; id: string } // peer acked our message id
  | { type: "peer-typing"; active: boolean }
  | { type: "peer-identity"; displayName: string }
  | { type: "grace-countdown"; msRemaining: number } // ~1/sec while reconnecting
  | { type: "recovery-token"; token: string } // a fresh signed room-recovery capability arrived
  | { type: "ended"; reason: EndReason }
  | {
    type: "file-incoming";
    id: string;
    name: string;
    mime: string;
    size: number;
  }
  | {
    type: "file-progress";
    id: string;
    direction: "send" | "receive";
    bytesDone: number;
    bytesTotal: number;
  }
  | {
    type: "file-complete";
    id: string;
    blob: Blob;
    name: string;
    mime: string;
  }
  | {
    type: "file-failed";
    id: string;
    direction: "send" | "receive";
    reason: FileFailReason;
  }
  | { type: "file-delivered"; id: string };

export interface SessionOptions {
  role: "creator" | "joiner";
  fragmentSecret: Uint8Array<ArrayBuffer>;
  signalingUrl: string; // ws(s)://host/ws
  displayName?: string;
  inviteWindowMs?: number; // creator only
  graceDurationMs?: number; // creator only
  recoveryToken?: string; // joiner only — from the share link's ?rc= param
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

export class FileRejectedError extends Error {
  reason: "too-large" | "empty";

  constructor(reason: "too-large" | "empty") {
    super(`cannot send file: ${reason}`);
    this.name = "FileRejectedError";
    this.reason = reason;
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

  // Grace state — a single room-level countdown (spec §5).
  private graceDeadline = 0;
  private graceTimer: number | null = null;
  private rejoinTimer: number | null = null;

  // Waiting-phase rejoin (leave-the-page invites): local bound on retries.
  private waitingDeadline = 0;
  private waitingRejoin = false;

  // Stateless room recovery: the latest signed capability the server has
  // issued us, and a small retry budget for the narrow race where a paired
  // token is lost in flight (design §3's "one race worth a cheap mitigation").
  private recoveryToken: string | undefined;
  private recoveryRetriesLeft = 0;

  // File transfers (spec §3): one active per direction, senders queue FIFO.
  private activeSend: FileSendJob | null = null;
  private activeReceive: FileReceiveJob | null = null;
  private sendQueue: { id: string; file: File }[] = [];
  // Guards against a race: activeSend is only assigned deep inside
  // drainSendQueue(), after an `await file.arrayBuffer()`. Without this flag,
  // two sendFile() calls issued back-to-back (before that first await
  // settles) would both see activeSend === null and each spawn its own
  // drainSendQueue() loop, running two "active" sends concurrently.
  private draining = false;

  constructor(opts: SessionOptions, deps: SessionDeps = {}) {
    this.opts = opts;
    this.timers = deps.timers ?? realTimers;
    this.transport = deps.transport ?? new WebRTCTransport(opts.signalingUrl);
    this.graceDurationMs = opts.graceDurationMs ?? DEFAULT_GRACE_MS;
    this.transport.onEvent((e) => this.enqueue(e));
    this.rememberRecoveryToken(opts.recoveryToken);
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
      this.transport.joinRoom(this.roomId, this.recoveryToken);
    }
    await ack;
  }

  async sendChat(text: string): Promise<string> {
    // Void behavior (spec §5): never queue. Unless the session is secure and
    // the channel is open right now, the message is refused, not buffered.
    if (
      this._status !== "secure" || !this.sessionKey || !this.transport.dataOpen
    ) {
      throw new SendUnavailableError();
    }
    const id = generateMessageId();
    const frame = await encryptPayload(this.sessionKey, {
      type: "chat",
      id,
      content: text,
    });
    // Re-check: the peer may have disconnected while we were encrypting.
    // Without this, transport.sendData would throw its own generic Error
    // instead of the documented SendUnavailableError.
    if (
      this._status !== "secure" || !this.sessionKey || !this.transport.dataOpen
    ) {
      throw new SendUnavailableError();
    }
    this.transport.sendData(JSON.stringify(frame));
    return id;
  }

  /** Queue a file for sending. Void behavior like sendChat: refused unless
   * secure right now. Returns the transfer id immediately; progress,
   * failure, and delivery arrive as session events. */
  sendFile(file: File): string {
    if (
      this._status !== "secure" || !this.sessionKey || !this.transport.dataOpen
    ) {
      throw new SendUnavailableError();
    }
    if (file.size === 0) throw new FileRejectedError("empty");
    if (file.size > MAX_FILE_BYTES) throw new FileRejectedError("too-large");
    const id = generateMessageId();
    this.sendQueue.push({ id, file });
    if (!this.draining) {
      this.draining = true;
      void this.drainSendQueue();
    }
    return id;
  }

  /** Cancel an active or queued file transfer (either direction). */
  cancelFile(id: string): void {
    if (this.activeSend?.id === id) {
      this.activeSend.stop("cancelled");
      this.sendFileControl({ type: "file-cancel", id, reason: "sender" });
      return; // file-failed is emitted by the drain loop
    }
    const queued = this.sendQueue.findIndex((q) => q.id === id);
    if (queued >= 0) {
      this.sendQueue.splice(queued, 1);
      this.emit({
        type: "file-failed",
        id,
        direction: "send",
        reason: "cancelled",
      });
    }
    if (this.activeReceive?.id === id) {
      const job = this.activeReceive;
      this.activeReceive = null;
      job.discard();
      this.sendFileControl({ type: "file-cancel", id, reason: "receiver" });
      this.emit({
        type: "file-failed",
        id,
        direction: "receive",
        reason: "cancelled",
      });
    }
  }

  /** Best-effort typing signal: silently dropped unless the session is
   * secure and the channel is open — a lost "typing" is harmless, so this
   * never throws (unlike sendChat). */
  sendTyping(active: boolean): void {
    const key = this.sessionKey;
    if (this._status !== "secure" || !key || !this.transport.dataOpen) return;
    void encryptPayload(key, { type: "typing", active })
      .then((frame) => {
        if (this._status === "secure" && this.transport.dataOpen) {
          this.transport.sendData(JSON.stringify(frame));
        }
      })
      .catch(() => {
        // best effort
      });
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

  /**
   * Retry a parked rejoin immediately. The UI calls this when the tab
   * becomes visible again — background tabs throttle timers, so the
   * 2 s retry loop may not have fired while the user was away.
   */
  wake(): void {
    if (this._status === "ended" || this.rejoinTimer === null) return;
    this.timers.clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    if (this.waitingRejoin) this.rejoinOrExpire();
    else this.attemptRejoin();
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

  /** Remember the latest signed room-recovery capability and reset this
   * instance's retry budget — but only on a genuinely NEW token, so a
   * repeated identical value (e.g. re-delivered on a no-op peer-joined)
   * doesn't reset retries or spam the "recovery-token" event. */
  private rememberRecoveryToken(token: string | undefined): void {
    if (token === undefined || token === this.recoveryToken) return;
    this.recoveryToken = token;
    this.recoveryRetriesLeft = 2;
    this.emit({ type: "recovery-token", token });
  }

  private async handleEvent(e: TransportEvent): Promise<void> {
    if (this._status === "ended") return;
    switch (e.type) {
      case "created":
        this.rememberRecoveryToken(e.recoveryToken);
        this.waitingDeadline = this.timers.now() +
          (this.opts.inviteWindowMs ?? DEFAULT_INVITE_WINDOW_MS);
        this.setStatus("waiting-for-peer");
        this.ackStart();
        break;
      case "joined":
        this.rememberRecoveryToken(e.recoveryToken);
        this.graceDurationMs = e.graceDurationMs;
        this.waitingRejoin = false;
        if (
          e.participants.length === 0 &&
          (this._status === "connecting" ||
            this._status === "waiting-for-peer")
        ) {
          // The other side is away (leave-the-page invites): wait for them.
          // A joiner never learns the room's real invite deadline (creator
          // config), so its retry bound is the protocol maximum.
          if (this.waitingDeadline === 0) {
            this.waitingDeadline = this.timers.now() + INVITE_WINDOW_MAX_MS;
          }
          this.setStatus("waiting-for-peer");
        }
        this.ackStart();
        break;
      case "peer-joined":
        this.rememberRecoveryToken(e.recoveryToken);
        break; // status changes when the DataChannel opens
      case "data-open":
        this.clearGraceTimers();
        this.setStatus("securing");
        await this.beginHandshake(); // grace→paired = the first-connect flow re-run (spec §7.1)
        break;
      case "data-message":
        await this.handleRaw(e.data);
        break;
      case "data-binary":
        await this.handleBinary(e.data);
        break;
      case "data-closed":
      case "peer-left":
        // DataChannel-level loss and server-observed loss are equally valid
        // "peer is gone" triggers (spec §5). Our own socket is still fine,
        // so we wait for the peer to rejoin — no rejoin of our own.
        if (this._status === "secure" || this._status === "securing") {
          this.enterGrace(false);
        }
        break;
      case "server-error":
        this.handleServerError(e.code);
        break;
      case "room-closed":
        this.finish(e.reason);
        break;
      case "signaling-lost":
        if (this._status === "secure" || this._status === "securing") {
          // We are the dropped peer: grace + rejoin by roomId possession.
          this.enterGrace(true);
        } else if (this._status === "reconnecting") {
          this.scheduleRejoin();
        } else if (this._status === "waiting-for-peer") {
          // Leave-the-page invites: the room outlives our socket during
          // the invite window — rejoin by token possession, silently.
          this.waitingRejoin = true;
          this.rejoinOrExpire();
        } else {
          this.finish("signaling-lost");
        }
        break;
    }
  }

  private handleServerError(code: ErrorCode): void {
    if (
      code === "room-not-found" && this.recoveryToken !== undefined &&
      this.recoveryRetriesLeft > 0 && this.rejoinAllowed()
    ) {
      // A recovery token was presented but this instance still says
      // room-not-found — most likely the pairing-time token update raced a
      // second eviction in flight (design §3). Retry on the existing 2s
      // cadence before giving up, rather than finishing on the first miss.
      this.recoveryRetriesLeft--;
      this.scheduleRejoin();
      return;
    }
    let reason: EndReason;
    if (code === "room-not-found") {
      // On a rejoin, "not found" means the room died while we were away:
      // grace-expired for a paired room, invite-expired for a waiting one.
      reason = this._status === "reconnecting"
        ? "grace-expired"
        : this.waitingRejoin
        ? "invite-expired"
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
    this.failAllTransfers();
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
    await this.handlePayload(payload);
  }

  private async handlePayload(payload: Payload): Promise<void> {
    switch (payload.type) {
      case "key-confirm":
        if (
          this.expectedTranscriptHash !== "" &&
          payload.transcriptHash === this.expectedTranscriptHash
        ) {
          this.confirmVerified = true;
          this.becomeSecure();
        } else {
          this.failHandshake();
        }
        break;
      case "identity":
        if (this.confirmVerified) {
          this.emit({
            type: "peer-identity",
            displayName: payload.displayName,
          });
        }
        break;
      case "chat":
        if (this.confirmVerified) {
          const id = typeof payload.id === "string" ? payload.id : undefined;
          this.emit({
            type: "chat",
            text: payload.content,
            timestamp: this.timers.now(),
            id,
          });
          // Ack only id-carrying chats; a pre-receipts peer sends none.
          if (id !== undefined) this.sendDeliveredAck(id);
        }
        break;
      case "delivered":
        if (this.confirmVerified && typeof payload.id === "string") {
          this.emit({ type: "delivered", id: payload.id });
        }
        break;
      case "typing":
        if (this.confirmVerified && typeof payload.active === "boolean") {
          this.emit({ type: "peer-typing", active: payload.active });
        }
        break;
      case "end":
        if (this.confirmVerified) {
          this.finish("peer-ended");
        }
        break;
      case "file-offer": {
        const key = this.sessionKey;
        if (!this.confirmVerified || !key) break;
        if (this.activeReceive !== null || validateOffer(payload) !== null) {
          this.sendFileControl({
            type: "file-cancel",
            id: payload.id,
            reason: "error",
          });
          break;
        }
        this.activeReceive = new FileReceiveJob(payload, key);
        this.emit({
          type: "file-incoming",
          id: payload.id,
          name: payload.name,
          mime: payload.mime,
          size: payload.size,
        });
        break;
      }
      case "file-done": {
        const job = this.activeReceive;
        if (!this.confirmVerified || !job || job.id !== payload.id) break;
        this.activeReceive = null;
        try {
          const blob = await job.finish(payload.sha256);
          this.emit({
            type: "file-complete",
            id: job.id,
            blob,
            name: job.name,
            mime: job.mime,
          });
          this.sendFileControl({ type: "file-received", id: job.id });
        } catch {
          job.discard();
          this.sendFileControl({
            type: "file-cancel",
            id: job.id,
            reason: "error",
          });
          this.emit({
            type: "file-failed",
            id: job.id,
            direction: "receive",
            reason: "error",
          });
        }
        break;
      }
      case "file-cancel":
        if (!this.confirmVerified) break;
        if (this.activeSend?.id === payload.id) {
          this.activeSend.stop(
            payload.reason === "error" ? "error" : "cancelled",
          );
        } else if (this.activeReceive?.id === payload.id) {
          const job = this.activeReceive;
          this.activeReceive = null;
          job.discard();
          this.emit({
            type: "file-failed",
            id: job.id,
            direction: "receive",
            reason: payload.reason === "error" ? "error" : "cancelled",
          });
        }
        break;
      case "file-received":
        if (this.confirmVerified) {
          this.emit({ type: "file-delivered", id: payload.id });
        }
        break;
    }
  }

  /** A binary frame is always a file chunk (spec §1). No active receive →
   * stale straggler from a cancelled transfer: drop silently. An unknown
   * binary version byte is a version-mismatch at any stage, mirroring
   * handleRaw's treatment of JSON wire versions (spec §1). */
  private async handleBinary(frame: ArrayBuffer): Promise<void> {
    const job = this.activeReceive;
    if (!job || !this.confirmVerified) return;
    try {
      const res = await job.acceptFrame(frame);
      if (!res.match) return;
      this.emit({
        type: "file-progress",
        id: job.id,
        direction: "receive",
        bytesDone: res.bytesDone,
        bytesTotal: job.size,
      });
    } catch (err) {
      if (err instanceof BinaryFrameError && err.code === "bad-version") {
        this.failHandshake("version-mismatch");
        return;
      }
      // Decrypt failure, out-of-order, or overflow: fatal for this transfer.
      this.activeReceive = null;
      job.discard();
      this.sendFileControl({
        type: "file-cancel",
        id: job.id,
        reason: "error",
      });
      this.emit({
        type: "file-failed",
        id: job.id,
        direction: "receive",
        reason: "error",
      });
    }
  }

  private async drainSendQueue(): Promise<void> {
    try {
      await this.drainSendQueueLoop();
    } finally {
      this.draining = false;
    }
  }

  private async drainSendQueueLoop(): Promise<void> {
    while (this.sendQueue.length > 0) {
      const { id, file } = this.sendQueue.shift()!;
      const key = this.sessionKey;
      if (
        this._status !== "secure" || !key || !this.transport.dataOpen
      ) {
        this.emit({
          type: "file-failed",
          id,
          direction: "send",
          reason: "disconnected",
        });
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch {
        this.emit({
          type: "file-failed",
          id,
          direction: "send",
          reason: "error",
        });
        continue;
      }
      const job = new FileSendJob({
        id,
        key,
        bytes,
        name: file.name.slice(0, MAX_FILE_NAME_CHARS),
        mime: file.type || "application/octet-stream",
        sink: this.transport,
        sendControl: async (p) => {
          const k = this.sessionKey;
          if (this._status !== "secure" || !k || !this.transport.dataOpen) {
            throw new SendUnavailableError();
          }
          const frame = await encryptPayload(k, p);
          this.transport.sendData(JSON.stringify(frame));
        },
        onProgress: (bytesDone, bytesTotal) =>
          this.emit({
            type: "file-progress",
            id,
            direction: "send",
            bytesDone,
            bytesTotal,
          }),
      });
      this.activeSend = job;
      try {
        const sent = await job.run();
        if (!sent) {
          this.emit({
            type: "file-failed",
            id,
            direction: "send",
            reason: job.stopReason ?? "cancelled",
          });
        }
      } catch {
        // sendBinary/sendControl threw: the channel died mid-transfer.
        this.emit({
          type: "file-failed",
          id,
          direction: "send",
          reason: this._status === "secure" ? "error" : "disconnected",
        });
      } finally {
        this.activeSend = null;
      }
    }
  }

  /** Best-effort encrypted file control (cancel/received) — like typing/end. */
  private sendFileControl(payload: Payload): void {
    const key = this.sessionKey;
    if (!key) return;
    void encryptPayload(key, payload)
      .then((frame) => {
        if (this._status === "secure" && this.transport.dataOpen) {
          this.transport.sendData(JSON.stringify(frame));
        }
      })
      .catch(() => {
        // best effort
      });
  }

  /** Spec §3 interruption: leaving "secure" kills every transfer at once. */
  private failAllTransfers(): void {
    this.activeSend?.stop("disconnected"); // its drain loop emits file-failed
    const queued = this.sendQueue;
    this.sendQueue = [];
    for (const q of queued) {
      this.emit({
        type: "file-failed",
        id: q.id,
        direction: "send",
        reason: "disconnected",
      });
    }
    if (this.activeReceive) {
      const job = this.activeReceive;
      this.activeReceive = null;
      job.discard();
      this.emit({
        type: "file-failed",
        id: job.id,
        direction: "receive",
        reason: "disconnected",
      });
    }
  }

  /** Best-effort encrypted delivery ack — fire-and-forget like identity/end;
   * the peer may drop mid-encrypt and that must not disturb the session. */
  private sendDeliveredAck(id: string): void {
    const key = this.sessionKey;
    if (!key) return;
    void encryptPayload(key, { type: "delivered", id })
      .then((frame) => {
        if (this._status === "secure" && this.transport.dataOpen) {
          this.transport.sendData(JSON.stringify(frame));
        }
      })
      .catch(() => {
        // best effort
      });
  }

  private becomeSecure(): void {
    if (this.confirmTimer !== null) {
      this.timers.clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
    this.setStatus("secure");
    this.emit({ type: "secure", safetyCode: this.safetyCode });
    // Identity travels encrypted, and only after key-confirm verifies (spec §7.4).
    const displayName = this.opts.displayName;
    const key = this.sessionKey;
    if (displayName && key) {
      void encryptPayload(key, { type: "identity", displayName })
        .then((frame) => {
          if (this._status === "secure" && this.transport.dataOpen) {
            this.transport.sendData(JSON.stringify(frame));
          }
        })
        .catch(() => {
          // best effort
        });
    }
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

  private enterGrace(needsRejoin: boolean): void {
    if (this._status === "reconnecting") {
      if (needsRejoin) this.scheduleRejoin();
      return;
    }
    this.resetHandshakeState(); // old key is dead; sendChat now refuses (void behavior)
    this.setStatus("reconnecting");
    this.graceDeadline = this.timers.now() + this.graceDurationMs;
    this.emit({ type: "grace-countdown", msRemaining: this.graceDurationMs });
    this.graceTimer = this.timers.setInterval(
      () => this.tickGrace(),
      GRACE_TICK_MS,
    );
    if (needsRejoin) {
      this.attemptRejoin();
    }
  }

  private tickGrace(): void {
    const msRemaining = this.graceDeadline - this.timers.now();
    if (msRemaining <= 0) {
      this.finish("grace-expired");
    } else {
      this.emit({ type: "grace-countdown", msRemaining });
    }
  }

  private scheduleRejoin(): void {
    if (this.rejoinTimer !== null) return;
    this.rejoinTimer = this.timers.setTimeout(() => {
      this.rejoinTimer = null;
      if (this.waitingRejoin) this.rejoinOrExpire();
      else this.attemptRejoin();
    }, REJOIN_RETRY_MS);
  }

  /** Waiting-phase retry gate: give up at the local invite deadline. */
  private rejoinOrExpire(): void {
    if (this.timers.now() >= this.waitingDeadline) {
      this.finish("invite-expired");
      return;
    }
    this.attemptRejoin();
  }

  /** A rejoin is live during grace, or during a waiting-phase drop. */
  private rejoinAllowed(): boolean {
    return this._status === "reconnecting" ||
      (this._status === "waiting-for-peer" && this.waitingRejoin);
  }

  private attemptRejoin(): void {
    void this.transport.connect().then(
      () => {
        if (this.rejoinAllowed()) {
          this.transport.joinRoom(this.roomId, this.recoveryToken);
        }
      },
      () => {
        if (this.rejoinAllowed()) {
          this.scheduleRejoin();
        }
      },
    );
  }

  private clearGraceTimers(): void {
    if (this.graceTimer !== null) {
      this.timers.clearInterval(this.graceTimer);
      this.graceTimer = null;
    }
    if (this.rejoinTimer !== null) {
      this.timers.clearTimeout(this.rejoinTimer);
      this.rejoinTimer = null;
    }
  }

  private finish(reason: EndReason, closeTransport = true): void {
    if (this._status === "ended") return;
    this.clearGraceTimers();
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

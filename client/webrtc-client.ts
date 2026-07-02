// client/webrtc-client.ts
// Thin transport: signaling WebSocket speaking shared/protocol.ts envelopes,
// ICE config fetched from /api/ice-servers at connect time, and (Task 3)
// RTCPeerConnection/DataChannel plumbing. Every environment dependency
// (WebSocket, RTCPeerConnection, fetch, timers) is injectable for tests;
// real WebRTC behavior is covered by plan 5's browser e2e, not unit tests.

import {
  type ClientMessage,
  type ErrorCode,
  PING_INTERVAL_MS,
  type RoomClosedReason,
  type ServerMessage,
} from "../shared/protocol.ts";

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  now(): number;
}

export const realTimers: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  now: () => Date.now(),
};

/** Structural subset of WebSocket so tests can fake it. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

/** Structural subset of RTCDataChannel so tests can fake it. */
export interface DataChannelLike {
  readyState: string;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

/** Structural subset of RTCPeerConnection so tests can fake it. */
export interface PeerConnectionLike {
  localDescription: RTCSessionDescriptionInit | null;
  connectionState: string;
  createDataChannel(
    label: string,
    opts?: { ordered?: boolean },
  ): DataChannelLike;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  close(): void;
  onicecandidate:
    | ((ev: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void)
    | null;
  ondatachannel: ((ev: { channel: DataChannelLike }) => void) | null;
  onconnectionstatechange: (() => void) | null;
}

export type TransportEvent =
  | { type: "created"; peerId: string }
  | {
    type: "joined";
    peerId: string;
    participants: string[];
    graceDurationMs: number;
  }
  | { type: "peer-joined"; peerId: string }
  | { type: "peer-left"; peerId: string }
  | { type: "server-error"; code: ErrorCode }
  | { type: "room-closed"; reason: RoomClosedReason }
  | { type: "data-open" }
  | { type: "data-closed" }
  | { type: "data-message"; data: string }
  | { type: "signaling-lost" };

/** What client/session.ts consumes. FakeTransport in test-fakes.ts implements this too. */
export interface Transport {
  connect(): Promise<void>;
  createRoom(
    roomId: string,
    inviteWindowMs: number,
    graceDurationMs: number,
  ): void;
  joinRoom(roomId: string): void;
  leaveRoom(): void;
  sendData(data: string): void;
  readonly dataOpen: boolean;
  close(): void;
  onEvent(listener: (e: TransportEvent) => void): () => void;
}

/** SDP/ICE payload relayed opaquely by the server; both ends are this client. */
export type SignalPayload =
  | { kind: "offer"; sdp: RTCSessionDescriptionInit }
  | { kind: "answer"; sdp: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

export interface WebRTCTransportDeps {
  createWebSocket?: (url: string) => WebSocketLike;
  createPeerConnection?: (config: RTCConfiguration) => PeerConnectionLike;
  fetchIceServers?: (url: string) => Promise<RTCIceServer[]>;
  timers?: TimerApi;
}

/** ws(s)://host/ws → http(s)://host/api/ice-servers */
export function iceServersUrlFrom(signalingUrl: string): string {
  const u = new URL(signalingUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = "/api/ice-servers";
  u.search = "";
  u.hash = "";
  return u.toString();
}

async function defaultFetchIceServers(url: string): Promise<RTCIceServer[]> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ice-servers fetch failed: HTTP ${res.status}`);
  }
  const body = await res.json() as { iceServers: RTCIceServer[] };
  return body.iceServers;
}

export class WebRTCTransport implements Transport {
  private readonly signalingUrl: string;
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private readonly createPeerConnection: (
    config: RTCConfiguration,
  ) => PeerConnectionLike;
  private readonly fetchIceServers: (url: string) => Promise<RTCIceServer[]>;
  private readonly timers: TimerApi;
  private readonly listeners = new Set<(e: TransportEvent) => void>();

  private ws: WebSocketLike | null = null;
  private iceServers: RTCIceServer[] = [];
  private roomId = "";
  private pingTimer: number | null = null;
  private closedLocally = false;

  // WebRTC state (used from Task 3 onward)
  private pc: PeerConnectionLike | null = null;
  private channel: DataChannelLike | null = null;
  private channelOpen = false;

  constructor(signalingUrl: string, deps: WebRTCTransportDeps = {}) {
    this.signalingUrl = signalingUrl;
    // Casts below: the DOM lib types the event-handler properties with their
    // concrete event classes, which are not structurally assignable to our
    // minimal *Like interfaces; the runtime objects satisfy them.
    this.createWebSocket = deps.createWebSocket ??
      ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.createPeerConnection = deps.createPeerConnection ??
      ((config) =>
        new RTCPeerConnection(config) as unknown as PeerConnectionLike);
    this.fetchIceServers = deps.fetchIceServers ?? defaultFetchIceServers;
    this.timers = deps.timers ?? realTimers;
  }

  get dataOpen(): boolean {
    return this.channelOpen;
  }

  onEvent(listener: (e: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.closedLocally = false;
      const ws = this.createWebSocket(this.signalingUrl);
      this.ws = ws;
      let settled = false;

      ws.onopen = async () => {
        try {
          this.iceServers = await this.fetchIceServers(
            iceServersUrlFrom(this.signalingUrl),
          );
        } catch (err) {
          settled = true;
          ws.close();
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        this.pingTimer = this.timers.setInterval(
          () => this.sendEnvelope({ type: "ping" }),
          PING_INTERVAL_MS,
        );
        settled = true;
        resolve();
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("signaling connection failed"));
        }
      };

      ws.onclose = () => {
        this.stopPing();
        if (!settled) {
          settled = true;
          reject(new Error("signaling connection closed before open"));
          return;
        }
        if (!this.closedLocally) {
          this.emit({ type: "signaling-lost" });
        }
      };

      ws.onmessage = (ev) => this.handleServerMessage(String(ev.data));
    });
  }

  createRoom(
    roomId: string,
    inviteWindowMs: number,
    graceDurationMs: number,
  ): void {
    this.roomId = roomId;
    this.sendEnvelope({
      type: "create",
      roomId,
      inviteWindowMs,
      graceDurationMs,
    });
  }

  joinRoom(roomId: string): void {
    this.roomId = roomId;
    this.sendEnvelope({ type: "join", roomId });
  }

  leaveRoom(): void {
    this.sendEnvelope({ type: "leave", roomId: this.roomId });
  }

  sendData(data: string): void {
    if (!this.channel || !this.channelOpen) {
      throw new Error("data channel is not open");
    }
    this.channel.send(data);
  }

  close(): void {
    this.closedLocally = true;
    this.stopPing();
    this.teardownPeer();
    this.ws?.close();
    this.ws = null;
  }

  // --- internals ---

  private emit(e: TransportEvent): void {
    for (const listener of [...this.listeners]) listener(e);
  }

  private sendEnvelope(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      this.timers.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private handleServerMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return; // never crash on a malformed relay message
    }
    switch (msg.type) {
      case "created":
        this.emit({ type: "created", peerId: msg.peerId });
        break;
      case "joined":
        this.emit({
          type: "joined",
          peerId: msg.peerId,
          participants: msg.participants,
          graceDurationMs: msg.graceDurationMs,
        });
        break;
      case "peer-joined":
        this.emit({ type: "peer-joined", peerId: msg.peerId });
        break;
      case "signal":
        break; // WebRTC choreography lands in the next commit
      case "peer-left":
        this.teardownPeer();
        this.emit({ type: "peer-left", peerId: msg.peerId });
        break;
      case "error":
        this.emit({ type: "server-error", code: msg.code });
        break;
      case "room-closed":
        this.emit({ type: "room-closed", reason: msg.reason });
        break;
      case "pong":
        break;
    }
  }

  private teardownPeer(): void {
    this.channelOpen = false;
    if (this.channel) {
      this.channel.onclose = null;
      this.channel.close();
      this.channel = null;
    }
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }
  }
}

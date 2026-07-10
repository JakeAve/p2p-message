// client/test-fakes.ts
// Test-only fakes for the injectable seams. Not a test file itself
// (the name intentionally does not match Deno's *_test.ts glob).
import type {
  DataChannelLike,
  PeerConnectionLike,
  TimerApi,
  Transport,
  TransportEvent,
  WebSocketLike,
} from "./webrtc-client.ts";
import type { ServerMessage } from "../shared/protocol.ts";

/** Deterministic TimerApi driven by tick(); starts at t=0. */
export class ManualTimers implements TimerApi {
  private nextId = 1;
  private current = 0;
  private tasks = new Map<
    number,
    { at: number; fn: () => void; interval?: number }
  >();

  now(): number {
    return this.current;
  }
  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.current + ms, fn });
    return id;
  }
  clearTimeout(id: number): void {
    this.tasks.delete(id);
  }
  setInterval(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.current + ms, fn, interval: ms });
    return id;
  }
  clearInterval(id: number): void {
    this.tasks.delete(id);
  }

  /** Advance fake time, firing due tasks in order and draining async work between them. */
  async tick(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, task] = due;
      this.current = Math.max(this.current, task.at);
      if (task.interval !== undefined) task.at += task.interval;
      else this.tasks.delete(id);
      task.fn();
      await flushAsync();
    }
    this.current = target;
  }
}

/**
 * Drain pending async work (microtasks AND real-timer macrotasks — WebCrypto
 * promises in Deno may resolve on event-loop turns, not just microtasks).
 */
export async function flushAsync(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** In-memory WebSocket standing in for the signaling socket. */
export class FakeWebSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }
  /** Test hook: simulate the server accepting the connection. */
  open(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }
  /** Test hook: simulate a server message arriving. */
  receive(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** Test hook: simulate an unclean network drop. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  /** Parsed sent envelopes, for assertions. */
  sentJson(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

export class FakeDataChannel implements DataChannelLike {
  readyState = "connecting";
  binaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: string[] = [];
  sentBinary: ArrayBuffer[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;

  send(data: string | ArrayBuffer): void {
    if (typeof data === "string") this.sent.push(data);
    else this.sentBinary.push(data);
  }
  close(): void {
    this.readyState = "closed";
    this.onclose?.();
  }
  /** Test hook: the channel finished opening. */
  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }
  /** Test hook: a string frame arrived from the peer. */
  receive(data: string): void {
    this.onmessage?.({ data });
  }
  /** Test hook: a binary frame arrived from the peer. */
  receiveBinary(data: ArrayBuffer): void {
    this.onmessage?.({ data });
  }
  /** Test hook: bufferedAmount fell to the low threshold. */
  fireBufferedAmountLow(): void {
    this.onbufferedamountlow?.();
  }
}

export class FakePeerConnection implements PeerConnectionLike {
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState = "new";
  channels: FakeDataChannel[] = [];
  addedCandidates: RTCIceCandidateInit[] = [];
  closed = false;
  onicecandidate:
    | ((ev: { candidate: { toJSON(): RTCIceCandidateInit } | null }) => void)
    | null = null;
  ondatachannel: ((ev: { channel: DataChannelLike }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor(public config: RTCConfiguration) {}

  createDataChannel(_label: string): DataChannelLike {
    const ch = new FakeDataChannel();
    this.channels.push(ch);
    return ch;
  }
  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: "offer", sdp: "fake-offer-sdp" });
  }
  createAnswer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: "answer", sdp: "fake-answer-sdp" });
  }
  setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc;
    return Promise.resolve();
  }
  setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc;
    return Promise.resolve();
  }
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate);
    return Promise.resolve();
  }
  close(): void {
    this.closed = true;
  }
  /** Test hook: an ICE candidate was gathered locally. */
  gatherCandidate(candidate: RTCIceCandidateInit): void {
    this.onicecandidate?.({ candidate: { toJSON: () => candidate } });
  }
}

/**
 * In-memory Transport for Session unit tests. Two linked instances form a
 * "DataChannel": sendData on one delivers data-message to the other on a
 * microtask. Room-level server behavior is driven by the test via emit(),
 * with auto-acks for createRoom/joinRoom so happy paths stay concise.
 */
export class FakeTransport implements Transport {
  peer: FakeTransport | null = null;
  calls: string[] = [];
  sentData: string[] = [];
  sentBinary: ArrayBuffer[] = [];
  bufferedAmount = 0;
  connectError: Error | null = null;
  /** Events auto-emitted (next microtask) after createRoom is called. */
  respondToCreate: TransportEvent[] = [{
    type: "created",
    peerId: "creator-peer",
  }];
  /** Events auto-emitted (next microtask) after joinRoom is called. */
  respondToJoin: TransportEvent[] = [{
    type: "joined",
    peerId: "joiner-peer",
    participants: ["creator-peer"],
    graceDurationMs: 120_000,
  }];

  private open = false;
  private listeners = new Set<(e: TransportEvent) => void>();
  private lowListeners = new Set<() => void>();

  connect(): Promise<void> {
    this.calls.push("connect");
    return this.connectError
      ? Promise.reject(this.connectError)
      : Promise.resolve();
  }
  createRoom(
    roomId: string,
    inviteWindowMs: number,
    graceDurationMs: number,
  ): void {
    this.calls.push(`create:${roomId}:${inviteWindowMs}:${graceDurationMs}`);
    for (const e of this.respondToCreate) {
      queueMicrotask(() => this.emit(e));
    }
  }
  joinRoom(roomId: string, recoveryToken?: string): void {
    this.calls.push(
      recoveryToken !== undefined
        ? `join:${roomId}:${recoveryToken}`
        : `join:${roomId}`,
    );
    for (const e of this.respondToJoin) {
      queueMicrotask(() => this.emit(e));
    }
  }
  leaveRoom(): void {
    this.calls.push("leave");
  }
  sendData(data: string): void {
    if (!this.open) throw new Error("data channel is not open");
    this.sentData.push(data);
    const peer = this.peer;
    if (peer) {
      queueMicrotask(() => peer.emit({ type: "data-message", data }));
    }
  }
  sendBinary(data: ArrayBuffer): void {
    if (!this.open) throw new Error("data channel is not open");
    this.sentBinary.push(data);
    const peer = this.peer;
    if (peer) {
      queueMicrotask(() => peer.emit({ type: "data-binary", data }));
    }
  }
  onBufferedAmountLow(listener: () => void): () => void {
    this.lowListeners.add(listener);
    return () => this.lowListeners.delete(listener);
  }
  /** Test hook: scripted backpressure release. */
  fireBufferedAmountLow(): void {
    for (const listener of [...this.lowListeners]) listener();
  }
  get dataOpen(): boolean {
    return this.open;
  }
  close(): void {
    this.calls.push("close");
    this.open = false;
  }
  onEvent(listener: (e: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Test hook: deliver a transport event (simulating server/DataChannel). */
  emit(e: TransportEvent): void {
    if (e.type === "data-open") this.open = true;
    if (
      e.type === "data-closed" || e.type === "peer-left" ||
      e.type === "signaling-lost"
    ) {
      this.open = false;
    }
    for (const listener of [...this.listeners]) listener(e);
  }
}

export function linkTransports(a: FakeTransport, b: FakeTransport): void {
  a.peer = b;
  b.peer = a;
}

/** Simulate the DataChannel opening on both ends. */
export function openData(a: FakeTransport, b: FakeTransport): void {
  a.emit({ type: "data-open" });
  b.emit({ type: "data-open" });
}

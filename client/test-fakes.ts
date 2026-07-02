// client/test-fakes.ts
// Test-only fakes for the injectable seams. Not a test file itself
// (the name intentionally does not match Deno's *_test.ts glob).
import type { TimerApi, WebSocketLike } from "./webrtc-client.ts";
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

// client/ui/typing.ts
// Pure typing-indicator logic (spec: 4s sender refresh, 7s receiver
// failsafe), kept DOM-free so it unit-tests with ManualTimers.
import type { TimerApi } from "../webrtc-client.ts";

export const TYPING_REFRESH_MS = 4_000;
export const TYPING_FAILSAFE_MS = 7_000;

/** Sender side: throttles composer activity into at most one
 * `typing: true` per TYPING_REFRESH_MS, plus one `typing: false` when the
 * composer empties (sending a message empties it). */
export class TypingSender {
  private active = false;
  private lastTrueAt = -Infinity;

  constructor(
    private readonly timers: TimerApi,
    private readonly send: (active: boolean) => void,
  ) {}

  /** Call on every composer input with whether it is now non-empty. */
  update(nonEmpty: boolean): void {
    if (!nonEmpty) {
      if (this.active) {
        this.active = false;
        this.lastTrueAt = -Infinity; // next burst signals immediately
        this.send(false);
      }
      return;
    }
    const now = this.timers.now();
    if (!this.active || now - this.lastTrueAt >= TYPING_REFRESH_MS) {
      this.active = true;
      this.lastTrueAt = now;
      this.send(true);
    }
  }
}

/** Receiver side: collapses peer-typing events into a visible/hidden flag.
 * onChange fires only on transitions, so the indicator is announced at most
 * once per appearance, and a vanished peer can't leave phantom dots (the
 * failsafe hides them TYPING_FAILSAFE_MS after the last refresh). */
export class TypingTracker {
  private timer: number | null = null;
  private visible = false;

  constructor(
    private readonly timers: TimerApi,
    private readonly onChange: (visible: boolean) => void,
  ) {}

  signal(active: boolean): void {
    if (!active) {
      this.hide();
      return;
    }
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => this.hide(), TYPING_FAILSAFE_MS);
    if (!this.visible) {
      this.visible = true;
      this.onChange(true);
    }
  }

  /** Hide now: explicit stop, message arrival, or session leaving secure. */
  hide(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.visible) {
      this.visible = false;
      this.onChange(false);
    }
  }
}

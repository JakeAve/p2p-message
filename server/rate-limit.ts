/**
 * Sliding-window rate limiter. Each successful `check(key)` records a hit
 * timestamp; a call is allowed while the key has fewer than `limit` hits in
 * the trailing `windowMs`. Blocked calls record nothing. Expired hits are
 * pruned on every check, so per-key memory is bounded by `limit`.
 *
 * Keys that are only ever checked once (e.g. a one-off IP or socket id on a
 * public server) would otherwise keep an entry in `#hits` forever, since
 * nothing revisits a key that stops being checked. To bound total memory
 * across the full set of keys ever seen, every `#SWEEP_INTERVAL` calls to
 * `check()` we opportunistically sweep the whole map and drop any key whose
 * entire timestamp array has expired. This is deterministic (driven by call
 * count, not wall-clock timers) and cheap relative to the traffic that grows
 * the map in the first place.
 */
export class SlidingWindowLimiter {
  /** How many `check()` calls between opportunistic full-map sweeps. */
  static #SWEEP_INTERVAL = 128;

  #limit: number;
  #windowMs: number;
  #now: () => number;
  #hits = new Map<string, number[]>();
  #callsSinceSweep = 0;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Test-only introspection: number of distinct keys currently retained. */
  get size(): number {
    return this.#hits.size;
  }

  check(key: string): boolean {
    const t = this.#now();
    const cutoff = t - this.#windowMs;
    const kept = (this.#hits.get(key) ?? []).filter((ts) => ts > cutoff);
    let allowed: boolean;
    if (kept.length >= this.#limit) {
      if (kept.length > 0) this.#hits.set(key, kept);
      else this.#hits.delete(key);
      allowed = false;
    } else {
      kept.push(t);
      this.#hits.set(key, kept);
      allowed = true;
    }

    this.#callsSinceSweep++;
    if (this.#callsSinceSweep >= SlidingWindowLimiter.#SWEEP_INTERVAL) {
      this.#callsSinceSweep = 0;
      this.#sweep(cutoff);
    }

    return allowed;
  }

  /** Drop every key whose entire timestamp array has expired. */
  #sweep(cutoff: number): void {
    for (const [k, timestamps] of this.#hits) {
      if (timestamps.every((ts) => ts <= cutoff)) {
        this.#hits.delete(k);
      }
    }
  }
}

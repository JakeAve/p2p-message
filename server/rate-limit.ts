/**
 * Sliding-window rate limiter. Each successful `check(key)` records a hit
 * timestamp; a call is allowed while the key has fewer than `limit` hits in
 * the trailing `windowMs`. Blocked calls record nothing. Expired hits are
 * pruned on every check, so memory is bounded by (active keys × limit).
 */
export class SlidingWindowLimiter {
  #limit: number;
  #windowMs: number;
  #now: () => number;
  #hits = new Map<string, number[]>();

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  check(key: string): boolean {
    const t = this.#now();
    const cutoff = t - this.#windowMs;
    const kept = (this.#hits.get(key) ?? []).filter((ts) => ts > cutoff);
    if (kept.length >= this.#limit) {
      if (kept.length > 0) this.#hits.set(key, kept);
      else this.#hits.delete(key);
      return false;
    }
    kept.push(t);
    this.#hits.set(key, kept);
    return true;
  }
}

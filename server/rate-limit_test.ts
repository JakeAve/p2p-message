import { assert, assertFalse } from "@std/assert";
import { SlidingWindowLimiter } from "./rate-limit.ts";

function fakeNow(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

Deno.test("allows up to `limit` hits, then blocks", () => {
  const clock = fakeNow();
  const limiter = new SlidingWindowLimiter(3, 60_000, clock.now);
  assert(limiter.check("1.2.3.4"));
  assert(limiter.check("1.2.3.4"));
  assert(limiter.check("1.2.3.4"));
  assertFalse(limiter.check("1.2.3.4"));
  assertFalse(limiter.check("1.2.3.4"));
});

Deno.test("keys are independent", () => {
  const clock = fakeNow();
  const limiter = new SlidingWindowLimiter(1, 60_000, clock.now);
  assert(limiter.check("a"));
  assertFalse(limiter.check("a"));
  assert(limiter.check("b"));
});

Deno.test("window slides: old hits expire, capacity frees up gradually", () => {
  const clock = fakeNow();
  const limiter = new SlidingWindowLimiter(2, 1_000, clock.now);
  assert(limiter.check("k")); // t=0
  clock.advance(600);
  assert(limiter.check("k")); // t=600
  assertFalse(limiter.check("k")); // t=600, both hits inside window
  clock.advance(500); // t=1100: hit at t=0 has expired, hit at t=600 has not
  assert(limiter.check("k"));
  assertFalse(limiter.check("k")); // t=600 and t=1100 both inside window
  clock.advance(2_000); // t=3100: everything expired
  assert(limiter.check("k"));
});

Deno.test("blocked attempts do not consume capacity", () => {
  const clock = fakeNow();
  const limiter = new SlidingWindowLimiter(1, 1_000, clock.now);
  assert(limiter.check("k")); // t=0
  assertFalse(limiter.check("k"));
  assertFalse(limiter.check("k"));
  clock.advance(1_001); // only the single successful hit had to expire
  assert(limiter.check("k"));
});

Deno.test("stale one-off keys are evicted by periodic sweep, bounding memory", () => {
  const clock = fakeNow();
  const limiter = new SlidingWindowLimiter(5, 1_000, clock.now);

  // Simulate many distinct one-off clients (e.g. IPs) each checked exactly
  // once. None of these keys is ever revisited, so nothing but an internal
  // sweep can ever evict them.
  for (let i = 0; i < 60; i++) {
    assert(limiter.check(`one-off-${i}`));
  }
  assert(limiter.size === 60);

  // Move well past the window so all 60 recorded hits are expired.
  clock.advance(10_000);

  // Drive enough additional check() calls to cross the next sweep boundary
  // (sweeps run every 128 calls; 60 have already happened above). Reuse a
  // single key so we can distinguish "swept" from "still growing".
  for (let i = 0; i < 80; i++) {
    limiter.check("trigger-sweep");
  }

  // The 60 stale one-off keys must have been dropped by the sweep; only the
  // repeatedly-checked "trigger-sweep" key (and possibly transient/new
  // entries) should remain. Memory does not grow unboundedly with the total
  // number of distinct keys ever seen.
  assert(
    limiter.size < 60,
    `expected stale keys to be swept, but size was ${limiter.size}`,
  );
});

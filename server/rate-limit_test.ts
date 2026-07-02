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

import { assertEquals, assertMatch, assertNotMatch } from "@std/assert";
import {
  GRACE_MAX_MS,
  GRACE_MIN_MS,
  IDLE_TIMEOUT_MS,
  INVITE_WINDOW_MAX_MS,
  INVITE_WINDOW_MIN_MS,
  MAX_ENVELOPE_BYTES,
  PATH_TOKEN_RE,
  PING_INTERVAL_MS,
} from "./protocol.ts";

Deno.test("PATH_TOKEN_RE accepts 22-char base64url tokens", () => {
  assertMatch("x7Kp2mQ_aB-cD3eF4gH5iJ", PATH_TOKEN_RE);
  assertMatch("A".repeat(22), PATH_TOKEN_RE);
});

Deno.test("PATH_TOKEN_RE rejects wrong lengths and non-base64url chars", () => {
  assertNotMatch("A".repeat(21), PATH_TOKEN_RE); // too short
  assertNotMatch("A".repeat(23), PATH_TOKEN_RE); // too long
  assertNotMatch("A".repeat(21) + "+", PATH_TOKEN_RE); // plain-base64 char
  assertNotMatch("A".repeat(21) + "/", PATH_TOKEN_RE);
  assertNotMatch("A".repeat(21) + "=", PATH_TOKEN_RE);
  assertNotMatch("", PATH_TOKEN_RE);
});

Deno.test("protocol constants match the pinned contract values", () => {
  assertEquals(INVITE_WINDOW_MIN_MS, 30_000);
  assertEquals(INVITE_WINDOW_MAX_MS, 3_600_000);
  assertEquals(GRACE_MIN_MS, 15_000);
  assertEquals(GRACE_MAX_MS, 1_800_000);
  assertEquals(PING_INTERVAL_MS, 25_000);
  assertEquals(IDLE_TIMEOUT_MS, 60_000);
  assertEquals(MAX_ENVELOPE_BYTES, 16_384);
});

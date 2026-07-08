import { assertEquals } from "@std/assert";
import {
  formatCountdown,
  formatMessageTime,
  MAX_MESSAGE_BYTES,
  utf8ByteLength,
} from "./format.ts";

Deno.test("MAX_MESSAGE_BYTES is the spec's 4,000-byte cap", () => {
  assertEquals(MAX_MESSAGE_BYTES, 4000);
});

Deno.test("utf8ByteLength counts bytes, not code points", () => {
  assertEquals(utf8ByteLength(""), 0);
  assertEquals(utf8ByteLength("abc"), 3);
  assertEquals(utf8ByteLength("é"), 2); // U+00E9, 2 bytes
  assertEquals(utf8ByteLength("€"), 3); // U+20AC, 3 bytes
  assertEquals(utf8ByteLength("😀"), 4); // U+1F600, 4 bytes (but .length === 2)
  assertEquals(utf8ByteLength("a".repeat(4000)), 4000);
  assertEquals(utf8ByteLength("😀".repeat(1000)), 4000); // exactly at the cap
  assertEquals(utf8ByteLength("😀".repeat(1000) + "a"), 4001); // one byte over
});

Deno.test("formatCountdown renders m:ss under an hour, h:mm:ss above", () => {
  assertEquals(formatCountdown(0), "0:00");
  assertEquals(formatCountdown(-500), "0:00"); // clamps
  assertEquals(formatCountdown(999), "0:01"); // rounds up
  assertEquals(formatCountdown(61_000), "1:01");
  assertEquals(formatCountdown(600_000), "10:00"); // 10-min invite starts at 10:00
  assertEquals(formatCountdown(3_600_000), "1:00:00");
  assertEquals(formatCountdown(5_432_100), "1:30:33"); // ceil(5432.1s) = 5433s
});

Deno.test("formatMessageTime renders hour and minute for the given locale", () => {
  // new Date(y, m, d, h, min) is local time, so no TZ dependence here.
  const t = new Date(2026, 6, 8, 15, 42).getTime();
  assertEquals(formatMessageTime(t, "en-US"), "3:42 PM");
  assertEquals(formatMessageTime(t, "de-DE"), "15:42");
});

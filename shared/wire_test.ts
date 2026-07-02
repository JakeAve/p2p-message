import { assertEquals, assertThrows } from "@std/assert";
import { parseFrame, WIRE_VERSION, WireError } from "./wire.ts";

Deno.test("WIRE_VERSION is 1", () => {
  assertEquals(WIRE_VERSION, 1);
});

Deno.test("parseFrame accepts a valid pubkey frame", () => {
  const raw = JSON.stringify({ v: 1, type: "pubkey", key: "abc123" });
  assertEquals(parseFrame(raw), { v: 1, type: "pubkey", key: "abc123" });
});

Deno.test("parseFrame accepts a valid enc frame", () => {
  const raw = JSON.stringify({ v: 1, type: "enc", iv: "aXY", ct: "Y3Q" });
  assertEquals(parseFrame(raw), { v: 1, type: "enc", iv: "aXY", ct: "Y3Q" });
});

Deno.test("parseFrame ignores unknown extra fields on valid frames", () => {
  const raw = JSON.stringify({ v: 1, type: "pubkey", key: "k", junk: true });
  assertEquals(parseFrame(raw), { v: 1, type: "pubkey", key: "k" });
});

Deno.test("parseFrame throws bad-json on invalid JSON", () => {
  const err = assertThrows(() => parseFrame("{not json"), WireError);
  assertEquals(err.code, "bad-json");
});

Deno.test("parseFrame throws bad-version on unknown version", () => {
  const rawV2 = JSON.stringify({ v: 2, type: "pubkey", key: "abc" });
  const err = assertThrows(() => parseFrame(rawV2), WireError);
  assertEquals(err.code, "bad-version");

  const rawV0 = JSON.stringify({ v: 0, type: "enc", iv: "a", ct: "b" });
  const err0 = assertThrows(() => parseFrame(rawV0), WireError);
  assertEquals(err0.code, "bad-version");
});

Deno.test("parseFrame throws bad-frame on missing or wrong fields", () => {
  const cases = [
    JSON.stringify({ type: "pubkey", key: "abc" }), // v missing
    JSON.stringify({ v: "1", type: "pubkey", key: "abc" }), // v not a number
    JSON.stringify({ v: 1, type: "pubkey" }), // key missing
    JSON.stringify({ v: 1, type: "pubkey", key: 7 }), // key wrong type
    JSON.stringify({ v: 1, type: "enc", iv: "aXY" }), // ct missing
    JSON.stringify({ v: 1, type: "enc", ct: "Y3Q" }), // iv missing
    JSON.stringify({ v: 1, type: "chat", content: "hi" }), // unknown type
    JSON.stringify(null),
    JSON.stringify([1, 2]),
    JSON.stringify("pubkey"),
    JSON.stringify(42),
  ];
  for (const raw of cases) {
    const err = assertThrows(() => parseFrame(raw), WireError);
    assertEquals(err.code, "bad-frame");
  }
});

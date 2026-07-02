import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  base64urlToBytes,
  bytesToBase64url,
  derivePathToken,
  deriveSharedSecret,
  exportPublicKeyRaw,
  generateEcdhKeyPair,
  generateFragmentSecret,
  importPublicKeyRaw,
} from "./crypto.ts";

Deno.test("generateFragmentSecret returns 32 bytes, fresh each call", () => {
  const a = generateFragmentSecret();
  const b = generateFragmentSecret();
  assertEquals(a.length, 32);
  assertEquals(b.length, 32);
  assertNotEquals(bytesToBase64url(a), bytesToBase64url(b));
});

Deno.test("base64url round-trips arbitrary bytes", () => {
  for (const len of [0, 1, 2, 3, 31, 32, 33, 64]) {
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    const encoded = bytesToBase64url(bytes);
    assertMatch(encoded, /^[A-Za-z0-9_-]*$/);
    assertEquals(base64urlToBytes(encoded), bytes);
  }
});

Deno.test("bytesToBase64url uses the -_ alphabet with no padding", () => {
  // These bytes encode to "++//" in plain base64 (plus "=" padding rules
  // would apply at other lengths); base64url must emit "--__" instead.
  assertEquals(bytesToBase64url(new Uint8Array([0xfb, 0xef, 0xff])), "--__");
  // 1 byte → 2 chars, no "=" padding.
  assertEquals(bytesToBase64url(new Uint8Array([0x00])), "AA");
});

Deno.test("base64urlToBytes throws TypeError on invalid input", () => {
  assertThrows(() => base64urlToBytes("not valid!"), TypeError);
  assertThrows(() => base64urlToBytes("abc+"), TypeError); // plain-base64 char
  assertThrows(() => base64urlToBytes("ab/c"), TypeError); // plain-base64 char
  assertThrows(() => base64urlToBytes("abc="), TypeError); // padding char
  assertThrows(() => base64urlToBytes("abcde"), TypeError); // len % 4 === 1
});

Deno.test("derivePathToken is deterministic, 22-char base64url", async () => {
  const secret = generateFragmentSecret();
  const t1 = await derivePathToken(secret);
  const t2 = await derivePathToken(secret);
  assertEquals(t1, t2);
  assertMatch(t1, /^[A-Za-z0-9_-]{22}$/);
});

Deno.test("derivePathToken known answer for 32 zero bytes", async () => {
  // SHA-256 of 32 zero bytes starts 66687aadf862bd776c8fc18b8e9f8e20…;
  // the first 16 bytes base64url-encode to this token.
  assertEquals(
    await derivePathToken(new Uint8Array(32)),
    "Zmh6rfhivXdsj8GLjp-OIA",
  );
});

Deno.test("distinct fragment secrets produce distinct path tokens", async () => {
  const t1 = await derivePathToken(generateFragmentSecret());
  const t2 = await derivePathToken(generateFragmentSecret());
  assertNotEquals(t1, t2);
});

Deno.test("generateEcdhKeyPair: P-256, non-extractable private key", async () => {
  const pair = await generateEcdhKeyPair();
  assertEquals(pair.privateKey.type, "private");
  assertEquals(pair.privateKey.extractable, false);
  assertEquals(pair.privateKey.usages, ["deriveBits"]);
  assertEquals(pair.publicKey.type, "public");
  const alg = pair.privateKey.algorithm as EcKeyAlgorithm;
  assertEquals(alg.name, "ECDH");
  assertEquals(alg.namedCurve, "P-256");
});

Deno.test("public key export/import round-trips via raw base64url", async () => {
  const pair = await generateEcdhKeyPair();
  const exported = await exportPublicKeyRaw(pair.publicKey);
  // 65-byte uncompressed P-256 point → 87 base64url chars.
  assertMatch(exported, /^[A-Za-z0-9_-]{87}$/);
  const imported = await importPublicKeyRaw(exported);
  assertEquals(await exportPublicKeyRaw(imported), exported);
});

Deno.test("importPublicKeyRaw rejects garbage and truncated points", async () => {
  const garbage = bytesToBase64url(new Uint8Array(65).fill(0xff));
  await assertRejects(() => importPublicKeyRaw(garbage));
  const short = bytesToBase64url(new Uint8Array(10).fill(4));
  await assertRejects(() => importPublicKeyRaw(short));
});

Deno.test("deriveSharedSecret: both sides derive the same 32 bytes", async () => {
  const alice = await generateEcdhKeyPair();
  const bob = await generateEcdhKeyPair();
  // Simulate the wire: each side only gets the peer's serialized key.
  const bobPub = await importPublicKeyRaw(
    await exportPublicKeyRaw(bob.publicKey),
  );
  const alicePub = await importPublicKeyRaw(
    await exportPublicKeyRaw(alice.publicKey),
  );
  const secretA = await deriveSharedSecret(alice.privateKey, bobPub);
  const secretB = await deriveSharedSecret(bob.privateKey, alicePub);
  assertEquals(secretA.byteLength, 32);
  assertEquals(new Uint8Array(secretA), new Uint8Array(secretB));
});

Deno.test("different keypairs derive different shared secrets", async () => {
  const alice = await generateEcdhKeyPair();
  const bob = await generateEcdhKeyPair();
  const mallory = await generateEcdhKeyPair();
  const ab = await deriveSharedSecret(alice.privateKey, bob.publicKey);
  const am = await deriveSharedSecret(alice.privateKey, mallory.publicKey);
  assertNotEquals(new Uint8Array(ab), new Uint8Array(am));
});

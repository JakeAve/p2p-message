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
  deriveSafetyCode,
  deriveSessionKey,
  deriveSharedSecret,
  exportPublicKeyRaw,
  generateEcdhKeyPair,
  generateFragmentSecret,
  importPublicKeyRaw,
  transcriptHash,
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

/** Run a two-sided ECDH handshake; returns each side's shared secret. */
async function handshake(): Promise<{
  secretA: ArrayBuffer;
  secretB: ArrayBuffer;
}> {
  const a = await generateEcdhKeyPair();
  const b = await generateEcdhKeyPair();
  return {
    secretA: await deriveSharedSecret(a.privateKey, b.publicKey),
    secretB: await deriveSharedSecret(b.privateKey, a.publicKey),
  };
}

Deno.test("deriveSessionKey returns a non-extractable AES-GCM-256 key", async () => {
  const { secretA } = await handshake();
  const key = await deriveSessionKey(generateFragmentSecret(), secretA);
  assertEquals(key.type, "secret");
  assertEquals(key.extractable, false);
  assertEquals([...key.usages].sort(), ["decrypt", "encrypt"]);
  const alg = key.algorithm as AesKeyAlgorithm;
  assertEquals(alg.name, "AES-GCM");
  assertEquals(alg.length, 256);
});

Deno.test("deriveSessionKey: both sides derive the same key", async () => {
  const fragment = generateFragmentSecret();
  const { secretA, secretB } = await handshake();
  const keyA = await deriveSessionKey(fragment, secretA);
  const keyB = await deriveSessionKey(fragment, secretB);
  // The keys are non-extractable, so prove equality by encrypting the same
  // plaintext under the same IV with each. Fixed IV is a TEST-ONLY probe —
  // production code must never reuse an IV.
  const iv = new Uint8Array(12);
  const msg = new TextEncoder().encode("probe");
  const ctA = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keyA, msg);
  const ctB = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keyB, msg);
  assertEquals(new Uint8Array(ctA), new Uint8Array(ctB));
});

Deno.test("deriveSafetyCode: same inputs → same code on both sides", async () => {
  const fragment = generateFragmentSecret();
  const { secretA, secretB } = await handshake();
  const codeA = await deriveSafetyCode(fragment, secretA);
  const codeB = await deriveSafetyCode(fragment, secretB);
  assertEquals(codeA, codeB);
});

Deno.test("deriveSafetyCode: different fragment secret → different code", async () => {
  // Fragment-binding property (spec §7.1): a party holding the path token
  // but not the fragment derives a different code than the intended peer.
  const { secretA } = await handshake();
  const codeReal = await deriveSafetyCode(generateFragmentSecret(), secretA);
  const codeIntruder = await deriveSafetyCode(
    generateFragmentSecret(),
    secretA,
  );
  assertNotEquals(codeReal, codeIntruder);
});

Deno.test("deriveSafetyCode is always exactly 6 decimal digits", async () => {
  // Property over many random inputs: shape is /^\d{6}$/ and derivation is
  // deterministic. ~50 trials makes a leading-zero code (10% chance each)
  // overwhelmingly likely to be exercised, covering padStart.
  for (let i = 0; i < 50; i++) {
    const fragment = generateFragmentSecret();
    const secret = crypto.getRandomValues(new Uint8Array(32)).buffer;
    const code = await deriveSafetyCode(fragment, secret);
    assertMatch(code, /^\d{6}$/);
    assertEquals(await deriveSafetyCode(fragment, secret), code);
  }
});

Deno.test("transcriptHash is order-independent", async () => {
  const a = "AAAApubkeyOfPeerA";
  const b = "ZZZZpubkeyOfPeerB";
  assertEquals(await transcriptHash(a, b), await transcriptHash(b, a));
});

Deno.test("transcriptHash: base64url shape, distinct for distinct keys", async () => {
  const h1 = await transcriptHash("keyOne", "keyTwo");
  const h2 = await transcriptHash("keyOne", "keyThree");
  assertMatch(h1, /^[A-Za-z0-9_-]{43}$/); // 32 hash bytes → 43 chars
  assertNotEquals(h1, h2);
});

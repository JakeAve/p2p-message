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
  decryptPayload,
  derivePathToken,
  deriveSafetyCode,
  deriveSessionKey,
  deriveSharedSecret,
  encryptPayload,
  exportPublicKeyRaw,
  generateEcdhKeyPair,
  generateFragmentSecret,
  importPublicKeyRaw,
  padPlaintext,
  transcriptHash,
  unpadPlaintext,
} from "./crypto.ts";
import { parseFrame, type Payload } from "../shared/wire.ts";

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

Deno.test("padPlaintext pads to the smallest bucket ≥ len+1", () => {
  const cases: Array<[number, number]> = [
    [0, 256],
    [1, 256],
    [255, 256], // 255 + 1 delimiter fills 256 exactly
    [256, 512], // one over the edge
    [511, 512],
    [512, 1024],
    [1023, 1024],
    [1024, 2048],
    [2047, 2048],
    [2048, 4096],
    [4095, 4096], // largest payload that fits
  ];
  for (const [len, bucket] of cases) {
    assertEquals(padPlaintext(new Uint8Array(len).fill(0x41)).length, bucket);
  }
});

Deno.test("padPlaintext throws RangeError beyond the largest bucket", () => {
  assertThrows(() => padPlaintext(new Uint8Array(4096)), RangeError);
  assertThrows(() => padPlaintext(new Uint8Array(10_000)), RangeError);
});

Deno.test("padPlaintext layout: content, 0x00 delimiter, 0x01 fill", () => {
  const padded = padPlaintext(new Uint8Array([0x41, 0x42]));
  assertEquals(padded.length, 256);
  assertEquals(padded[0], 0x41);
  assertEquals(padded[1], 0x42);
  assertEquals(padded[2], 0x00);
  for (let i = 3; i < padded.length; i++) {
    assertEquals(padded[i], 0x01);
  }
});

Deno.test("pad → unpad round-trips at bucket edges", () => {
  for (const len of [0, 1, 2, 255, 256, 1000, 2048, 4095]) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = (i % 255) + 1; // any non-zero pattern
    }
    assertEquals(unpadPlaintext(padPlaintext(bytes)), bytes);
  }
});

Deno.test("unpadPlaintext throws when the delimiter is missing", () => {
  assertThrows(() => unpadPlaintext(new Uint8Array(256).fill(0x01)), Error);
});

/** Fragment + fully-derived session keys for both sides of a handshake. */
async function securedPair(): Promise<{
  fragment: Uint8Array;
  keyA: CryptoKey;
  keyB: CryptoKey;
  secretA: ArrayBuffer;
}> {
  const fragment = generateFragmentSecret();
  const { secretA, secretB } = await handshake();
  return {
    fragment,
    keyA: await deriveSessionKey(fragment, secretA),
    keyB: await deriveSessionKey(fragment, secretB),
    secretA,
  };
}

Deno.test("encryptPayload → decryptPayload round-trips every payload type", async () => {
  const { keyA, keyB } = await securedPair();
  const payloads: Payload[] = [
    { type: "key-confirm", transcriptHash: "c29tZWhhc2g" },
    { type: "identity", displayName: "Ada 🔐" },
    { type: "chat", content: "the code to the safe is 4512" },
    { type: "end" },
  ];
  for (const payload of payloads) {
    const frame = await encryptPayload(keyA, payload);
    assertEquals(frame.v, 1);
    assertEquals(frame.type, "enc");
    assertEquals(await decryptPayload(keyB, frame), payload);
  }
});

Deno.test("encryptPayload emits a parseFrame-valid frame with fresh IVs", async () => {
  const { keyA } = await securedPair();
  const payload: Payload = { type: "chat", content: "hello" };
  const f1 = await encryptPayload(keyA, payload);
  const f2 = await encryptPayload(keyA, payload);
  assertEquals(parseFrame(JSON.stringify(f1)), f1);
  assertEquals(base64urlToBytes(f1.iv).length, 12);
  assertNotEquals(f1.iv, f2.iv); // fresh random IV per message
  assertNotEquals(f1.ct, f2.ct);
});

Deno.test("decryptPayload rejects tampered ciphertext with OperationError", async () => {
  const { keyA, keyB } = await securedPair();
  const frame = await encryptPayload(keyA, { type: "chat", content: "hi" });
  const ctBytes = base64urlToBytes(frame.ct);
  ctBytes[0] ^= 0xff; // flip bits in the first ciphertext byte
  const tampered = { ...frame, ct: bytesToBase64url(ctBytes) };
  const err = await assertRejects(
    () => decryptPayload(keyB, tampered),
    DOMException,
  );
  assertEquals(err.name, "OperationError");
});

Deno.test("decryptPayload rejects a wrong IV with OperationError", async () => {
  const { keyA, keyB } = await securedPair();
  const frame = await encryptPayload(keyA, { type: "chat", content: "hi" });
  const wrongIv = {
    ...frame,
    iv: bytesToBase64url(crypto.getRandomValues(new Uint8Array(12))),
  };
  const err = await assertRejects(
    () => decryptPayload(keyB, wrongIv),
    DOMException,
  );
  assertEquals(err.name, "OperationError");
});

Deno.test("fragment binding: wrong fragment secret cannot decrypt", async () => {
  // Spec §7.1: an interloper with the correct ECDH exchange but the wrong
  // fragment secret derives a different session key — decryption must fail
  // loudly (OperationError), never yield garbage.
  const { keyA, secretA } = await securedPair();
  const intruderKey = await deriveSessionKey(generateFragmentSecret(), secretA);
  const frame = await encryptPayload(keyA, {
    type: "chat",
    content: "ssn is 078-05-1120",
  });
  const err = await assertRejects(
    () => decryptPayload(intruderKey, frame),
    DOMException,
  );
  assertEquals(err.name, "OperationError");
});

Deno.test("encryptPayload propagates RangeError for oversized payloads", async () => {
  const { keyA } = await securedPair();
  const oversized: Payload = { type: "chat", content: "x".repeat(4200) };
  await assertRejects(() => encryptPayload(keyA, oversized), RangeError);
});

Deno.test("a 4000-byte chat message fits the largest bucket", async () => {
  // Spec §7.2: composer caps text at 4,000 UTF-8 bytes; the 96-byte margin
  // absorbs the JSON envelope overhead.
  const { keyA, keyB } = await securedPair();
  const payload: Payload = { type: "chat", content: "m".repeat(4000) };
  const frame = await encryptPayload(keyA, payload);
  assertEquals(await decryptPayload(keyB, frame), payload);
});

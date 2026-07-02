import {
  type EncryptedFrame,
  type Payload,
  WIRE_VERSION,
} from "../shared/wire.ts";

export function generateFragmentSecret(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new TypeError("invalid base64url string");
  }
  let binary: string;
  try {
    binary = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new TypeError("invalid base64url string");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function derivePathToken(
  fragmentSecret: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", fragmentSecret);
  return bytesToBase64url(new Uint8Array(hash, 0, 16));
}

export function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

export async function exportPublicKeyRaw(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bytesToBase64url(new Uint8Array(raw));
}

export function importPublicKeyRaw(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    base64urlToBytes(b64),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}

export function deriveSharedSecret(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
): Promise<ArrayBuffer> {
  return crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    privateKey,
    256,
  );
}

function importHkdfIkm(ikm: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveKey",
    "deriveBits",
  ]);
}

export async function deriveSessionKey(
  fragmentSecret: Uint8Array<ArrayBuffer>,
  sharedSecret: ArrayBuffer,
): Promise<CryptoKey> {
  const ikm = await importHkdfIkm(sharedSecret);
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: fragmentSecret,
      info: new TextEncoder().encode("p2p-msg/session-key/v1"),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function deriveSafetyCode(
  fragmentSecret: Uint8Array<ArrayBuffer>,
  sharedSecret: ArrayBuffer,
): Promise<string> {
  const ikm = await importHkdfIkm(sharedSecret);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: fragmentSecret,
      info: new TextEncoder().encode("p2p-msg/safety-code/v1"),
    },
    ikm,
    32,
  );
  const value = new DataView(bits).getUint32(0, false);
  return String(value % 1_000_000).padStart(6, "0");
}

export async function transcriptHash(
  pubKeyA: string,
  pubKeyB: string,
): Promise<string> {
  const [lo, hi] = [...[pubKeyA, pubKeyB]].sort();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${lo}|${hi}`),
  );
  return bytesToBase64url(new Uint8Array(digest));
}

const PADDING_BUCKETS = [256, 512, 1024, 2048, 4096];

export function padPlaintext(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const needed = bytes.length + 1; // content + 0x00 delimiter
  const bucket = PADDING_BUCKETS.find((size) => size >= needed);
  if (bucket === undefined) {
    throw new RangeError(
      `plaintext of ${bytes.length} bytes exceeds the largest padding bucket`,
    );
  }
  const padded = new Uint8Array(bucket).fill(0x01);
  padded.set(bytes);
  padded[bytes.length] = 0x00;
  return padded;
}

export function unpadPlaintext(padded: Uint8Array): Uint8Array {
  const delimiterIndex = padded.indexOf(0x00);
  if (delimiterIndex === -1) {
    throw new Error("padding delimiter not found");
  }
  return padded.slice(0, delimiterIndex);
}

export async function encryptPayload(
  key: CryptoKey,
  payload: Payload,
): Promise<EncryptedFrame> {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const padded = padPlaintext(plaintext);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    padded,
  );
  return {
    v: WIRE_VERSION,
    type: "enc",
    iv: bytesToBase64url(iv),
    ct: bytesToBase64url(new Uint8Array(ciphertext)),
  };
}

export async function decryptPayload(
  key: CryptoKey,
  frame: EncryptedFrame,
): Promise<Payload> {
  const padded = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64urlToBytes(frame.iv) },
    key,
    base64urlToBytes(frame.ct),
  );
  const plaintext = unpadPlaintext(new Uint8Array(padded));
  return JSON.parse(new TextDecoder().decode(plaintext)) as Payload;
}

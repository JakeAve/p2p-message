export function generateFragmentSecret(): Uint8Array {
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

export function base64urlToBytes(s: string): Uint8Array {
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
  fragmentSecret: Uint8Array,
): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    fragmentSecret as BufferSource,
  );
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
    base64urlToBytes(b64) as BufferSource,
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

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

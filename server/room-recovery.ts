// Self-issued, self-verified signed capability for stateless room recovery
// (docs/superpowers/specs/2026-07-07-stateless-room-recovery-design.md).
// Server-only — never imported by client code, and never carries the E2E
// fragment secret or any key material, only non-secret room metadata.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface RecoveryPayload {
  roomId: string;
  createdAt: number;
  pairedAt: number | null;
  inviteWindowMs: number;
  graceDurationMs: number;
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replaceAll("-", "+").replaceAll("_", "/") +
    "===".slice((s.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hmacSha256(secret: string, data: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", secret).update(data).digest());
}

/**
 * Sign a recovery payload. Deliberately SYNCHRONOUS (node:crypto's
 * createHmac, not crypto.subtle) — server/rooms.ts's join() relies on this
 * never yielding the event loop between a room-map miss and synthesizing a
 * recovered room, or two peers' simultaneous rejoins could both synthesize
 * independently (see the plan's Global Constraints).
 */
export function signRecoveryToken(
  payload: RecoveryPayload,
  secret: string,
): string {
  const body = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const sig = base64urlEncode(hmacSha256(secret, body));
  return `${body}.${sig}`;
}

/**
 * Verify and decode a recovery token. Returns null on ANY failure (bad
 * shape, bad signature, unparseable JSON, wrong field types) — callers
 * treat null exactly like "no token was presented."
 */
export function verifyRecoveryToken(
  token: string,
  secret: string,
): RecoveryPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;

  let providedSigBytes: Uint8Array;
  try {
    providedSigBytes = base64urlDecode(sig);
  } catch {
    return null;
  }
  const expectedSigBytes = hmacSha256(secret, body);
  if (
    providedSigBytes.length !== expectedSigBytes.length ||
    !timingSafeEqual(providedSigBytes, expectedSigBytes)
  ) {
    return null;
  }

  try {
    const json = new TextDecoder().decode(base64urlDecode(body));
    const payload = JSON.parse(json);
    if (
      typeof payload !== "object" || payload === null ||
      typeof payload.roomId !== "string" ||
      typeof payload.createdAt !== "number" ||
      (payload.pairedAt !== null && typeof payload.pairedAt !== "number") ||
      typeof payload.inviteWindowMs !== "number" ||
      typeof payload.graceDurationMs !== "number"
    ) {
      return null;
    }
    return payload as RecoveryPayload;
  } catch {
    return null;
  }
}

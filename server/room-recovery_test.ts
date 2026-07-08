import { assert, assertEquals } from "@std/assert";
import {
  type RecoveryPayload,
  signRecoveryToken,
  verifyRecoveryToken,
} from "./room-recovery.ts";

const SECRET = "test-secret-do-not-use-in-prod";

const BASE_PAYLOAD: RecoveryPayload = {
  roomId: "A".repeat(22),
  createdAt: 1_000_000,
  pairedAt: null,
  inviteWindowMs: 600_000,
  graceDurationMs: 120_000,
};

Deno.test("sign then verify round-trips the exact payload", () => {
  const token = signRecoveryToken(BASE_PAYLOAD, SECRET);
  const decoded = verifyRecoveryToken(token, SECRET);
  assertEquals(decoded, BASE_PAYLOAD);
});

Deno.test("verify round-trips a non-null pairedAt", () => {
  const payload: RecoveryPayload = { ...BASE_PAYLOAD, pairedAt: 1_500_000 };
  const token = signRecoveryToken(payload, SECRET);
  assertEquals(verifyRecoveryToken(token, SECRET), payload);
});

Deno.test("verify rejects a token signed with a different secret", () => {
  const token = signRecoveryToken(BASE_PAYLOAD, SECRET);
  assertEquals(verifyRecoveryToken(token, "wrong-secret"), null);
});

Deno.test("verify rejects a tampered payload (signature no longer matches)", () => {
  const token = signRecoveryToken(BASE_PAYLOAD, SECRET);
  const [_body, sig] = token.split(".");
  const tamperedPayload = { ...BASE_PAYLOAD, graceDurationMs: 999_999_999 };
  const tamperedBody = btoa(JSON.stringify(tamperedPayload))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  assertEquals(verifyRecoveryToken(`${tamperedBody}.${sig}`, SECRET), null);
});

Deno.test("verify rejects malformed tokens", () => {
  assertEquals(verifyRecoveryToken("", SECRET), null);
  assertEquals(verifyRecoveryToken("no-dot-here", SECRET), null);
  assertEquals(verifyRecoveryToken("a.b.c", SECRET), null);
  assertEquals(verifyRecoveryToken("not-base64!!!.also-not", SECRET), null);
});

Deno.test("verify rejects a body that decodes but isn't a valid payload shape", () => {
  // Sign a deliberately malformed payload (bypassing the type system) so
  // the signature check itself passes, isolating the shape-validation check.
  const token = signRecoveryToken(
    { roomId: 42 } as unknown as RecoveryPayload,
    SECRET,
  );
  assert(verifyRecoveryToken(token, SECRET) === null);
});

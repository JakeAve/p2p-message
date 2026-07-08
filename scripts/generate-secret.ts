/// One-off generator: prints a random secret suitable for env vars that take
/// a shared secret (ROOM_RECOVERY_SECRET, TURN_STATIC_SECRET) — 48 random
/// bytes, base64-encoded, matching `openssl rand -base64 48`. Run with
/// `deno task gen-secret`, then set the printed value as the env var
/// directly — never commit a generated value itself.
const bytes = crypto.getRandomValues(new Uint8Array(48));
console.log(btoa(String.fromCharCode(...bytes)));

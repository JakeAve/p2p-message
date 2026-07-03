import { assertEquals } from "@std/assert";
import { SECURITY_HEADERS, withSecurityHeaders } from "./static.ts";

Deno.test("SECURITY_HEADERS carries the three pinned headers exactly (C6)", () => {
  assertEquals(
    SECURITY_HEADERS["content-security-policy"],
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
      "connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'",
  );
  assertEquals(SECURITY_HEADERS["referrer-policy"], "no-referrer");
  assertEquals(SECURITY_HEADERS["x-content-type-options"], "nosniff");
});

Deno.test("withSecurityHeaders adds all three and preserves existing headers", async () => {
  const res = withSecurityHeaders(
    new Response("hi", {
      status: 418,
      headers: { "content-type": "text/plain" },
    }),
  );
  assertEquals(res.status, 418);
  assertEquals(res.headers.get("content-type"), "text/plain");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assertEquals(res.headers.get(name), value);
  }
  assertEquals(await res.text(), "hi");
});

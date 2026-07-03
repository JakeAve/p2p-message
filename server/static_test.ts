import { assert, assertEquals } from "@std/assert";
import {
  handleStaticRequest,
  SECURITY_HEADERS,
  THEME_BOOT_SCRIPT_HASH,
  withSecurityHeaders,
} from "./static.ts";

Deno.test("SECURITY_HEADERS carries the three pinned headers exactly (C6)", () => {
  assertEquals(
    SECURITY_HEADERS["content-security-policy"],
    `default-src 'self'; script-src 'self' '${THEME_BOOT_SCRIPT_HASH}'; ` +
      "style-src 'self'; " +
      "connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'",
  );
  assertEquals(SECURITY_HEADERS["referrer-policy"], "no-referrer");
  assertEquals(SECURITY_HEADERS["x-content-type-options"], "nosniff");
});

Deno.test("THEME_BOOT_SCRIPT_HASH matches the inline script in index.html", async () => {
  const html = await Deno.readTextFile(
    new URL("../index.html", import.meta.url),
  );
  const inline = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert(inline, "index.html has no bare inline <script> (theme boot)");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(inline[1]),
  );
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  assertEquals(
    THEME_BOOT_SCRIPT_HASH,
    `sha256-${b64}`,
    "inline theme-boot script changed — update THEME_BOOT_SCRIPT_HASH in static.ts",
  );
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

Deno.test("GET /themes/90s.css serves the theme stylesheet as text/css", async () => {
  const res = await handleStaticRequest(
    new Request("http://localhost/themes/90s.css"),
  );
  assert(res !== null);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/css; charset=utf-8");
  await res.body?.cancel();
});

Deno.test("unknown theme names and malformed theme paths are not served", async () => {
  for (
    const path of [
      "/themes/nope.css",
      "/themes/90s.CSS",
      "/themes/90s",
      "/themes/.css",
      "/themes/a/b.css",
      "/themes/..%2Fstyles.css",
      // Note: "/themes/%2e%2e/styles.css" is intentionally omitted — the
      // WHATWG URL parser normalizes it to "/styles.css" before this
      // handler ever sees `pathname`, so it hits the styles route (a real
      // 200 response) rather than the theme route. Confirmed empirically;
      // see task-3-report.md.
    ]
  ) {
    const res = await handleStaticRequest(
      new Request(`http://localhost${path}`),
    );
    assertEquals(res, null, path);
  }
});

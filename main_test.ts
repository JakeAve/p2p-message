import { assert, assertEquals } from "@std/assert";
import { handler } from "./main.ts";
import { SECURITY_HEADERS } from "./server/static.ts";

function assertSecurityHeaders(res: Response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assertEquals(res.headers.get(name), value, `missing/wrong header ${name}`);
  }
}

Deno.test("HTTP routes and security headers", async (t) => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, handler);
  const base = `http://127.0.0.1:${server.addr.port}`;

  await t.step("GET / serves the shell with headers", async () => {
    const res = await fetch(`${base}/`);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
    assertSecurityHeaders(res);
    const body = await res.text();
    assert(body.includes(`<div id="app">`));
    assert(body.includes(`<link rel="stylesheet" href="/styles.css">`));
    assert(body.includes(`<script type="module" src="/app.js">`));
    assert(!body.includes("<style"), "CSP forbids inline styles");
  });

  await t.step("GET /r/:pathToken serves the same shell", async () => {
    const res = await fetch(`${base}/r/${"A".repeat(22)}`);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
    assertSecurityHeaders(res);
    assert((await res.text()).includes(`<div id="app">`));
  });

  await t.step("malformed path token is a 404, with headers", async () => {
    for (const path of ["/r/too-short", `/r/${"A".repeat(23)}`, "/r/"]) {
      const res = await fetch(`${base}${path}`);
      assertEquals(res.status, 404, path);
      assertSecurityHeaders(res);
      await res.body?.cancel();
    }
  });

  await t.step("GET /styles.css serves CSS with headers", async () => {
    const res = await fetch(`${base}/styles.css`);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "text/css; charset=utf-8");
    assertSecurityHeaders(res);
    await res.body?.cancel();
  });

  await t.step(
    "GET /api/ice-servers still works and carries headers",
    async () => {
      const res = await fetch(`${base}/api/ice-servers`);
      assertEquals(res.status, 200);
      assertSecurityHeaders(res);
      const body = await res.json();
      assert(Array.isArray(body.iceServers));
    },
  );

  await t.step("unknown path is a 404 with headers", async () => {
    const res = await fetch(`${base}/definitely-not-a-route`);
    assertEquals(res.status, 404);
    assertSecurityHeaders(res);
    await res.body?.cancel();
  });

  await server.shutdown();
});

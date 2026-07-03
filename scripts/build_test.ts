import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path/from-file-url";
import { handler } from "../main.ts";

const repoRoot = fromFileUrl(new URL("../", import.meta.url));

Deno.test("deno task build produces a servable, minified dist/app.js", async () => {
  const build = await new Deno.Command(Deno.execPath(), {
    args: ["task", "build"],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(build.success, new TextDecoder().decode(build.stderr));

  const stat = await Deno.stat(new URL("../dist/app.js", import.meta.url));
  assert(stat.isFile);
  assert(stat.size > 10_000, `bundle suspiciously small: ${stat.size} bytes`);

  // The built bundle is what /app.js serves, with security headers.
  const server = Deno.serve({ port: 0, onListen: () => {} }, handler);
  const res = await fetch(`http://127.0.0.1:${server.addr.port}/app.js`);
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("content-type"),
    "application/javascript; charset=utf-8",
  );
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  assertEquals(res.headers.get("referrer-policy"), "no-referrer");
  const body = await res.text();
  assert(body.length > 10_000);
  assert(!body.includes("\n  "), "bundle should be minified");
  await server.shutdown();
});

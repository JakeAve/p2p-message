import { assert, assertEquals } from "@std/assert";
import { buildShareLink, fragmentMatchesPath, parseRoute } from "./routing.ts";
import {
  bytesToBase64url,
  derivePathToken,
  generateFragmentSecret,
} from "../crypto.ts";

const TOKEN = "A".repeat(22); // shape-valid path token
const FRAGMENT = "B".repeat(43); // shape-valid fragment (43-char base64url)

Deno.test("parseRoute: / is the create page", () => {
  assertEquals(parseRoute("/", ""), { view: "create" });
});

Deno.test("parseRoute: /r/:token with a well-formed fragment is a join", () => {
  assertEquals(parseRoute(`/r/${TOKEN}`, `#${FRAGMENT}`), {
    view: "join",
    pathToken: TOKEN,
    fragment: FRAGMENT,
  });
});

Deno.test("parseRoute: join with a missing fragment is invalid-link", () => {
  assertEquals(parseRoute(`/r/${TOKEN}`, ""), { view: "invalid-link" });
  assertEquals(parseRoute(`/r/${TOKEN}`, "#"), { view: "invalid-link" });
});

Deno.test("parseRoute: malformed token or fragment is invalid-link", () => {
  assertEquals(parseRoute("/r/too-short", `#${FRAGMENT}`), {
    view: "invalid-link",
  });
  assertEquals(parseRoute(`/r/${TOKEN}`, `#${"B".repeat(42)}`), {
    view: "invalid-link",
  }); // truncated fragment
  assertEquals(parseRoute(`/r/${TOKEN}`, `#${FRAGMENT}!`), {
    view: "invalid-link",
  }); // non-base64url char
});

Deno.test("parseRoute: anything else is not-found", () => {
  assertEquals(parseRoute("/nope", ""), { view: "not-found" });
  assertEquals(parseRoute("/r/", ""), { view: "not-found" });
  assertEquals(parseRoute(`/r/${TOKEN}/extra`, ""), { view: "not-found" });
});

Deno.test("buildShareLink assembles https://host/r/<token>#<fragment>", () => {
  assertEquals(
    buildShareLink("https://example.com", TOKEN, FRAGMENT),
    `https://example.com/r/${TOKEN}#${FRAGMENT}`,
  );
});

Deno.test("fragmentMatchesPath: true for a genuinely derived pair", async () => {
  const secret = generateFragmentSecret();
  const fragment = bytesToBase64url(secret);
  const pathToken = await derivePathToken(secret);
  assertEquals(await fragmentMatchesPath(fragment, pathToken), true);
});

Deno.test("fragmentMatchesPath: false for a tampered fragment (mangled copy/paste)", async () => {
  const secret = generateFragmentSecret();
  const fragment = bytesToBase64url(secret);
  const pathToken = await derivePathToken(secret);
  const tampered = (fragment[0] === "A" ? "B" : "A") + fragment.slice(1);
  assertEquals(await fragmentMatchesPath(tampered, pathToken), false);
});

Deno.test("fragmentMatchesPath: false (not a throw) for undecodable input", async () => {
  assertEquals(await fragmentMatchesPath("!!!not-base64url!!!", TOKEN), false);
  assertEquals(await fragmentMatchesPath("", TOKEN), false);
});

Deno.test("fragmentMatchesPath: false for wrong-length key material", async () => {
  // 42 chars decodes fine but is not 32 bytes
  assert(!(await fragmentMatchesPath("B".repeat(42), TOKEN)));
});

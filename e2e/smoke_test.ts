// End-to-end smoke test (spec §9): two headless Chromium pages exchange an
// encrypted message through a locally spawned server instance.
//
// Run with:
//   deno task e2e:install   # once per machine: download Playwright's Chromium
//   deno task e2e
//
// Uses the Playwright LIBRARY API (npm:playwright) inside a plain Deno.test —
// deliberately NOT the @playwright/test runner: no playwright.config, no
// package.json; assertions come from @std/assert.
//
// Requires a real Chromium, installed into ~/.cache/ms-playwright by
// `deno task e2e:install` (also run once by `deno task setup`; CI must cache
// ~/.cache/ms-playwright between runs). Not part of `deno task test` or the
// pre-commit hook (no browser needed for those), but IS part of `pre-push`
// via `deno task e2e` — pushing requires Chromium to already be installed.
//
// The spawned server in startServer() below runs with only
// --allow-net/--allow-read/--allow-env (no --allow-run/--allow-write), so it
// serves the prebuilt dist/app.js rather than bundling on the fly. Always
// run this test through `deno task e2e` (which builds first) — a bare
// `deno test -A e2e` against a missing or stale dist/ will hang waiting for
// "secure" with no indication that the bundle is the problem.
//
// STUN-only env: localhost-to-localhost WebRTC gathers host candidates and
// needs no TURN relay (and no STUN reply either — the STUN URL is present
// only so the ICE config code path is realistic).

import { type BrowserContext, chromium, type Page } from "playwright";
import { assert, assertEquals, assertMatch } from "@std/assert";

const SHARE_LINK_RE =
  /^https?:\/\/[^/]+\/r\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$/;
const SECURE_TIMEOUT_MS = 30_000; // signaling + ICE + handshake + key-confirm
const UI_TIMEOUT_MS = 15_000; // any single UI reaction

/** Poll until the spawned server accepts HTTP; bounded. (Pre-browser, so no
 * Playwright waiter is available for this one — everything page-level below
 * uses Playwright's built-in auto-waiting instead.) */
async function waitForServer(
  baseUrl: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl);
      await res.body?.cancel();
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for server at ${baseUrl}`,
  );
}

/** Wait until [data-e2e="status"] carries data-status={status}. */
function waitForStatus(
  page: Page,
  status: string,
  timeoutMs = SECURE_TIMEOUT_MS,
) {
  return page.waitForSelector(`[data-e2e="status"][data-status="${status}"]`, {
    state: "attached",
    timeout: timeoutMs,
  });
}

/** Trimmed text of the first match; handles <input> value vs textContent. */
async function readText(page: Page, selector: string): Promise<string> {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
  const tag = await locator.evaluate((el) => el.tagName);
  const raw = tag === "INPUT" || tag === "TEXTAREA"
    ? await locator.inputValue()
    : (await locator.textContent()) ?? "";
  return raw.trim();
}

/** Probe a free TCP port by binding port 0 and releasing it. */
function freePort(): number {
  const listener = Deno.listen({ port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/** Spawn `main.ts` as a child process in a STUN-only env; resolve when serving.
 * `port`, if given, binds there instead of probing a fresh one — used to put
 * a second server exactly where a first one used to be, simulating a real
 * instance replacement (Deno Deploy isolate eviction/cold-start) rather than
 * a brand-new deployment on a brand-new address. */
async function startServer(
  opts: { port?: number; roomRecoverySecret?: string } = {},
): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const port = opts.port ?? freePort();
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-read", "--allow-env", "main.ts"],
    cwd: new URL("..", import.meta.url).pathname, // repo root
    env: {
      PORT: String(port),
      ICE_STUN_SERVERS: "stun:stun.l.google.com:19302",
      ICE_TURN_SERVERS: "", // STUN-only: empty means "no TURN" (see Step 5)
      ...(opts.roomRecoverySecret
        ? { ROOM_RECOVERY_SECRET: opts.roomRecoverySecret }
        : {}),
    },
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const baseUrl = `http://localhost:${port}`;
  await waitForServer(baseUrl);
  return {
    baseUrl,
    stop: async () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
      await child.status;
    },
  };
}

Deno.test(
  "smoke: create -> join -> secure -> matching safety codes -> chat -> end",
  async () => {
    const server = await startServer();
    // One browser process; creator and joiner each get their own isolated
    // BrowserContext (separate cookies/storage/state) — cleaner peer
    // isolation than two pages sharing one context.
    const browser = await chromium.launch();
    let contextA: BrowserContext | undefined;
    let contextB: BrowserContext | undefined;
    try {
      // --- A creates a room with the default presets ---
      contextA = await browser.newContext();
      const pageA = await contextA.newPage();
      await pageA.goto(`${server.baseUrl}/`);
      await pageA.click('[data-e2e="create"]', { timeout: UI_TIMEOUT_MS });

      // --- A's share panel shows the generated link ---
      const shareLink = await readText(pageA, '[data-e2e="share-link"]');
      assertMatch(shareLink, SHARE_LINK_RE);

      // --- B opens the link in its own context; both sides reach "secure" ---
      contextB = await browser.newContext();
      const pageB = await contextB.newPage();
      await pageB.goto(shareLink);
      await waitForStatus(pageA, "secure");
      await waitForStatus(pageB, "secure");

      // --- Safety codes: 6 digits, equal on both sides (spec §8.3) ---
      const codeA = await readText(pageA, '[data-e2e="safety-code"]');
      const codeB = await readText(pageB, '[data-e2e="safety-code"]');
      assertMatch(codeA, /^\d{6}$/);
      assertEquals(
        codeA,
        codeB,
        "both peers must display the same safety code",
      );

      // --- Chat A -> B ---
      const messageText = `hello from A ${crypto.randomUUID()}`;
      await pageA.fill('[data-e2e="composer"]', messageText, {
        timeout: UI_TIMEOUT_MS,
      });
      await pageA.click('[data-e2e="send"]', { timeout: UI_TIMEOUT_MS });
      await pageB
        .locator('[data-e2e="message"]')
        .filter({ hasText: messageText })
        .first()
        .waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });

      // --- A ends the chat; B lands on the ended screen ---
      await pageA.click('[data-e2e="end-chat"]', { timeout: UI_TIMEOUT_MS });
      try {
        // Exists only if plan 4 added an in-page confirm step (Task 1).
        await pageA.click('[data-e2e="end-confirm"]', { timeout: 2_000 });
      } catch {
        // no confirm step — End chat acted immediately
      }
      await pageB.waitForSelector('[data-e2e="ended-screen"]', {
        state: "attached",
        timeout: UI_TIMEOUT_MS,
      });
    } finally {
      // Close everything even on failure so Deno's op/resource sanitizers
      // (left at their defaults) come up clean.
      await contextA?.close();
      await contextB?.close();
      await browser.close();
      await server.stop();
    }
  },
);

Deno.test(
  "recovery: instance replacement mid-chat recovers via signed token, not a reload",
  async () => {
    // This is the literal production bug this feature exists to fix: the
    // process serving a room dies (here: we kill it outright and start a
    // new one on the SAME port, standing in for a Deno Deploy isolate
    // eviction/cold-start) — not a page reload, not a network drop. The
    // two peers' actual chat (P2P WebRTC) is untouched by this; only the
    // signaling server disappears and comes back with an empty room map.
    const port = freePort();
    const secret = "e2e-test-recovery-secret";
    let server = await startServer({ port, roomRecoverySecret: secret });
    const browser = await chromium.launch();
    let contextA: BrowserContext | undefined;
    let contextB: BrowserContext | undefined;
    try {
      contextA = await browser.newContext();
      const pageA = await contextA.newPage();
      await pageA.goto(`${server.baseUrl}/`);
      await pageA.click('input[name="grace"][value="30000"]', {
        timeout: UI_TIMEOUT_MS,
      });
      await pageA.click('[data-e2e="create"]', { timeout: UI_TIMEOUT_MS });

      // The share link is first rendered without a recovery token (the
      // token only exists once the server's "created" response comes back)
      // and is patched in place moments later — see the "recovery-token"
      // event handler in client/app.ts. Wait for that patch before reading,
      // rather than racing it.
      await pageA.waitForFunction(
        () => {
          const input = document.querySelector(
            '[data-e2e="share-link"]',
          ) as HTMLInputElement | null;
          return !!input && input.value.includes("?rc=");
        },
        undefined,
        { timeout: UI_TIMEOUT_MS },
      );
      const shareLink = await readText(pageA, '[data-e2e="share-link"]');
      // The link now carries ?rc=<token> ahead of the fragment.
      assert(
        shareLink.includes("?rc="),
        "share link should carry a recovery token",
      );

      contextB = await browser.newContext();
      const pageB = await contextB.newPage();
      await pageB.goto(shareLink);
      await waitForStatus(pageA, "secure");
      await waitForStatus(pageB, "secure");

      const codeBeforeA = await readText(pageA, '[data-e2e="safety-code"]');
      const codeBeforeB = await readText(pageB, '[data-e2e="safety-code"]');
      assertEquals(codeBeforeA, codeBeforeB);

      // --- Kill the server outright and start a brand-new process on the
      // same port with an empty RoomRegistry, sharing only the secret. ---
      await server.stop();
      server = await startServer({ port, roomRecoverySecret: secret });

      // Both peers' signaling sockets just died along with the old process;
      // the client's existing signaling-lost handling should notice and
      // rejoin automatically — no page interaction needed.
      await waitForStatus(pageA, "reconnecting");
      await waitForStatus(pageB, "reconnecting");
      await waitForStatus(pageA, "secure", UI_TIMEOUT_MS);
      await waitForStatus(pageB, "secure", UI_TIMEOUT_MS);

      // Rekeyed (spec §8.3) — a fresh, still-matching safety code.
      const codeAfterA = await readText(pageA, '[data-e2e="safety-code"]');
      const codeAfterB = await readText(pageB, '[data-e2e="safety-code"]');
      assertEquals(codeAfterA, codeAfterB);
      assertMatch(codeAfterA, /^\d{6}$/);

      // Chat still works against the new process.
      const messageText =
        `hello after instance replacement ${crypto.randomUUID()}`;
      await pageB.fill('[data-e2e="composer"]', messageText, {
        timeout: UI_TIMEOUT_MS,
      });
      await pageB.click('[data-e2e="send"]', { timeout: UI_TIMEOUT_MS });
      await pageA
        .locator('[data-e2e="message"]')
        .filter({ hasText: messageText })
        .first()
        .waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
    } finally {
      await contextA?.close();
      await contextB?.close();
      await browser.close();
      await server.stop();
    }
  },
);

Deno.test(
  "recovery: page reload after instance replacement recovers via the URL-embedded token",
  async () => {
    // Closes a gap the previous test doesn't cover: that test proves
    // automatic same-tab rejoin (the in-memory recovery token, still held by
    // the live Session object). This test proves the OTHER persistence path
    // from the design (§3, "Path B") — a genuinely fresh page load has no
    // in-memory Session at all, so if it recovers after the server process
    // has already been replaced, it can only be via the recovery token
    // embedded in the URL's ?rc= param, patched into the address bar by
    // history.replaceState (client/app.ts's "recovery-token" handler).
    const port = freePort();
    const secret = "e2e-test-recovery-secret-reload";
    let server = await startServer({ port, roomRecoverySecret: secret });
    const browser = await chromium.launch();
    let contextA: BrowserContext | undefined;
    let contextB: BrowserContext | undefined;
    try {
      contextA = await browser.newContext();
      const pageA = await contextA.newPage();
      await pageA.goto(`${server.baseUrl}/`);
      await pageA.click('input[name="grace"][value="30000"]', {
        timeout: UI_TIMEOUT_MS,
      });
      await pageA.click('[data-e2e="create"]', { timeout: UI_TIMEOUT_MS });

      // Wait for A's own address bar (not just the displayed share panel)
      // to carry the recovery token — history.replaceState patches it there
      // right after "created".
      await pageA.waitForFunction(
        () => location.href.includes("?rc="),
        undefined,
        { timeout: UI_TIMEOUT_MS },
      );
      const shareLink = await readText(pageA, '[data-e2e="share-link"]');
      assert(
        shareLink.includes("?rc="),
        "share link should carry a recovery token",
      );

      contextB = await browser.newContext();
      const pageB = await contextB.newPage();
      await pageB.goto(shareLink);
      await waitForStatus(pageA, "secure");
      await waitForStatus(pageB, "secure");

      const codeBeforeA = await readText(pageA, '[data-e2e="safety-code"]');
      const codeBeforeB = await readText(pageB, '[data-e2e="safety-code"]');
      assertEquals(codeBeforeA, codeBeforeB);

      // A's address bar should now carry the re-issued PAIRED token
      // (re-patched on pairing) — confirm before relying on it surviving a
      // real navigation.
      assert(
        pageA.url().includes("?rc="),
        "creator's address bar should carry the paired recovery token",
      );

      // --- Kill the server outright and start a brand-new process on the
      // same port with an empty RoomRegistry, sharing only the secret. ---
      await server.stop();
      server = await startServer({ port, roomRecoverySecret: secret });

      // --- A does a REAL page reload: no in-memory Session survives this,
      // so any recovery MUST come from the ?rc= token already sitting in
      // A's own address bar, not from an in-session automatic retry. B's
      // own live tab recovers on its own via the already-proven automatic
      // path, purely as a side effect of the same server-side event — not
      // what this test is specifically checking. ---
      await pageA.reload();

      await waitForStatus(pageA, "secure", UI_TIMEOUT_MS);
      await waitForStatus(pageB, "secure", UI_TIMEOUT_MS);

      // Rekeyed (spec §8.3) — a fresh, still-matching safety code.
      const codeAfterA = await readText(pageA, '[data-e2e="safety-code"]');
      const codeAfterB = await readText(pageB, '[data-e2e="safety-code"]');
      assertEquals(codeAfterA, codeAfterB);
      assertMatch(codeAfterA, /^\d{6}$/);

      // Chat still works against the new process.
      const messageText = `hello after reload-recovery ${crypto.randomUUID()}`;
      await pageB.fill('[data-e2e="composer"]', messageText, {
        timeout: UI_TIMEOUT_MS,
      });
      await pageB.click('[data-e2e="send"]', { timeout: UI_TIMEOUT_MS });
      await pageA
        .locator('[data-e2e="message"]')
        .filter({ hasText: messageText })
        .first()
        .waitFor({ state: "attached", timeout: UI_TIMEOUT_MS });
    } finally {
      await contextA?.close();
      await contextB?.close();
      await browser.close();
      await server.stop();
    }
  },
);

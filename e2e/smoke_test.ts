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
// Deliberately NOT part of `deno task test` / pre-commit / pre-push: it
// launches a real Chromium, installed into ~/.cache/ms-playwright by
// `deno task e2e:install`. CI note: run this as a manual or nightly job
// that runs `deno task e2e:install` first (cache ~/.cache/ms-playwright
// between runs) — never as a pre-commit/pre-push gate.
//
// STUN-only env: localhost-to-localhost WebRTC gathers host candidates and
// needs no TURN relay (and no STUN reply either — the STUN URL is present
// only so the ICE config code path is realistic).

import { type BrowserContext, chromium, type Page } from "playwright";
import { assertEquals, assertMatch } from "@std/assert";

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

/** Spawn `main.ts` as a child process in a STUN-only env; resolve when serving. */
async function startServer(): Promise<
  { baseUrl: string; stop: () => Promise<void> }
> {
  const port = freePort();
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-read", "--allow-env", "main.ts"],
    cwd: new URL("..", import.meta.url).pathname, // repo root
    env: {
      PORT: String(port),
      ICE_STUN_SERVERS: "stun:stun.l.google.com:19302",
      ICE_TURN_SERVERS: "", // STUN-only: empty means "no TURN" (see Step 5)
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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { getIceServers, getTurnCredentials } from "./ice-config.ts";

const ENV_KEYS = [
  "ICE_STUN_SERVERS",
  "ICE_TURN_SERVERS",
  "TURN_STATIC_SECRET",
  "TURN_CREDENTIAL_TTL",
  "CLOUDFLARE_TURN_KEY_ID",
  "CLOUDFLARE_TURN_TOKEN",
  "CLOUDFLARE_TURN_TTL",
] as const;

async function withEnv(
  env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => Promise<void>,
) {
  const saved = ENV_KEYS.map((k) => [k, Deno.env.get(k)] as const);
  try {
    for (const k of ENV_KEYS) Deno.env.delete(k);
    for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("STUN only: parses comma-separated list, no TURN entry", async () => {
  await withEnv(
    {
      ICE_STUN_SERVERS:
        "stun:stun.l.google.com:19302, stun:stun1.l.google.com:19302",
    },
    async () => {
      const { iceServers } = await getIceServers();
      assertEquals(iceServers, [{
        urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
      }]);
    },
  );
});

Deno.test("no env at all: falls back to the default public STUN servers", async () => {
  await withEnv({}, async () => {
    const { iceServers } = await getIceServers();
    assertEquals(iceServers, [{
      urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
    }]);
  });
});

Deno.test("TURN set with secret: entry carries ephemeral credentials", async () => {
  await withEnv(
    {
      ICE_STUN_SERVERS: "stun:stun.example.com:19302",
      ICE_TURN_SERVERS:
        "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp",
      TURN_STATIC_SECRET: "a".repeat(32),
      TURN_CREDENTIAL_TTL: "600",
    },
    async () => {
      const { iceServers } = await getIceServers();
      assertEquals(iceServers.length, 2);
      assertEquals(iceServers[0], { urls: ["stun:stun.example.com:19302"] });
      const turn = iceServers[1];
      assertEquals(turn.urls, [
        "turn:turn.example.com:3478?transport=udp",
        "turns:turn.example.com:5349?transport=tcp",
      ]);
      const username = Number(turn.username);
      const nowSec = Math.floor(Date.now() / 1000);
      // username = expiry unix time = now + ttl (600)
      assert(username >= nowSec + 595 && username <= nowSec + 605);
      assert(typeof turn.credential === "string" && turn.credential.length > 0);
    },
  );
});

Deno.test("TURN URLs set but TURN_STATIC_SECRET missing: TURN omitted", async () => {
  await withEnv(
    {
      ICE_STUN_SERVERS: "stun:stun.example.com:19302",
      ICE_TURN_SERVERS: "turn:turn.example.com:3478",
    },
    async () => {
      const { iceServers } = await getIceServers();
      assertEquals(iceServers, [{ urls: ["stun:stun.example.com:19302"] }]);
    },
  );
});

Deno.test("getTurnCredentials: deterministic HMAC-SHA1, base64", async () => {
  await withEnv(
    { TURN_STATIC_SECRET: "test-secret-0123456789abcdef" },
    async () => {
      const nowMs = 1_750_000_000_000;
      const a = await getTurnCredentials(3600, nowMs);
      const b = await getTurnCredentials(3600, nowMs);
      assertEquals(a.username, String(Math.floor(nowMs / 1000) + 3600));
      assertEquals(a, b); // same inputs → same credential
      // HMAC-SHA1 is 20 bytes → 28 chars of padded base64
      assertEquals(a.credential.length, 28);
      // different expiry → different credential
      const c = await getTurnCredentials(7200, nowMs);
      assert(c.credential !== a.credential);
    },
  );
});

Deno.test("getTurnCredentials throws without TURN_STATIC_SECRET", async () => {
  await withEnv({}, async () => {
    await assertRejects(() => getTurnCredentials(3600), Error);
  });
});

Deno.test("Cloudflare TURN configured: calls generate-ice-servers and takes priority over coturn env", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl: string | undefined;
  let requestedInit: RequestInit | undefined;
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    requestedUrl = String(url);
    requestedInit = init;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          iceServers: [{
            urls: [
              "stun:stun.cloudflare.com:3478",
              "turn:turn.cloudflare.com:3478?transport=udp",
              "turn:turn.cloudflare.com:3478?transport=tcp",
              "turns:turn.cloudflare.com:5349?transport=tcp",
            ],
            username: "cf-user",
            credential: "cf-cred",
          }],
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  try {
    await withEnv(
      {
        ICE_STUN_SERVERS: "stun:should-be-ignored.example.com:19302",
        ICE_TURN_SERVERS: "turn:should-be-ignored.example.com:3478",
        TURN_STATIC_SECRET: "a".repeat(32),
        CLOUDFLARE_TURN_KEY_ID: "key-id",
        CLOUDFLARE_TURN_TOKEN: "token",
        CLOUDFLARE_TURN_TTL: "600",
      },
      async () => {
        const { iceServers } = await getIceServers();
        assertEquals(iceServers, [{
          urls: [
            "stun:stun.cloudflare.com:3478",
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turn:turn.cloudflare.com:3478?transport=tcp",
            "turns:turn.cloudflare.com:5349?transport=tcp",
          ],
          username: "cf-user",
          credential: "cf-cred",
        }]);
      },
    );
    assertEquals(
      requestedUrl,
      "https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers",
    );
    assertEquals(requestedInit?.method, "POST");
    assertEquals(
      (requestedInit?.headers as Record<string, string>)["Authorization"],
      "Bearer token",
    );
    assertEquals(JSON.parse(requestedInit?.body as string), { ttl: 600 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Cloudflare TURN request failure: rejects with status and body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("bad token", { status: 401 }),
    )) as typeof fetch;

  try {
    await withEnv(
      { CLOUDFLARE_TURN_KEY_ID: "key-id", CLOUDFLARE_TURN_TOKEN: "bad-token" },
      async () => {
        await assertRejects(() => getIceServers(), Error, "401");
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

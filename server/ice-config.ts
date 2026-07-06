/**
 * ICE server configuration from env (spec §4).
 *
 *   ICE_STUN_SERVERS=stun:host:port,stun:host:port
 *   ICE_TURN_SERVERS=turn:host:3478?transport=udp,turns:host:5349?transport=tcp
 *   TURN_STATIC_SECRET=<shared with coturn's static-auth-secret>
 *   TURN_CREDENTIAL_TTL=3600
 *
 * If ICE_STUN_SERVERS is unset, falls back to Google's public STUN servers
 * so ICE works out of the box without any config.
 *
 * TURN entries carry ephemeral credentials (coturn use-auth-secret REST
 * scheme): username is the expiry unix timestamp, credential is
 * base64(HMAC-SHA1(secret, username)). coturn re-derives and validates the
 * same HMAC, so the secret never leaves the server.
 *
 * Alternatively, set these to use Cloudflare's managed Realtime TURN
 * service (pay-per-GB, no self-hosted coturn needed) instead of the above:
 *
 *   CLOUDFLARE_TURN_KEY_ID=<Turn Key ID from the Cloudflare dashboard>
 *   CLOUDFLARE_TURN_TOKEN=<Turn Key API Token>
 *   CLOUDFLARE_TURN_TTL=86400
 *
 * When set, these take priority over ICE_TURN_SERVERS/TURN_STATIC_SECRET:
 * we call Cloudflare's credentials.generate endpoint per request to mint a
 * short-lived username/credential pair, so no shared secret is embedded in
 * this app.
 */

export interface TurnCredentials {
  username: string;
  credential: string;
}

export async function getTurnCredentials(
  ttlSeconds?: number,
  nowMs: number = Date.now(),
): Promise<TurnCredentials> {
  const secret = Deno.env.get("TURN_STATIC_SECRET");
  if (!secret) {
    throw new Error("TURN_STATIC_SECRET is not set");
  }
  const ttl = ttlSeconds ??
    Number(Deno.env.get("TURN_CREDENTIAL_TTL") ?? "3600");
  const username = `${Math.floor(nowMs / 1000) + ttl}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(username),
  );
  const credential = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return { username, credential };
}

interface CloudflareTurnResponse {
  iceServers: RTCIceServer[];
}

/**
 * Mints short-lived STUN+TURN credentials via Cloudflare's Realtime API.
 * The generate-ice-servers endpoint returns an array of RTCIceServer entries
 * ready to pass straight to RTCPeerConnection, including Cloudflare's own
 * STUN server — so callers should use this array as-is, not merge it with
 * a separately configured STUN entry.
 */
export async function getCloudflareTurnCredentials(): Promise<RTCIceServer[]> {
  const keyId = Deno.env.get("CLOUDFLARE_TURN_KEY_ID");
  const token = Deno.env.get("CLOUDFLARE_TURN_TOKEN");
  if (!keyId || !token) {
    throw new Error("CLOUDFLARE_TURN_KEY_ID/CLOUDFLARE_TURN_TOKEN are not set");
  }
  const ttl = Number(Deno.env.get("CLOUDFLARE_TURN_TTL") ?? "86400");
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Cloudflare TURN credential request failed: ${res.status} ${await res
        .text()}`,
    );
  }
  const { iceServers }: CloudflareTurnResponse = await res.json();
  return iceServers;
}

function parseUrlList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Used when ICE_STUN_SERVERS is unset, so local/self-hosted setups get working ICE out of the box. */
const DEFAULT_STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
];

export async function getIceServers(): Promise<{ iceServers: RTCIceServer[] }> {
  if (
    Deno.env.get("CLOUDFLARE_TURN_KEY_ID") &&
    Deno.env.get("CLOUDFLARE_TURN_TOKEN")
  ) {
    return { iceServers: await getCloudflareTurnCredentials() };
  }

  const iceServers: RTCIceServer[] = [];

  const stunUrls = parseUrlList(Deno.env.get("ICE_STUN_SERVERS"));
  iceServers.push({ urls: stunUrls.length > 0 ? stunUrls : DEFAULT_STUN_URLS });

  const turnUrls = parseUrlList(Deno.env.get("ICE_TURN_SERVERS"));
  if (turnUrls.length > 0 && Deno.env.get("TURN_STATIC_SECRET")) {
    const { username, credential } = await getTurnCredentials();
    iceServers.push({ urls: turnUrls, username, credential });
  }

  return { iceServers };
}

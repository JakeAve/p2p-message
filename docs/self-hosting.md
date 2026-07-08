# Self-hosting

This app is a single Deno process: it serves the static client, a WebSocket
signaling endpoint (`/ws`), and `GET /api/ice-servers`. Messages never pass
through it — it only brokers WebRTC connection setup.

## Requirements

- Deno 2+
- A domain with TLS (WebRTC requires a secure context; terminate TLS at a
  reverse proxy — see below)
- Optional but recommended: a [coturn](https://github.com/coturn/coturn) TURN
  relay (see [coturn.md](./coturn.md))

## Run

```bash
deno install                 # fetch dependencies
deno task build              # bundle the client into dist/app.js
deno run --allow-net --allow-read --allow-env main.ts
```

Configuration is read from the environment; a `.env` file in the working
directory is loaded automatically. Already-set environment variables win over
`.env` values.

## `.env` reference

```bash
PORT=8000
ICE_STUN_SERVERS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
ICE_TURN_SERVERS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
TURN_STATIC_SECRET=<random 32+ byte secret, generated once, never committed>
TURN_CREDENTIAL_TTL=3600
ROOM_RECOVERY_SECRET=<random 32+ byte secret, generated once, never committed>
ROOM_RECOVERY_MAX_AGE_MS=21600000
```

| Variable                   | Meaning                                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                     | HTTP/WebSocket listen port. Default `8000`.                                                                                                                                                                                                                                                      |
| `ICE_STUN_SERVERS`         | Comma-separated `stun:` URLs served to clients for NAT discovery. Optional — if unset, the server falls back to Google's public STUN servers so ICE works out of the box. STUN only reveals your public IP/port to you; it never carries traffic.                                                |
| `ICE_TURN_SERVERS`         | Comma-separated `turn:`/`turns:` URLs of your relay. **If this is unset/empty, or `TURN_STATIC_SECRET` is not also set, TURN is omitted entirely and the app runs STUN-only.**                                                                                                                   |
| `TURN_STATIC_SECRET`       | Shared secret for coturn's `use-auth-secret` REST scheme. Must be byte-identical to `static-auth-secret` in `turnserver.conf`. Generate with `openssl rand -base64 48`. The secret never leaves the server: clients receive short-lived HMAC credentials derived from it via `/api/ice-servers`. |
| `TURN_CREDENTIAL_TTL`      | Lifetime (seconds) of those derived TURN credentials. Default `3600`.                                                                                                                                                                                                                            |
| `ROOM_RECOVERY_SECRET`     | Enables stateless room recovery (see "Single instance, no persistence" below). Unset by default — the app behaves exactly as documented with no code-visible difference. Generate with `openssl rand -base64 48`; never leaves the server.                                                       |
| `ROOM_RECOVERY_MAX_AGE_MS` | How long, in ms, a _paired_ room stays recoverable after an instance loses it. Default `21600000` (6 hours). Doesn't apply before pairing — an un-paired invite is always bounded by its own invite window instead.                                                                              |

## STUN-only vs TURN

- **STUN-only** (no `ICE_TURN_SERVERS`): zero extra infrastructure. Works
  whenever the two browsers can reach each other directly after NAT discovery —
  most home/mobile networks. Fails on symmetric NATs and strict corporate/campus
  firewalls; users on those networks simply cannot connect.
- **With TURN**: near-universal connectivity. When a direct path fails, traffic
  is relayed through your coturn server — still end-to-end encrypted twice over
  (DTLS + app-layer AES-GCM), so the relay sees packet timing and volume, never
  content. Costs you the relayed bandwidth.

Rule of thumb: personal/known-network use is fine STUN-only; anything
public-facing wants TURN.

## Single instance, no persistence

Rooms live only in process memory. Consequences you must accept:

- **Run exactly one instance** (or use sticky sessions that pin both peers of a
  room to the same instance — in practice: run one instance).
- **A restart drops all live rooms.** Peers see a disconnect and can mint a new
  link. This is deliberate and honest for an ephemeral product; do not add a
  persistence layer.
- Nothing to back up, no database to run.

**If you can't guarantee a single always-on instance** (serverless/edge hosting
that cold-starts or recycles isolates — e.g. Deno Deploy), set
`ROOM_RECOVERY_SECRET`. The server then issues a small signed capability
alongside each room; if a fresh instance ever loses a room's in-memory state, a
client presenting a still-valid capability can have it legitimately
reconstructed rather than getting a false "this link isn't active" error. This
still adds no database and no shared state between instances — see
`docs/superpowers/specs/2026-07-07-stateless-room-recovery-design.md` for the
full design. If you _can_ guarantee single-instance hosting, there's no reason
to set this — leave it unset.

## Reverse proxy

Terminate TLS at a reverse proxy and forward to the app. Two requirements:

1. **WebSocket upgrade passthrough** for `/ws`.
2. **HSTS at the proxy** — the app does not set it itself.

nginx example:

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name chat.example.com;

  ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # Signaling sockets heartbeat every 25 s; keep read timeout above that.
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
  }
}
```

Caddy example (Caddy proxies WebSockets and sets HSTS-capable TLS
automatically):

```caddyfile
chat.example.com {
  header Strict-Transport-Security "max-age=31536000; includeSubDomains"
  reverse_proxy 127.0.0.1:8000
}
```

The app itself sets `Content-Security-Policy`, `Referrer-Policy:
no-referrer`,
and `X-Content-Type-Options: nosniff` on every response — don't strip or
duplicate them at the proxy.

## Abuse controls

Rate limits are on by default (per-IP create/join/connection limits, per-socket
message rate, 16 KB signaling envelope cap, global concurrent room cap) and
require no configuration. The server never logs raw room tokens (only truncated
hashes) and writes no per-message logs.

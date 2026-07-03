# TURN with coturn

The app hands out **ephemeral TURN credentials** using coturn's
`use-auth-secret` REST scheme: the server HMAC-signs an expiry timestamp with a
shared secret; coturn independently recomputes the same HMAC to validate. The
secret itself never goes to any client.

## Pairing with the app

Two values must line up:

| coturn (`turnserver.conf`)              | app (`.env`)                                   |
| --------------------------------------- | ---------------------------------------------- |
| `static-auth-secret=<SECRET>`           | `TURN_STATIC_SECRET=<SECRET>` (byte-identical) |
| credential lifetime (chosen by the app) | `TURN_CREDENTIAL_TTL` (seconds, default 3600)  |

And `ICE_TURN_SERVERS` in `.env` must point at this coturn instance, e.g.:

```bash
ICE_TURN_SERVERS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
TURN_STATIC_SECRET=<output of: openssl rand -base64 48>
TURN_CREDENTIAL_TTL=3600
```

## `turnserver.conf`

A complete working config for the scheme above:

```ini
# --- authentication: REST / ephemeral credentials ---
use-auth-secret
static-auth-secret=<SECRET — same value as TURN_STATIC_SECRET>
realm=turn.example.com

# --- listeners ---
listening-port=3478
tls-listening-port=5349

# TLS for turns: — use a real certificate (e.g. Let's Encrypt).
# coturn needs read access to these files; renewals must reload coturn.
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem

# STUN message integrity fingerprints (required by WebRTC)
fingerprint

# --- relay port range (open in your firewall, UDP) ---
min-port=49152
max-port=65535

# --- hygiene: never relay into private/loopback/link-local space ---
# (no-loopback-peers is the default and the flag was removed in coturn
#  4.6+; keep the denied-peer-ip lines regardless.)
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255

# --- quotas / hardening ---
no-cli
stale-nonce=600
total-quota=1200
user-quota=12
```

Firewall summary: TCP+UDP 3478, TCP+UDP 5349, and UDP 49152–65535 inbound.

## How the credentials work

For each `/api/ice-servers` request the app computes (spec §4):

- `username = <unix time now + TURN_CREDENTIAL_TTL>`
- `credential = base64(HMAC-SHA1(static secret, username))`

coturn accepts any username that is a not-yet-expired timestamp whose HMAC
matches. Rotating the secret invalidates all outstanding credentials at once:
change it in both `turnserver.conf` and `.env`, restart both.

## Verify it works

1. **Derive a credential by hand and exercise the relay** (from any machine with
   the coturn utils installed — `apt install coturn` ships `turnutils_uclient`):

   ```bash
   SECRET='<same value as static-auth-secret>'
   EXPIRY=$(( $(date +%s) + 3600 ))
   CRED=$(printf '%s' "$EXPIRY" | openssl dgst -binary -sha1 -hmac "$SECRET" | base64)
   turnutils_uclient -y -u "$EXPIRY" -w "$CRED" -p 3478 turn.example.com
   ```

   Success looks like allocation lines and a `total send dropped 0`-style
   summary; an authentication failure prints `401` errors — recheck that the
   secrets match byte-for-byte (no trailing newline in the conf value).

2. **Check what the app serves** (with `ICE_TURN_SERVERS` and
   `TURN_STATIC_SECRET` set):

   ```bash
   curl -s http://localhost:8000/api/ice-servers
   ```

   Expected: JSON whose `iceServers` array contains your `turn:`/`turns:` URLs
   with a numeric-timestamp `username` and a base64 `credential`.

3. **End-to-end**: open a room from a network that blocks UDP peer-to-peer (or
   force relay in the browser: `about:webrtc` in Firefox /
   `chrome://webrtc-internals` in Chrome will show a `relay` candidate pair when
   TURN carried the connection).

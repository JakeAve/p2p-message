# Ephemeral P2P chat

A single-use, account-free, ephemeral chat for sending something sensitive — an
SSN, a card number, a password, a surprise-party plan — without it living
forever in an SMS thread, email, or chat log. One person creates a link and
sends it to one other person; the two exchange end-to-end encrypted text
directly over WebRTC. Nothing is stored on any server, and when the room closes
the conversation is gone.

## Security model, in plain language

**What the server can see.** The signaling server only brokers the WebRTC
connection setup. It sees the room token in the URL path, connection timing,
both peers' IP addresses, and connection metadata (SDP/ICE). If a TURN relay
carries the traffic, the relay additionally sees encrypted packet timing and
volume. That's it.

**What the server cannot see.** Message content, ever — messages travel
peer-to-peer, encrypted twice (WebRTC's mandatory DTLS, plus an app-layer
AES-GCM key that only the two browsers can derive). The encryption key material
lives in the URL _fragment_ (the part after `#`), which browsers never send in
HTTP requests — so the server never sees the key either, even though it serves
the page.

**The honest caveat: the link is the secret.** Whoever obtains the full link
first can join the room as if they were the intended recipient. No link-based,
account-free scheme can fully prevent this — so send the link over a channel you
trust, and keep the invite window short. The app fails closed: a full room
rejects any further join attempt rather than letting a third person in or
replacing a peer.

**What the safety code is for.** Once connected, both people see the same
6-digit code, derived from the encryption handshake. "Both of you should see the
same code. Confirm it over a phone call or another channel if you're sending
something sensitive." If someone else used the link first, their code would
differ from what your intended recipient would have seen — comparing codes
out-of-band is how you detect that.

**Ephemerality.** Messages exist only in the memory of the two open tabs. There
is no history, no database, no queue — not even in server RAM. Closing the tab,
ending the chat, or losing the connection past the grace period ends the
conversation permanently. A server restart drops all live rooms, because there
is nothing anywhere to restore them from.

**Out of scope.** Hiding the two parties' IP addresses from each other or from
the server, and protecting against a compromised device — no transport or crypto
design helps if an endpoint itself is compromised.

## Quickstart

Requires [Deno](https://deno.com) 2+.

```bash
deno install     # fetch dependencies
deno task dev    # dev server at http://localhost:8000
```

## Build and self-host

```bash
deno task build  # bundle the client into dist/app.js
deno run --allow-net --allow-read --allow-env main.ts
```

See [docs/self-hosting.md](docs/self-hosting.md) for the `.env` reference
(STUN/TURN, ports), reverse-proxy notes, and the single-instance requirement —
and [docs/coturn.md](docs/coturn.md) for running your own TURN relay with
coturn.

## Contributing

```bash
deno task setup  # once: install git hooks, download Playwright's Chromium
deno task check  # fmt --check, lint, type check
deno task test   # unit + integration tests — pre-commit gate
deno task e2e    # browser smoke test — pre-push gate; requires the
                 # Chromium build from `deno task setup`/`e2e:install`
```

## Roadmap (not in v1)

Encrypted local persistence with a key file, small file/image attachments,
creator notifications, join-by-generated-phrase, X25519, word/emoji safety
codes, >2 participants.

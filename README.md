# P2P Messaging

Proof of concept for messaging via WebRTC. No messages sent through the server.
Both users must be active to send.

## Requirements

- Deno 2+

## Run

```bash
deno install
deno task dev
```

## Git hooks

This repo uses Deno-native checks (fmt, lint, type check, test) as git hooks.
Run once after cloning:

```bash
deno task setup
```

This points `core.hooksPath` at `.githooks`, which runs `deno task
pre-commit`
and `deno task pre-push` on the respective git actions.

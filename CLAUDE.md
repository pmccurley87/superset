@AGENTS.md

---

## Branch: feat/mobile-remote-terminal

This branch adds remote terminal access to the Superset mobile app (Android/iOS), allowing Patrick to control his main Superset desktop workspace from his phone over Tailscale.

### What we're building

The Android app connects **directly** to the `host-service` daemon running on the desktop via the Tailscale private network — no cloud relay involved. The user browses running terminal sessions and attaches to them via a WebView-hosted xterm.js terminal, using the same JSON message protocol (`input`/`data`/`resize`/`replay`/`exit`) the desktop already uses.

### Architecture

```
Android app (Expo)
  └─ ws://100.x.x.x:<port>/terminal/:id?token=<PSK>
       └─ host-service (desktop, bound to 0.0.0.0)
            └─ Superset terminal sessions
```

- **Tailscale** provides the private network between phone and desktop
- **PSK (pre-shared key)** = `HOST_SERVICE_SECRET` from the desktop's host-service env — used as the auth token on the WebSocket URL
- **host-service** now binds to `0.0.0.0` (changed from `127.0.0.1`) so Tailscale peers can reach it

### Mobile env vars (apps/mobile/.env.local)

```
EXPO_PUBLIC_API_URL=https://app.superset.sh
EXPO_PUBLIC_HOST_IP=<desktop Tailscale IP>
EXPO_PUBLIC_HOST_PORT=<HOST_SERVICE_PORT>
EXPO_PUBLIC_HOST_SECRET=<HOST_SERVICE_SECRET>
```

### Key files

- `apps/mobile/lib/terminal/host.ts` — builds WebSocket + tRPC URLs from env
- `apps/mobile/lib/terminal/transport.ts` — WebSocket transport layer
- `apps/mobile/lib/terminal/xterm.html` — self-contained xterm.js WebView HTML
- `apps/mobile/screens/(authenticated)/(terminals)/` — all terminal UI
- `apps/desktop/src/main/host-service/index.ts` — binds to `0.0.0.0` for Tailscale reachability

### Plan

Full implementation plan: `docs/superpowers/plans/2026-04-25-mobile-remote-terminal.md`

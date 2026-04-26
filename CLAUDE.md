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

---

## V1 Terminal Bridge — Architecture & Learnings

### Two separate terminal systems on the desktop

Superset desktop has **two terminal systems** that must not be confused:

| System | Process | How it works |
|--------|---------|--------------|
| **V1** (real user terminals) | `terminal-host.js` (PID ~2171096) | Unix socket daemon managing PTY subprocesses (`pty-subprocess.js`). These are the terminals Patrick actually works in. |
| **V2** (HTTP terminals) | `host-service.js` | WebSocket-based PTY sessions created on demand. Usually empty in practice. |

When showing remote terminal state, **V1 sessions are what matter**. V2 sessions are almost always empty.

### V1 bridge: key files

- `packages/host-service/src/terminal/terminal-host-bridge.ts` — full bridge: `listV1Sessions()` + `attachV1Session()`
- `packages/host-service/src/terminal/terminal.ts` — WebSocket handlers route `v1:`-prefixed terminalIds through the bridge
- `packages/host-service/src/trpc/router/terminal/terminal.ts` — `listAll` merges V2 + V1, V1 sessions prefixed `v1:`
- `tools/remote-control.html` — self-contained browser UI for remote control

### terminal-host NDJSON protocol

Socket path: `~/.superset/terminal-host.sock`  
Token: `~/.superset/terminal-host.token`  
Protocol version: 2

Two socket **roles** — both must share the **same `clientId`** or `createOrAttach` fails with `STREAM_NOT_CONNECTED`:
- `"stream"` — receives event stream (data/exit events for attached sessions)
- `"control"` — request/response (createOrAttach, write, resize, detach)

**Connect stream socket first**, then control, then call `createOrAttach`. If control connects before stream is linked via shared clientId, you get `STREAM_NOT_CONNECTED`.

Wire format:
```
Request:  {"id":"req_1","type":"...","payload":{...}}\n
Response: {"id":"req_1","ok":true,"payload":{...}}\n
Event:    {"type":"event","sessionId":"...","payload":{"type":"data","data":"..."}}\n
```

`createdAt` in listSessions response is an **ISO date string**, not epoch ms — parse with `new Date(s.createdAt).getTime()`.

### Critical bugs fixed in the bridge

1. **`sock.setTimeout(0)` after auth** — `connectAndAuth` sets a 3-second TCP idle timeout for the initial connection. Without clearing it after auth, the control socket (which sits quiet between keystrokes) fires the timeout after 3s, destroys itself, and tears down the bridge. Fix: call `sock.setTimeout(0)` immediately after the hello response resolves.

2. **Closure variable for write handle, not ws property** — Hono's `upgradeWebSocket` wraps the underlying socket in a new `WSContext` object for each callback invocation (`onOpen`, `onMessage`, `onClose`). Setting `_v1Write` as a property on the `ws` object in `onOpen` makes it invisible in `onMessage`. Fix: store a `V1BridgeHandle` in a closure variable shared across all handlers.

3. **`attachV1Session` returns a handle synchronously** — the handle's `write`/`resize`/`detach` functions use `controlSock` internally, which is set asynchronously. Calls made before the control socket connects are silently dropped (controlSock is null). This is acceptable — by the time a user types, the socket is long connected.

### Deployment on Linux (patrick-linux, 100.68.9.36)

The coordinator-spawned host-service (managed by the Superset Electron app) cannot be relied on to respawn automatically — killing it leaves it dead until the app is restarted. Instead, spawn manually:

```bash
SKIP_ENV_VALIDATION=1 DISPLAY=:0 ELECTRON_RUN_AS_NODE=1 \
SUPERSET_HOME_DIR=/home/patrick/.superset \
HOST_SERVICE_SECRET=bf332c7800add0dfc68faa4bab3e1566c8a317770c68eba16e5cb97f1badabda \
HOST_SERVICE_PORT=44037 \
HOST_MANIFEST_DIR=/home/patrick/.superset/host/01ddd600-d694-45f2-a394-416c806b07ea \
HOST_DB_PATH=/home/patrick/.superset/host/01ddd600-d694-45f2-a394-416c806b07ea/host.db \
HOST_MIGRATIONS_FOLDER=/home/patrick/superset-app/packages/host-service/drizzle \
DESKTOP_VITE_PORT=5173 \
AUTH_TOKEN=S0_AXrKGKcp4k9DQAmbjukjztG0MyTVZHQ-uLo131Kc \
CLOUD_API_URL=https://api.superset.sh \
ORGANIZATION_ID=01ddd600-d694-45f2-a394-416c806b07ea \
DEVICE_CLIENT_ID=85e41c5f28b7da2c983071d4f81d8c07 \
DEVICE_NAME=PATRICK-LINUX \
nohup /home/patrick/superset-app/node_modules/.bun/electron@40.8.5/node_modules/electron/dist/electron \
  /home/patrick/superset-app/apps/desktop/dist/main/host-service.js \
  > /tmp/host-service-44037.log 2>&1 &
```

To kill all host-service instances before respawning: `pkill -f 'host-service.js'`

Electron requires `DISPLAY=:0` and `ELECTRON_RUN_AS_NODE=1` or it segfaults headlessly.

### Deployment workflow

1. Make changes on Mac, commit + push to `patrick` remote (github.com/pmccurley87/superset)
2. On Linux: `git fetch patrick && git checkout -B feat/mobile-remote-terminal patrick/feat/mobile-remote-terminal`
3. Rebuild: `cd ~/superset-app/apps/desktop && ~/.bun/bin/bun run compile:app` (~90s)
4. `pkill -f 'host-service.js' && sleep 2 && [spawn command above]`
5. Verify: `ss -tlnp | grep 44037`

### remote-control.html

Self-contained browser file at `tools/remote-control.html`. Open directly in browser (file:// or served). Default credentials: `100.68.9.36:44037` with the secret above.

Auth header for tRPC calls: `Authorization: Bearer <secret>`  
WebSocket URL: `ws://<host>:<port>/terminal/<terminalId>?token=<secret>`

### superset-launch.sh

Patrick's Linux desktop has a `.desktop` autostart entry pointing to `/home/patrick/superset-app/superset-launch.sh`. This file is NOT in the upstream repo — it was added in a local Linux customization commit. If the file goes missing (e.g. after a branch reset), restore it:

```bash
cd ~/superset-app && git show 9d9f50817:superset-launch.sh > superset-launch.sh && chmod +x superset-launch.sh
```

The script sets PATH (bun/fnm), exports `SKIP_ENV_VALIDATION=1`, and runs `npx electron .` from `apps/desktop/`.

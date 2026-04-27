# Remote Control — Architecture & Implementation Notes

Mobile browser access to Linux desktop terminals over Tailscale, without any cloud relay.

---

## System Overview

```
Android browser (100.68.9.36:5198)
  └─ HTTP  → Vite-built React SPA   (served by server.ts)
  └─ tRPC  → /trpc/*               (proxied to host-service)
  └─ WS    → /terminal/:id         (proxied to host-service)
       └─ host-service (Linux, port 44037)
            └─ terminal-host.sock  (V1 PTY sessions)
```

Tailscale provides the private network. No ports are exposed to the internet.

---

## server.ts — The Bun Proxy

`server.ts` is a single-file Bun server that does three things:

1. **Serves the built React app** from `./dist` with SPA fallback to `index.html`
2. **Proxies tRPC** — `/trpc/*` requests get the auth token injected and are forwarded to host-service
3. **Proxies WebSocket terminal connections** — `/terminal/:id` is bridged to `ws://host-service/terminal/:id`

### Manifest reading

Auth credentials (host-service endpoint + secret) are read from `~/.superset/host/<orgId>/manifest.json` **on every request**, so the proxy survives host-service restarts with new ports/secrets without itself needing a restart.

### WebSocket proxy lifecycle

```
browser WS connect
  → Bun upgrade
  → open(ws): connect upstream WS to host-service
              start 15s ping timer:
                ws.ping()                   ← protocol PING to browser (keeps NAT alive)
                upstream.send({type:ping})  ← app-level ping to host-service
  → message(ws, msg): relay to upstream
  → upstream.onmessage: relay to browser
  → upstream.onclose: forward close code (1000 → 1001 so browser reconnect logic fires)
  → close(ws): close upstream, clear ping timer
```

### Key settings

- `idleTimeout: 120` — explicit 120s idle timeout (0 is ambiguous in Bun, may mean "use default")
- `hostname: "0.0.0.0"` — binds to all interfaces so Tailscale peers can reach it
- CORS headers on all responses — required since the React app may be served from a different origin during development

---

## React App — TerminalPane

xterm.js renders terminal output to a `<canvas>`. This breaks native browser scroll because canvas elements don't scroll — touch events hit the canvas and stop there.

### The scroll proxy approach

Instead of simulating scroll physics in JS (discrete line jumps, fake momentum), we create a transparent `overflow-y: scroll` div that sits on top of the canvas. The browser treats it as a normal scrollable container and applies its full native momentum/rubber-band physics.

```
[terminal container]  position:relative
  ├─ [xterm DOM]      z-index:1  (canvas layers)
  └─ [scroll proxy]   z-index:10, position:absolute, inset:0, overflow-y:scroll
       └─ [inner div] height = xtermViewport.scrollHeight
```

**Sync logic:**
- `proxy.scroll` → set `xtermViewport.scrollTop = proxy.scrollTop` (one-way, drives xterm render)
- `ResizeObserver` on `.xterm-scroll-area` → fired when new terminal output arrives and content height grows → update inner div height, then sync `proxy.scrollTop = xtermViewport.scrollTop` (follows xterm's auto-scroll to bottom)
- A 50ms cooldown after the ResizeObserver sync prevents the resulting proxy scroll event from bouncing back

**Why ResizeObserver instead of xtermViewport's scroll event:**
The `scroll` event on xterm's viewport fires before the DOM has finished updating `scrollHeight`. Reading `scrollHeight` at that moment gives a stale (smaller) value, which makes the proxy inner div too short, clamping `scrollTop` to 0 — teleporting the user to the top. ResizeObserver fires after layout is complete.

**Tap forwarding:**
The proxy intercepts all touch events. Taps (< 8px movement) are detected on `touchend` and forwarded by calling `term.focus()` + `term.textarea?.focus()` so the mobile keyboard appears.

**Scrollbar hiding:**
Both the proxy and xterm's viewport scrollbar are hidden via `scrollbar-width: none` + `::-webkit-scrollbar { display: none }`. The proxy scrollbar would show on top; xterm's would show underneath.

**Pull-to-refresh:**
`overscroll-behavior: none` on `body` prevents Android Chrome's pull-to-refresh from firing while the terminal is open.

---

## Mobile Keyboard Handling

When the virtual keyboard appears on Android/iOS, `window.visualViewport.height` shrinks while `window.innerHeight` stays the same. The difference is the keyboard height.

In `App.tsx`, `useVisualViewport()` tracks this and sets the root container's height to `vpHeight` instead of `100dvh`. Combined with `position: fixed` on mobile, the app shrinks with the keyboard rather than being overlapped by it.

When `keyboardVisible` (keyboard height > 100px) and the user is in terminal view, a `MobileControlBar` renders above the keyboard with arrow keys (↑↓←→), Esc, and `/`. Buttons use `onPointerDown` + `e.preventDefault()` so tapping them doesn't dismiss the keyboard.

---

## Auto-reconnect

`TerminalPane` maintains a stable `Instance` object per terminal ID in a module-level `Map`. When the WebSocket closes (for any reason other than explicit destroy), it schedules a reconnect after 2 seconds. The `inst.ws` field is updated on each reconnect so the input handler always sends to the current socket.

`destroyTerminal()` sets `inst.destroyed = true` and closes with code 4000 — the `onclose` handler checks this flag and skips reconnect.

---

## Deployment

### Android testing (primary workflow)

Patrick tests on Android by opening `http://100.68.9.36:5198` — the Linux box running `server.ts`.

`server.ts` uses `readFileSync` on every request (no in-memory cache), so updating `dist/` is sufficient — no server restart needed.

```bash
# From apps/remote-control on Mac:
bun run build
rsync -av dist/ patrick@100.68.9.36:~/superset-app/apps/remote-control/dist/
```

### Dev server (Mac, no deploy needed)

For rapid iteration without touching Linux, run Vite bound to all interfaces. Open `http://<mac-tailscale-ip>:5199` on Android. Credentials must be entered manually (proxy mode `/rc/config` is only available via `server.ts`).

```bash
bun run vite --host 0.0.0.0 --port 5199
```

### server.ts on Linux

`server.ts` is started manually (it's not managed by the Superset Electron app). It reads the host-service manifest automatically, so it doesn't need restarting when host-service restarts.

```bash
cd ~/superset-app/apps/remote-control
nohup bun run server.ts > /tmp/rc-proxy.log 2>&1 &
```

---

## E2E Test Scripts

Two Bun scripts in `apps/remote-control/` for connection testing (not Playwright):

- **`test-ws.ts`** — fetches sessions via tRPC, connects to a terminal, logs all events for 30s. Supports `--no-heartbeat` flag to test idle connection survival.
- **`test-reconnect.ts`** — simulates the browser reconnect loop: connect → hold 3s → force close → reconnect immediately. Verifies no state corruption across reconnects.

```bash
bun run test-ws.ts
bun run test-ws.ts v1:pane-xxx --no-heartbeat
bun run test-reconnect.ts
```

These run from Mac against the Linux proxy over Tailscale.

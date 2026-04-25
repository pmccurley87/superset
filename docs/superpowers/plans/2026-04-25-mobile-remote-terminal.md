# Mobile Remote Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add remote terminal access to the Superset mobile app so users can browse, attach to, and control terminal sessions running on their desktop from their Android phone.

**Architecture:** The mobile app connects to the existing relay server (`apps/relay`) via WebSocket, which tunnels traffic to the host-service daemon on the user's desktop. Terminal I/O uses the same JSON message protocol (`input`/`data`/`resize`/`replay`/`exit`) already used by the desktop app. The terminal is rendered using xterm.js inside a WebView, since React Native has no native terminal emulator and xterm.js matches the desktop's rendering exactly.

**Tech Stack:** React Native (Expo SDK 55), xterm.js in WebView, WebSocket (relay tunnel protocol), tRPC (host/session listing), better-auth (JWT for relay auth)

---

## File Structure

### New Files

```
apps/mobile/lib/terminal/
├── transport.ts              # WebSocket transport (port of desktop's terminal-ws-transport.ts)
├── relay.ts                  # Relay URL builder + JWT minting for relay auth
├── types.ts                  # Terminal message types (shared protocol)
└── xterm.html                # Self-contained xterm.js HTML loaded into WebView

apps/mobile/screens/(authenticated)/(terminals)/
├── TerminalsScreen.tsx        # Host list → session list → attach
├── components/
│   ├── HostList/
│   │   ├── HostList.tsx       # List of online hosts for current org
│   │   └── index.ts
│   ├── SessionList/
│   │   ├── SessionList.tsx    # List of terminal sessions on a host
│   │   └── index.ts
│   ├── TerminalWebView/
│   │   ├── TerminalWebView.tsx # WebView wrapper rendering xterm.js
│   │   └── index.ts
│   └── ConnectionStatusBar/
│       ├── ConnectionStatusBar.tsx  # Shows connecting/connected/disconnected
│       └── index.ts
├── hooks/
│   ├── useHosts/
│   │   ├── useHosts.ts        # Fetch hosts via tRPC
│   │   └── index.ts
│   └── useTerminalSessions/
│       ├── useTerminalSessions.ts  # Fetch sessions via relay proxy
│       └── index.ts
└── index.ts

apps/mobile/app/(authenticated)/(terminals)/
├── _layout.tsx                # Stack layout for terminals tab
└── index.tsx                  # Re-exports TerminalsScreen

apps/mobile/screens/(authenticated)/(terminals)/terminal/
├── TerminalScreen.tsx         # Full-screen terminal view (attach to session)
├── index.ts
└── [sessionId].tsx            # Dynamic route for specific session
```

### Modified Files

```
apps/mobile/app/(authenticated)/_layout.tsx                    # Add (terminals) tab trigger
apps/mobile/screens/(authenticated)/components/AuthenticatedTabBar/AuthenticatedTabBar.tsx  # Add Terminals tab
apps/mobile/lib/env.ts                                         # Add EXPO_PUBLIC_RELAY_URL
packages/trpc/src/router/device/device.ts                      # Add listHosts query
packages/trpc/src/router/index.ts                              # Wire listHosts if needed
```

---

## Task 1: Terminal Message Types

**Files:**
- Create: `apps/mobile/lib/terminal/types.ts`

- [ ] **Step 1: Create the types file**

This mirrors the protocol used by `packages/host-service/src/terminal/terminal.ts` and `apps/desktop/src/renderer/lib/terminal/terminal-ws-transport.ts`.

```typescript
// apps/mobile/lib/terminal/types.ts

export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "dispose" };

export type TerminalServerMessage =
  | { type: "data"; data: string }
  | { type: "error"; message: string }
  | { type: "exit"; exitCode: number; signal: number }
  | { type: "replay"; data: string };

export type ConnectionState = "disconnected" | "connecting" | "open" | "closed";
```

- [ ] **Step 2: Commit**

```bash
git add apps/mobile/lib/terminal/types.ts
git commit -m "feat(mobile): add terminal message types matching host-service protocol"
```

---

## Task 2: WebSocket Transport

**Files:**
- Create: `apps/mobile/lib/terminal/transport.ts`
- Reference: `apps/desktop/src/renderer/lib/terminal/terminal-ws-transport.ts`

This is a direct port of the desktop's transport, adapted to work without an xterm.js `Terminal` instance. Instead of writing directly to xterm, it calls a callback. The WebView bridge handles the xterm side.

- [ ] **Step 1: Create the transport module**

```typescript
// apps/mobile/lib/terminal/transport.ts

import type { ConnectionState, TerminalClientMessage, TerminalServerMessage } from "./types";

export interface TerminalTransportCallbacks {
  onData: (data: string) => void;
  onReplay: (data: string) => void;
  onError: (message: string) => void;
  onExit: (exitCode: number, signal: number) => void;
  onStateChange: (state: ConnectionState) => void;
}

export interface TerminalTransport {
  socket: WebSocket | null;
  connectionState: ConnectionState;
  currentUrl: string | null;
  callbacks: TerminalTransportCallbacks | null;
  _reconnectTimer: ReturnType<typeof setTimeout> | null;
  _reconnectAttempt: number;
  _exited: boolean;
}

const MAX_RECONNECT_DELAY = 10_000;
const BASE_RECONNECT_DELAY = 500;
const MAX_RECONNECT_ATTEMPTS = 10;

function setConnectionState(transport: TerminalTransport, state: ConnectionState) {
  transport.connectionState = state;
  transport.callbacks?.onStateChange(state);
}

function scheduleReconnect(transport: TerminalTransport) {
  if (transport._reconnectTimer) return;
  if (transport._exited) return;
  if (!transport.currentUrl || !transport.callbacks) return;
  if (transport._reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) return;

  const delay = Math.min(
    BASE_RECONNECT_DELAY * 2 ** transport._reconnectAttempt,
    MAX_RECONNECT_DELAY,
  );
  transport._reconnectAttempt++;

  transport._reconnectTimer = setTimeout(() => {
    transport._reconnectTimer = null;
    if (transport.connectionState === "closed" && transport.currentUrl && transport.callbacks) {
      connect(transport, transport.callbacks, transport.currentUrl);
    }
  }, delay);
}

function cancelReconnect(transport: TerminalTransport) {
  if (transport._reconnectTimer) {
    clearTimeout(transport._reconnectTimer);
    transport._reconnectTimer = null;
  }
}

export function createTransport(): TerminalTransport {
  return {
    socket: null,
    connectionState: "disconnected",
    currentUrl: null,
    callbacks: null,
    _reconnectTimer: null,
    _reconnectAttempt: 0,
    _exited: false,
  };
}

export function connect(
  transport: TerminalTransport,
  callbacks: TerminalTransportCallbacks,
  wsUrl: string,
) {
  const isActive = transport.connectionState === "open" || transport.connectionState === "connecting";
  if (isActive && transport.currentUrl === wsUrl) return;

  if (transport.socket) {
    transport.socket.close();
    transport.socket = null;
  }

  cancelReconnect(transport);
  transport.currentUrl = wsUrl;
  transport.callbacks = callbacks;
  transport._exited = false;
  setConnectionState(transport, "connecting");

  const socket = new WebSocket(wsUrl);
  transport.socket = socket;

  socket.addEventListener("open", () => {
    if (transport.socket !== socket) return;
    transport._reconnectAttempt = 0;
    setConnectionState(transport, "open");
  });

  socket.addEventListener("message", (event) => {
    if (transport.socket !== socket) return;
    let message: TerminalServerMessage;
    try {
      message = JSON.parse(String(event.data)) as TerminalServerMessage;
    } catch {
      callbacks.onError("Invalid server payload");
      return;
    }

    if (message.type === "data") {
      callbacks.onData(message.data);
      return;
    }
    if (message.type === "replay") {
      callbacks.onReplay(message.data);
      return;
    }
    if (message.type === "error") {
      callbacks.onError(message.message);
      return;
    }
    if (message.type === "exit") {
      transport._exited = true;
      cancelReconnect(transport);
      callbacks.onExit(message.exitCode, message.signal);
    }
  });

  socket.addEventListener("close", () => {
    if (transport.socket !== socket) return;
    setConnectionState(transport, "closed");
    transport.socket = null;
    scheduleReconnect(transport);
  });

  socket.addEventListener("error", () => {
    if (transport.socket !== socket) return;
    callbacks.onError("WebSocket error");
  });
}

export function disconnect(transport: TerminalTransport) {
  cancelReconnect(transport);
  if (transport.socket) {
    transport.socket.close();
    transport.socket = null;
  }
  transport.currentUrl = null;
  transport.callbacks = null;
  transport._reconnectAttempt = 0;
  setConnectionState(transport, "disconnected");
}

export function sendInput(transport: TerminalTransport, data: string) {
  if (!transport.socket || transport.socket.readyState !== WebSocket.OPEN) return;
  const msg: TerminalClientMessage = { type: "input", data };
  transport.socket.send(JSON.stringify(msg));
}

export function sendResize(transport: TerminalTransport, cols: number, rows: number) {
  if (!transport.socket || transport.socket.readyState !== WebSocket.OPEN) return;
  const msg: TerminalClientMessage = { type: "resize", cols, rows };
  transport.socket.send(JSON.stringify(msg));
}

export function sendDispose(transport: TerminalTransport) {
  if (transport.socket?.readyState === WebSocket.OPEN) {
    const msg: TerminalClientMessage = { type: "dispose" };
    transport.socket.send(JSON.stringify(msg));
  }
}

export function disposeTransport(transport: TerminalTransport) {
  cancelReconnect(transport);
  if (transport.socket) {
    transport.socket.close();
    transport.socket = null;
  }
  transport.currentUrl = null;
  transport.callbacks = null;
  transport._reconnectAttempt = 0;
  transport._exited = false;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/mobile/lib/terminal/transport.ts
git commit -m "feat(mobile): add WebSocket terminal transport with auto-reconnect"
```

---

## Task 3: Relay URL Builder

**Files:**
- Create: `apps/mobile/lib/terminal/relay.ts`
- Modify: `apps/mobile/lib/env.ts`

The relay server at `apps/relay` accepts WebSocket connections at `/hosts/:hostId/terminal/:terminalId`. Auth is via `?token=<jwt>` query param or `Authorization: Bearer <jwt>` header. The mobile app needs to build these URLs.

- [ ] **Step 1: Add EXPO_PUBLIC_RELAY_URL to env schema**

In `apps/mobile/lib/env.ts`, add the relay URL to the schema:

```typescript
// Add to envSchema object:
EXPO_PUBLIC_RELAY_URL: z.url(),
```

And add to the parse block:

```typescript
// Add to env parse:
EXPO_PUBLIC_RELAY_URL: process.env.EXPO_PUBLIC_RELAY_URL as unknown,
```

- [ ] **Step 2: Create the relay URL builder**

```typescript
// apps/mobile/lib/terminal/relay.ts

import { env } from "../env";

/**
 * Build the WebSocket URL to attach to a terminal session via the relay.
 *
 * URL format: wss://relay.example.com/hosts/{hostId}/terminal/{terminalId}?token={jwt}
 *
 * The relay authenticates via the token query param (see apps/relay/src/index.ts extractToken()).
 * It then opens a tunnel channel to the host-service's /terminal/:terminalId WebSocket endpoint.
 */
export function buildTerminalWsUrl(hostId: string, terminalId: string, jwt: string): string {
  const base = env.EXPO_PUBLIC_RELAY_URL.replace(/^http/, "ws");
  return `${base}/hosts/${hostId}/terminal/${terminalId}?token=${encodeURIComponent(jwt)}`;
}

/**
 * Build the HTTP URL for tRPC calls to host-service via the relay proxy.
 *
 * URL format: https://relay.example.com/hosts/{hostId}/trpc/{procedure}
 */
export function buildRelayTrpcUrl(hostId: string, procedure: string): string {
  return `${env.EXPO_PUBLIC_RELAY_URL}/hosts/${hostId}/trpc/${procedure}`;
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/lib/env.ts apps/mobile/lib/terminal/relay.ts
git commit -m "feat(mobile): add relay URL builder and env config for remote terminal"
```

---

## Task 4: Add listHosts tRPC Query

**Files:**
- Modify: `packages/trpc/src/router/device/device.ts`

There's no existing route to list hosts the current user can access. We need one for the mobile app to show available machines.

- [ ] **Step 1: Add listHosts query to device router**

Add this to the `deviceRouter` object in `packages/trpc/src/router/device/device.ts`, after the `setHostOnline` mutation:

```typescript
  listHosts: protectedProcedure.query(async ({ ctx }) => {
    const organizationId = ctx.activeOrganizationId;
    if (!organizationId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "No active organization selected",
      });
    }

    const userId = ctx.session.user.id;

    const rows = await db
      .select({
        id: v2Hosts.id,
        name: v2Hosts.name,
        machineId: v2Hosts.machineId,
        isOnline: v2Hosts.isOnline,
        createdAt: v2Hosts.createdAt,
      })
      .from(v2UsersHosts)
      .innerJoin(v2Hosts, eq(v2UsersHosts.hostId, v2Hosts.id))
      .where(
        and(
          eq(v2UsersHosts.userId, userId),
          eq(v2UsersHosts.organizationId, organizationId),
        ),
      );

    return { hosts: rows };
  }),
```

- [ ] **Step 2: Verify the imports are already present**

The file already imports `db`, `v2Hosts`, `v2UsersHosts`, `and`, `eq` — no new imports needed.

- [ ] **Step 3: Commit**

```bash
git add packages/trpc/src/router/device/device.ts
git commit -m "feat(trpc): add listHosts query to device router for mobile terminal access"
```

---

## Task 5: useHosts Hook

**Files:**
- Create: `apps/mobile/screens/(authenticated)/(terminals)/hooks/useHosts/useHosts.ts`
- Create: `apps/mobile/screens/(authenticated)/(terminals)/hooks/useHosts/index.ts`

- [ ] **Step 1: Create the hook**

```typescript
// apps/mobile/screens/(authenticated)/(terminals)/hooks/useHosts/useHosts.ts

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/trpc/client";

export function useHosts() {
  return useQuery({
    queryKey: ["hosts"],
    queryFn: () => apiClient.device.listHosts.query(),
    refetchInterval: 15_000, // Poll for online status changes
  });
}
```

```typescript
// apps/mobile/screens/(authenticated)/(terminals)/hooks/useHosts/index.ts
export { useHosts } from "./useHosts";
```

- [ ] **Step 2: Commit**

```bash
git add apps/mobile/screens/\(authenticated\)/\(terminals\)/hooks/useHosts/
git commit -m "feat(mobile): add useHosts hook for listing accessible machines"
```

---

## Task 6: useTerminalSessions Hook

**Files:**
- Create: `apps/mobile/screens/(authenticated)/(terminals)/hooks/useTerminalSessions/useTerminalSessions.ts`
- Create: `apps/mobile/screens/(authenticated)/(terminals)/hooks/useTerminalSessions/index.ts`

This hook fetches terminal sessions from a specific host via the relay proxy. It calls the host-service's `terminal.listSessions` tRPC procedure through the relay.

- [ ] **Step 1: Create the hook**

```typescript
// apps/mobile/screens/(authenticated)/(terminals)/hooks/useTerminalSessions/useTerminalSessions.ts

import { useQuery } from "@tanstack/react-query";
import SuperJSON from "superjson";
import { authClient } from "@/lib/auth/client";
import { buildRelayTrpcUrl } from "@/lib/terminal/relay";

interface TerminalSessionSummary {
  terminalId: string;
  workspaceId: string;
  createdAt: number;
  exited: boolean;
}

async function fetchSessions(hostId: string, workspaceId?: string): Promise<TerminalSessionSummary[]> {
  const cookies = authClient.getCookie();
  // Get a JWT for relay auth — the API mints one via the auth session
  const tokenRes = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/api/auth/token`, {
    headers: cookies ? { Cookie: cookies } : {},
  });
  if (!tokenRes.ok) throw new Error("Failed to get auth token");
  const { token: jwt } = await tokenRes.json() as { token: string };

  const input = workspaceId ? { workspaceId } : {};
  const url = buildRelayTrpcUrl(hostId, "terminal.listSessions");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(SuperJSON.serialize(input)),
  });

  if (!res.ok) throw new Error(`Relay error: ${res.status}`);

  const body = await res.json() as { result?: { data?: unknown } };
  if (!body.result?.data) throw new Error("Invalid relay response");

  const result = SuperJSON.deserialize(body.result.data as never) as { sessions: TerminalSessionSummary[] };
  return result.sessions;
}

export function useTerminalSessions(hostId: string | null) {
  return useQuery({
    queryKey: ["terminalSessions", hostId],
    queryFn: () => fetchSessions(hostId!),
    enabled: !!hostId,
    refetchInterval: 10_000,
  });
}
```

```typescript
// apps/mobile/screens/(authenticated)/(terminals)/hooks/useTerminalSessions/index.ts
export { useTerminalSessions } from "./useTerminalSessions";
```

- [ ] **Step 2: Commit**

```bash
git add apps/mobile/screens/\(authenticated\)/\(terminals\)/hooks/useTerminalSessions/
git commit -m "feat(mobile): add useTerminalSessions hook for listing sessions via relay"
```

---

## Task 7: xterm.js WebView HTML

**Files:**
- Create: `apps/mobile/lib/terminal/xterm.html`

This is a self-contained HTML file that loads xterm.js from CDN and communicates with React Native via `window.ReactNativeWebView.postMessage` (outbound) and `window.addEventListener("message", ...)` (inbound).

- [ ] **Step 1: Create the xterm HTML file**

```html
<!-- apps/mobile/lib/terminal/xterm.html -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #1a1a2e; }
    #terminal { width: 100%; height: 100%; }
    .xterm { padding: 4px; }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
  <script>
    const term = new Terminal({
      fontSize: 13,
      fontFamily: "monospace",
      cursorBlink: true,
      theme: {
        background: "#1a1a2e",
        foreground: "#e0e0e0",
        cursor: "#e0e0e0",
        selectionBackground: "rgba(255,255,255,0.2)",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon.WebLinksAddon());

    term.open(document.getElementById("terminal"));
    fitAddon.fit();

    // Send user input to React Native
    term.onData(function(data) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: "input", data: data }));
    });

    // Send resize events to React Native
    term.onResize(function(size) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: "resize",
        cols: size.cols,
        rows: size.rows,
      }));
    });

    // Report initial size
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: "resize",
      cols: term.cols,
      rows: term.rows,
    }));

    // Receive messages from React Native
    window.addEventListener("message", function(event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch(e) { return; }

      if (msg.type === "write") {
        term.write(msg.data);
      } else if (msg.type === "clear") {
        term.clear();
      } else if (msg.type === "fit") {
        fitAddon.fit();
      }
    });

    // Also handle document message for Android
    document.addEventListener("message", function(event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch(e) { return; }

      if (msg.type === "write") {
        term.write(msg.data);
      } else if (msg.type === "clear") {
        term.clear();
      } else if (msg.type === "fit") {
        fitAddon.fit();
      }
    });

    // Refit on window resize
    window.addEventListener("resize", function() {
      fitAddon.fit();
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add apps/mobile/lib/terminal/xterm.html
git commit -m "feat(mobile): add xterm.js WebView HTML for terminal rendering"
```

---

## Task 8: TerminalWebView Component

**Files:**
- Create: `apps/mobile/screens/(authenticated)/(terminals)/components/TerminalWebView/TerminalWebView.tsx`
- Create: `apps/mobile/screens/(authenticated)/(terminals)/components/TerminalWebView/index.ts`

This bridges xterm.js in the WebView with the WebSocket transport.

- [ ] **Step 1: Create the component**

```typescript
// apps/mobile/screens/(authenticated)/(terminals)/components/TerminalWebView/TerminalWebView.tsx

import { useCallback, useEffect, useRef } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { TerminalTransportCallbacks } from "@/lib/terminal/transport";
import {
  connect,
  createTransport,
  disconnect,
  disposeTransport,
  sendInput,
  sendResize,
} from "@/lib/terminal/transport";
import type { ConnectionState } from "@/lib/terminal/types";

// Read the HTML asset
const XTERM_HTML = require("@/lib/terminal/xterm.html");

interface TerminalWebViewProps {
  wsUrl: string | null;
  onConnectionStateChange?: (state: ConnectionState) => void;
  onExit?: (exitCode: number, signal: number) => void;
}

export function TerminalWebView({ wsUrl, onConnectionStateChange, onExit }: TerminalWebViewProps) {
  const webViewRef = useRef<WebView>(null);
  const transportRef = useRef(createTransport());

  const postToWebView = useCallback((type: string, data: string) => {
    const msg = JSON.stringify({ type, data });
    webViewRef.current?.postMessage(msg);
  }, []);

  // Connect/disconnect when wsUrl changes
  useEffect(() => {
    const transport = transportRef.current;

    if (!wsUrl) {
      disconnect(transport);
      return;
    }

    const callbacks: TerminalTransportCallbacks = {
      onData: (data) => postToWebView("write", data),
      onReplay: (data) => postToWebView("write", data),
      onError: (message) => postToWebView("write", `\r\n[error] ${message}\r\n`),
      onExit: (exitCode, signal) => {
        postToWebView("write", `\r\n[exited: code=${exitCode} signal=${signal}]\r\n`);
        onExit?.(exitCode, signal);
      },
      onStateChange: (state) => onConnectionStateChange?.(state),
    };

    connect(transport, callbacks, wsUrl);

    return () => {
      disconnect(transport);
    };
  }, [wsUrl, postToWebView, onConnectionStateChange, onExit]);

  // Cleanup on unmount
  useEffect(() => {
    const transport = transportRef.current;
    return () => disposeTransport(transport);
  }, []);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    const transport = transportRef.current;
    let msg: { type: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }

    if (msg.type === "input" && msg.data) {
      sendInput(transport, msg.data);
    } else if (msg.type === "resize" && msg.cols && msg.rows) {
      sendResize(transport, msg.cols, msg.rows);
    }
  }, []);

  return (
    <View className="flex-1 bg-[#1a1a2e]">
      <WebView
        ref={webViewRef}
        source={XTERM_HTML}
        originWhitelist={["*"]}
        javaScriptEnabled
        onMessage={handleMessage}
        style={{ flex: 1, backgroundColor: "#1a1a2e" }}
        scrollEnabled={false}
        bounces={false}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView={false}
        allowsInlineMediaPlayback
      />
    </View>
  );
}
```

```typescript
// apps/mobile/screens/(authenticated)/(terminals)/components/TerminalWebView/index.ts
export { TerminalWebView } from "./TerminalWebView";
```

- [ ] **Step 2: Add react-native-webview dependency**

Run from repo root:

```bash
cd apps/mobile && bun add react-native-webview
```

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/screens/\(authenticated\)/\(terminals\)/components/TerminalWebView/
git commit -m "feat(mobile): add TerminalWebView component bridging xterm.js and transport"
```

---

## Task 9: ConnectionStatusBar Component

**Files:**
- Create: `apps/mobile/screens/(authenticated)/(terminals)/components/ConnectionStatusBar/ConnectionStatusBar.tsx`
- Create: `apps/mobile/screens/(authenticated)/(terminals)/components/ConnectionStatusBar/index.ts`

- [ ] **Step 1: Create the component**

```typescript
// apps/mobile/screens/(authenticated)/(terminals)/components/ConnectionStatusBar/ConnectionStatusBar.tsx

import { View } from "react-native";
import { Text } from "@/components/ui/text";
import type { ConnectionState } from "@/lib/terminal/types";

interface ConnectionStatusBarProps {
  state: ConnectionState;
  hostName?: string;
}

const STATE_CONFIG: Record<ConnectionState, { label: string; color: string }> = {
  disconnected: { label: "Disconnected", color: "bg-muted" },
  connecting: { label: "Connecting...", color: "bg-yellow-600" },
  open: { label: "Connected", color: "bg-green-600" },
  closed: { label: "Reconnecting...", color: "bg-yellow-600" },
};

export function ConnectionStatusBar({ state, hostName }: ConnectionStatusBarProps) {
  const config = STATE_CONFIG[state];
  return (
    <View className={`flex-row items-center px-3 py-1.5 ${config.color}`}>
      <View className="h-2 w-2 rounded-full bg-white mr-2" />
      <Text className="text-xs text-white font-medium">
        {config.label}
        {hostName ? ` — ${hostName}` : ""}
      </Text>
    </View>
  );
}
```

```typescript
// apps/mobile/screens/(authenticated)/(terminals)/components/ConnectionStatusBar/index.ts
export { ConnectionStatusBar } from "./ConnectionStatusBar";
```

- [ ] **Step 2: Commit**

```bash
git add apps/mobile/screens/\(authenticated\)/\(terminals\)/components/ConnectionStatusBar/
git commit -m "feat(mobile): add ConnectionStatusBar component for terminal connection state"
```

---

## Task 10: HostList Component

**Files:**
- Create: `apps/mobile/screens/(authenticated)/(terminals)/components/HostList/HostList.tsx`
- Create: `apps/mobile/screens/(authenticated)/(terminals)/components/HostList/index.ts`

- [ ] **Step 1: Create the component**

```typescript
// apps/mobile/screens/(authenticated)/(terminals)/components/HostList/HostList.tsx

import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { Card, CardContent } from "@/components/ui/card";

interface Host {
  id: string;
  name: string;
  machineId: string;
  isOnline: boolean;
}

interface HostListProps {
  hosts: Host[];
  onSelectHost: (host: Host) => void;
}

export function HostList({ hosts, onSelectHost }: HostListProps) {
  if (hosts.length === 0) {
    return (
      <View className="items-center justify-center py-20">
        <Text className="text-center text-muted-foreground">
          No hosts found. Start Superset on your desktop to see it here.
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-3">
      <Text className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        Your Machines
      </Text>
      {hosts.map((host) => (
        <Pressable
          key={host.id}
          onPress={() => host.isOnline && onSelectHost(host)}
          disabled={!host.isOnline}
        >
          <Card className={host.isOnline ? "" : "opacity-50"}>
            <CardContent className="flex-row items-center justify-between py-3 px-4">
              <View className="flex-row items-center gap-3">
                <View
                  className={`h-2.5 w-2.5 rounded-full ${host.isOnline ? "bg-green-500" : "bg-muted-foreground"}`}
                />
                <View>
                  <Text className="font-medium text-foreground">{host.name}</Text>
                  <Text className="text-xs text-muted-foreground">{host.machineId}</Text>
                </View>
              </View>
              <Text className="text-xs text-muted-foreground">
                {host.isOnline ? "Online" : "Offline"}
              </Text>
            </CardContent>
          </Card>
        </Pressable>
      ))}
    </View>
  );
}
```

```typescript
// apps/mobile/screens/(authenticated)/(terminals)/components/HostList/index.ts
export { HostList } from "./HostList";
```

- [ ] **Step 2: Commit**

```bash
git add apps/mobile/screens/\(authenticated\)/\(terminals\)/components/HostList/
git commit -m "feat(mobile): add HostList component showing online/offline machines"
```

---

## Task 11: SessionList Component

**Files:**
- Create: `apps/mobile/screens/(authenticated)/(terminals)/components/SessionList/SessionList.tsx`
- Create: `apps/mobile/screens/(authenticated)/(terminals)/components/SessionList/index.ts`

- [ ] **Step 1: Create the component**

```typescript
// apps/mobile/screens/(authenticated)/(terminals)/components/SessionList/SessionList.tsx

import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { Card, CardContent } from "@/components/ui/card";

interface TerminalSession {
  terminalId: string;
  workspaceId: string;
  createdAt: number;
  exited: boolean;
}

interface SessionListProps {
  sessions: TerminalSession[];
  onSelectSession: (session: TerminalSession) => void;
  onBack: () => void;
  hostName: string;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function SessionList({ sessions, onSelectSession, onBack, hostName }: SessionListProps) {
  const activeSessions = sessions.filter((s) => !s.exited);
  const exitedSessions = sessions.filter((s) => s.exited);

  return (
    <View className="gap-3">
      <Pressable onPress={onBack}>
        <Text className="text-sm text-primary">&larr; Back to hosts</Text>
      </Pressable>
      <Text className="text-lg font-bold text-foreground">{hostName}</Text>

      {activeSessions.length === 0 && exitedSessions.length === 0 && (
        <View className="items-center justify-center py-20">
          <Text className="text-center text-muted-foreground">
            No terminal sessions running on this host.
          </Text>
        </View>
      )}

      {activeSessions.length > 0 && (
        <>
          <Text className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Active Sessions
          </Text>
          {activeSessions.map((session) => (
            <Pressable key={session.terminalId} onPress={() => onSelectSession(session)}>
              <Card>
                <CardContent className="flex-row items-center justify-between py-3 px-4">
                  <View className="flex-row items-center gap-3">
                    <View className="h-2.5 w-2.5 rounded-full bg-green-500" />
                    <View>
                      <Text className="font-mono text-sm text-foreground">
                        {session.terminalId.slice(0, 8)}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        Started {formatTime(session.createdAt)}
                      </Text>
                    </View>
                  </View>
                  <Text className="text-xs text-primary">Attach</Text>
                </CardContent>
              </Card>
            </Pressable>
          ))}
        </>
      )}

      {exitedSessions.length > 0 && (
        <>
          <Text className="text-sm font-medium text-muted-foreground uppercase tracking-wide mt-4">
            Exited
          </Text>
          {exitedSessions.map((session) => (
            <Card key={session.terminalId} className="opacity-50">
              <CardContent className="flex-row items-center gap-3 py-3 px-4">
                <View className="h-2.5 w-2.5 rounded-full bg-muted-foreground" />
                <View>
                  <Text className="font-mono text-sm text-foreground">
                    {session.terminalId.slice(0, 8)}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    Started {formatTime(session.createdAt)}
                  </Text>
                </View>
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </View>
  );
}
```

```typescript
// apps/mobile/screens/(authenticated)/(terminals)/components/SessionList/index.ts
export { SessionList } from "./SessionList";
```

- [ ] **Step 2: Commit**

```bash
git add apps/mobile/screens/\(authenticated\)/\(terminals\)/components/SessionList/
git commit -m "feat(mobile): add SessionList component for browsing terminal sessions"
```

---

## Task 12: TerminalsScreen (Host + Session Browser)

**Files:**
- Create: `apps/mobile/screens/(authenticated)/(terminals)/TerminalsScreen.tsx`
- Create: `apps/mobile/screens/(authenticated)/(terminals)/index.ts`

- [ ] **Step 1: Create the screen**

```typescript
// apps/mobile/screens/(authenticated)/(terminals)/TerminalsScreen.tsx

import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { Text } from "@/components/ui/text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HostList } from "./components/HostList";
import { SessionList } from "./components/SessionList";
import { useHosts } from "./hooks/useHosts";
import { useTerminalSessions } from "./hooks/useTerminalSessions";

interface Host {
  id: string;
  name: string;
  machineId: string;
  isOnline: boolean;
}

export function TerminalsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [selectedHost, setSelectedHost] = useState<Host | null>(null);
  const { data: hostsData, isLoading: hostsLoading, refetch: refetchHosts } = useHosts();
  const { data: sessions, isLoading: sessionsLoading, refetch: refetchSessions } = useTerminalSessions(
    selectedHost?.id ?? null,
  );

  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (selectedHost) {
      await refetchSessions();
    } else {
      await refetchHosts();
    }
    setRefreshing(false);
  }, [selectedHost, refetchHosts, refetchSessions]);

  const handleSelectSession = useCallback(
    (session: { terminalId: string }) => {
      if (!selectedHost) return;
      router.push({
        pathname: "/(authenticated)/(terminals)/terminal/[sessionId]",
        params: {
          sessionId: session.terminalId,
          hostId: selectedHost.id,
          hostName: selectedHost.name,
        },
      });
    },
    [selectedHost, router],
  );

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: 120 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View className="px-6 gap-4">
        <Text className="text-2xl font-bold text-foreground">Terminals</Text>

        {!selectedHost ? (
          hostsLoading ? (
            <Text className="text-muted-foreground">Loading hosts...</Text>
          ) : (
            <HostList
              hosts={hostsData?.hosts ?? []}
              onSelectHost={setSelectedHost}
            />
          )
        ) : (
          sessionsLoading ? (
            <Text className="text-muted-foreground">Loading sessions...</Text>
          ) : (
            <SessionList
              sessions={sessions ?? []}
              onSelectSession={handleSelectSession}
              onBack={() => setSelectedHost(null)}
              hostName={selectedHost.name}
            />
          )
        )}
      </View>
    </ScrollView>
  );
}
```

```typescript
// apps/mobile/screens/(authenticated)/(terminals)/index.ts
export { TerminalsScreen } from "./TerminalsScreen";
```

- [ ] **Step 2: Commit**

```bash
git add apps/mobile/screens/\(authenticated\)/\(terminals\)/TerminalsScreen.tsx apps/mobile/screens/\(authenticated\)/\(terminals\)/index.ts
git commit -m "feat(mobile): add TerminalsScreen with host and session browsing"
```

---

## Task 13: Terminal Screen (Full-screen Attach View)

**Files:**
- Create: `apps/mobile/screens/(authenticated)/(terminals)/terminal/TerminalScreen.tsx`
- Create: `apps/mobile/screens/(authenticated)/(terminals)/terminal/index.ts`

- [ ] **Step 1: Create the terminal attach screen**

```typescript
// apps/mobile/screens/(authenticated)/(terminals)/terminal/TerminalScreen.tsx

import { useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeft } from "lucide-react-native";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { authClient } from "@/lib/auth/client";
import { buildTerminalWsUrl } from "@/lib/terminal/relay";
import type { ConnectionState } from "@/lib/terminal/types";
import { TerminalWebView } from "../components/TerminalWebView";
import { ConnectionStatusBar } from "../components/ConnectionStatusBar";

export function TerminalScreen() {
  const { sessionId, hostId, hostName } = useLocalSearchParams<{
    sessionId: string;
    hostId: string;
    hostName: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");

  // Build WebSocket URL with auth token
  // Note: In production, this should fetch a JWT from the API's token endpoint.
  // For now, use the session cookie to get a token.
  const wsUrl = useMemo(() => {
    if (!hostId || !sessionId) return null;
    const cookies = authClient.getCookie();
    if (!cookies) return null;
    // The relay accepts the session token directly for WebSocket auth
    return buildTerminalWsUrl(hostId, sessionId, cookies);
  }, [hostId, sessionId]);

  const handleExit = useCallback((_exitCode: number, _signal: number) => {
    // Terminal exited — could show a "session ended" overlay
  }, []);

  return (
    <View className="flex-1 bg-[#1a1a2e]" style={{ paddingTop: insets.top }}>
      {/* Header */}
      <View className="flex-row items-center px-3 py-2 bg-[#1a1a2e]">
        <Pressable onPress={() => router.back()} className="p-2 mr-2">
          <Icon as={ChevronLeft} className="text-white size-5" />
        </Pressable>
        <Text className="text-white font-medium flex-1" numberOfLines={1}>
          {hostName ?? "Terminal"} — {sessionId?.slice(0, 8)}
        </Text>
      </View>

      {/* Connection status */}
      <ConnectionStatusBar state={connectionState} hostName={hostName} />

      {/* Terminal */}
      <TerminalWebView
        wsUrl={wsUrl}
        onConnectionStateChange={setConnectionState}
        onExit={handleExit}
      />
    </View>
  );
}
```

```typescript
// apps/mobile/screens/(authenticated)/(terminals)/terminal/index.ts
export { TerminalScreen } from "./TerminalScreen";
```

- [ ] **Step 2: Commit**

```bash
git add apps/mobile/screens/\(authenticated\)/\(terminals\)/terminal/
git commit -m "feat(mobile): add full-screen TerminalScreen for attaching to remote sessions"
```

---

## Task 14: App Routes and Tab Bar Integration

**Files:**
- Create: `apps/mobile/app/(authenticated)/(terminals)/_layout.tsx`
- Create: `apps/mobile/app/(authenticated)/(terminals)/index.tsx`
- Create: `apps/mobile/app/(authenticated)/(terminals)/terminal/[sessionId].tsx`
- Modify: `apps/mobile/app/(authenticated)/_layout.tsx`
- Modify: `apps/mobile/screens/(authenticated)/components/AuthenticatedTabBar/AuthenticatedTabBar.tsx`

- [ ] **Step 1: Create the route layout**

```typescript
// apps/mobile/app/(authenticated)/(terminals)/_layout.tsx
import { Stack } from "expo-router";

export default function TerminalsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="terminal/[sessionId]" />
    </Stack>
  );
}
```

- [ ] **Step 2: Create the index route**

```typescript
// apps/mobile/app/(authenticated)/(terminals)/index.tsx
import { TerminalsScreen } from "@/screens/(authenticated)/(terminals)";
export default TerminalsScreen;
```

- [ ] **Step 3: Create the terminal session route**

```typescript
// apps/mobile/app/(authenticated)/(terminals)/terminal/[sessionId].tsx
import { TerminalScreen } from "@/screens/(authenticated)/(terminals)/terminal";
export default TerminalScreen;
```

- [ ] **Step 4: Add tab trigger to authenticated layout**

In `apps/mobile/app/(authenticated)/_layout.tsx`, add the terminals tab trigger:

Change:
```typescript
<TabTrigger name="(home)" href="/(home)" />
<TabTrigger name="(tasks)" href="/(tasks)" />
<TabTrigger name="(more)" href="/(more)" />
```

To:
```typescript
<TabTrigger name="(home)" href="/(home)" />
<TabTrigger name="(tasks)" href="/(tasks)" />
<TabTrigger name="(terminals)" href="/(terminals)" />
<TabTrigger name="(more)" href="/(more)" />
```

- [ ] **Step 5: Add tab to tab bar**

In `apps/mobile/screens/(authenticated)/components/AuthenticatedTabBar/AuthenticatedTabBar.tsx`:

Change:
```typescript
const TABS: TabItem[] = [
  { name: "(home)", icon: "house.fill", label: "Home" },
  { name: "(tasks)", icon: "checkmark.square.fill", label: "Tasks" },
  { name: "__menu__", icon: "ellipsis", label: "More", isMenuTrigger: true },
];

const NAVIGABLE_TAB_NAMES = ["(home)", "(tasks)"];
```

To:
```typescript
const TABS: TabItem[] = [
  { name: "(home)", icon: "house.fill", label: "Home" },
  { name: "(tasks)", icon: "checkmark.square.fill", label: "Tasks" },
  { name: "(terminals)", icon: "terminal.fill", label: "Terminals" },
  { name: "__menu__", icon: "ellipsis", label: "More", isMenuTrigger: true },
];

const NAVIGABLE_TAB_NAMES = ["(home)", "(tasks)", "(terminals)"];
```

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/\(authenticated\)/\(terminals\)/ apps/mobile/app/\(authenticated\)/_layout.tsx apps/mobile/screens/\(authenticated\)/components/AuthenticatedTabBar/AuthenticatedTabBar.tsx
git commit -m "feat(mobile): wire up Terminals tab with routes and navigation"
```

---

## Task 15: Auth Token for Relay (JWT Minting)

**Files:**
- Modify: `apps/mobile/screens/(authenticated)/(terminals)/terminal/TerminalScreen.tsx`
- Modify: `apps/mobile/screens/(authenticated)/(terminals)/hooks/useTerminalSessions/useTerminalSessions.ts`

The relay server expects a JWT (verified via JWKS), not a session cookie. The API needs to mint a JWT for the mobile client. Check if an existing endpoint provides this — the desktop app uses `/api/auth/desktop/connect` to get tokens. If a similar endpoint exists for mobile, use it. Otherwise, the session cookie may work if the relay's `extractToken` falls back to cookie auth.

**This task requires investigation at implementation time.** The implementer should:

1. Check `apps/api/src/app/api/auth/` for token-minting endpoints
2. Check if the relay's `verifyJWT` accepts session tokens or only JWTs
3. If needed, create an API endpoint that mints a short-lived JWT from a session cookie

- [ ] **Step 1: Investigate auth token flow**

Read `apps/api/src/app/api/auth/desktop/connect/route.ts` to understand how the desktop gets its JWT. Read `apps/relay/src/auth.ts` to understand what token format is expected.

- [ ] **Step 2: Implement token acquisition**

Create a helper in `apps/mobile/lib/terminal/relay.ts`:

```typescript
/**
 * Get a JWT suitable for relay authentication.
 * The exact mechanism depends on what the API provides — this may call
 * a token-minting endpoint or use the session cookie directly.
 */
export async function getRelayJwt(): Promise<string> {
  // Implementation depends on investigation in Step 1.
  // Likely pattern: POST to an API endpoint that returns a scoped JWT.
  const cookies = authClient.getCookie();
  const res = await fetch(`${env.EXPO_PUBLIC_API_URL}/api/auth/token`, {
    method: "POST",
    headers: cookies ? { Cookie: cookies } : {},
  });
  if (!res.ok) throw new Error("Failed to mint relay JWT");
  const { token } = await res.json() as { token: string };
  return token;
}
```

- [ ] **Step 3: Update TerminalScreen to use JWT**

Update the `wsUrl` computation in `TerminalScreen.tsx` to call `getRelayJwt()` and pass the result to `buildTerminalWsUrl`.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/lib/terminal/relay.ts apps/mobile/screens/\(authenticated\)/\(terminals\)/terminal/TerminalScreen.tsx apps/mobile/screens/\(authenticated\)/\(terminals\)/hooks/useTerminalSessions/useTerminalSessions.ts
git commit -m "feat(mobile): implement relay JWT acquisition for authenticated terminal access"
```

---

## Summary

| Task | What it does | Dependencies |
|------|-------------|-------------|
| 1 | Terminal message types | None |
| 2 | WebSocket transport with reconnect | Task 1 |
| 3 | Relay URL builder + env config | None |
| 4 | listHosts tRPC query | None |
| 5 | useHosts hook | Task 4 |
| 6 | useTerminalSessions hook | Task 3 |
| 7 | xterm.js WebView HTML | None |
| 8 | TerminalWebView component | Tasks 2, 7 |
| 9 | ConnectionStatusBar component | Task 1 |
| 10 | HostList component | None |
| 11 | SessionList component | None |
| 12 | TerminalsScreen (browser) | Tasks 5, 6, 10, 11 |
| 13 | TerminalScreen (attach view) | Tasks 3, 8, 9 |
| 14 | Routes + tab bar integration | Tasks 12, 13 |
| 15 | Auth token flow for relay | Task 13 |

**Parallelizable groups:**
- Tasks 1, 3, 4, 7, 10, 11 can all run in parallel (no dependencies)
- Tasks 2, 5, 6, 8, 9 can run after their single dependency completes
- Tasks 12-15 are sequential and depend on earlier work

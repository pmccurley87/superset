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

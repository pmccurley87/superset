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

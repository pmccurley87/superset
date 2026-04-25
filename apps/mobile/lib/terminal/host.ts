import { env } from "../env";

/**
 * Build the WebSocket URL to attach to a terminal session directly on the host-service.
 *
 * When both the phone and desktop are on the same Tailscale network, we connect
 * directly to the host-service via its Tailscale IP — no cloud relay needed.
 *
 * Auth uses the host-service's pre-shared key (PSK), the same mechanism the
 * desktop Electron app uses for local connections.
 */
export function buildTerminalWsUrl(terminalId: string): string {
  const { ip, port, secret } = getHostConfig();
  return `ws://${ip}:${port}/terminal/${terminalId}?token=${encodeURIComponent(secret)}`;
}

/**
 * Build the HTTP URL for calling host-service tRPC procedures directly.
 */
export function buildHostTrpcUrl(procedure: string): string {
  const { ip, port } = getHostConfig();
  return `http://${ip}:${port}/trpc/${procedure}`;
}

/**
 * Get the host-service connection details from env.
 * Throws if not configured.
 */
export function getHostConfig(): { ip: string; port: string; secret: string } {
  const ip = env.EXPO_PUBLIC_HOST_IP;
  const port = env.EXPO_PUBLIC_HOST_PORT;
  const secret = env.EXPO_PUBLIC_HOST_SECRET;

  if (!ip || !port || !secret) {
    throw new Error(
      "Host connection not configured. Set EXPO_PUBLIC_HOST_IP, EXPO_PUBLIC_HOST_PORT, and EXPO_PUBLIC_HOST_SECRET.",
    );
  }

  return { ip, port, secret };
}

/**
 * Check if direct host connection is configured.
 */
export function isHostConfigured(): boolean {
  return !!(env.EXPO_PUBLIC_HOST_IP && env.EXPO_PUBLIC_HOST_PORT && env.EXPO_PUBLIC_HOST_SECRET);
}

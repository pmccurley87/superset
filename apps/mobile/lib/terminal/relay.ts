import { authClient } from "../auth/client";
import { env } from "../env";

let _cachedJwt: string | null = null;
let _cachedJwtExpiresAt = 0;
const JWT_CACHE_TTL_MS = 50 * 60 * 1000; // 50 minutes (JWT lasts ~1 hour)

/**
 * Fetch a short-lived JWT from the API's better-auth JWT plugin endpoint.
 *
 * The better-auth `jwt` plugin exposes GET /api/auth/token which exchanges a
 * valid session (cookie or Bearer token) for a signed RS256 JWT.  The relay
 * verifies tokens against the same JWKS endpoint, so this JWT is accepted
 * directly — raw session cookies are NOT accepted by the relay.
 *
 * The result is cached for 50 minutes to avoid redundant network round-trips
 * (e.g. from useTerminalSessions polling every 10 seconds).
 *
 * @throws {Error} if the session is missing or the API call fails.
 */
export async function getRelayJwt(): Promise<string> {
  if (_cachedJwt && Date.now() < _cachedJwtExpiresAt) {
    return _cachedJwt;
  }

  const cookies = authClient.getCookie();
  const res = await fetch(`${env.EXPO_PUBLIC_API_URL}/api/auth/token`, {
    headers: cookies ? { Cookie: cookies } : {},
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch relay JWT: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { token: string };
  if (!data.token) {
    throw new Error("Relay JWT response missing token field");
  }

  _cachedJwt = data.token;
  _cachedJwtExpiresAt = Date.now() + JWT_CACHE_TTL_MS;
  return _cachedJwt;
}

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

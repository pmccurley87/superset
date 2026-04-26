#!/usr/bin/env bun
/**
 * Remote Control Proxy Server
 *
 * Serves the built React app (./dist) and proxies /trpc/* + /terminal/*
 * to the host-service, auto-reading credentials from manifest.json on
 * every request so it survives host-service restarts with new ports/secrets.
 *
 * Bind to 0.0.0.0 so any Tailscale peer can reach it.
 *
 * Usage:  bun run server.ts
 * Env:    RC_PROXY_PORT (default 5198)
 *         SUPERSET_HOME_DIR (default ~/.superset)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const PORT = parseInt(process.env.RC_PROXY_PORT ?? "5198");
const SUPERSET_HOME = process.env.SUPERSET_HOME_DIR ?? `${process.env.HOME}/.superset`;
const DIST_DIR = join(import.meta.dir, "dist");

interface Manifest {
	pid: number;
	endpoint: string;   // "http://127.0.0.1:PORT"
	authToken: string;
	startedAt: number;
	organizationId: string;
}

function readManifest(): Manifest | null {
	try {
		const hostDir = join(SUPERSET_HOME, "host");
		for (const entry of readdirSync(hostDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const p = join(hostDir, entry.name, "manifest.json");
			try {
				return JSON.parse(readFileSync(p, "utf-8")) as Manifest;
			} catch {
				// try next org dir
			}
		}
	} catch {
		// host dir doesn't exist yet
	}
	return null;
}

const MIME: Record<string, string> = {
	".html":  "text/html; charset=utf-8",
	".js":    "application/javascript",
	".css":   "text/css",
	".svg":   "image/svg+xml",
	".json":  "application/json",
	".png":   "image/png",
	".ico":   "image/x-icon",
	".woff2": "font/woff2",
	".woff":  "font/woff",
	".ttf":   "font/ttf",
};

function serveStatic(pathname: string): Response {
	let filePath = join(DIST_DIR, decodeURIComponent(pathname));
	// SPA fallback: directories and missing paths → index.html
	try {
		if (statSync(filePath).isDirectory()) filePath = join(DIST_DIR, "index.html");
	} catch {
		filePath = join(DIST_DIR, "index.html");
	}
	try {
		const mime = MIME[extname(filePath)] ?? "application/octet-stream";
		const content = readFileSync(filePath);
		return new Response(content, {
			headers: { "Content-Type": mime, "Cache-Control": "no-cache" },
		});
	} catch {
		return new Response("Not found", { status: 404 });
	}
}

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Per-WebSocket state
interface WsData {
	terminalPath: string;   // e.g. "/terminal/v1%3Apane-..."
	manifest: Manifest;
	upstream: WebSocket | null;
	queue: (string | BufferSource)[];
	pingTimer: ReturnType<typeof setInterval> | null;
}

const server = Bun.serve<WsData>({
	port: PORT,
	hostname: "0.0.0.0",

	async fetch(req, server) {
		const url = new URL(req.url);
		const pathname = url.pathname;

		// CORS preflight
		if (req.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS });
		}

		// Proxy config — tells the React app it's running behind this proxy
		if (pathname === "/rc/config") {
			const manifest = readManifest();
			return Response.json(
				{ proxyMode: true, hostServiceRunning: !!manifest },
				{ headers: CORS },
			);
		}

		// Proxy tRPC calls to host-service
		if (pathname.startsWith("/trpc/")) {
			const manifest = readManifest();
			if (!manifest) {
				return Response.json(
					{ error: "host-service not running — check manifest" },
					{ status: 503, headers: CORS },
				);
			}
			const upstream = await fetch(`${manifest.endpoint}${pathname}${url.search}`, {
				method: req.method,
				headers: {
					...Object.fromEntries(
						[...req.headers.entries()].filter(([k]) => k !== "host"),
					),
					Authorization: `Bearer ${manifest.authToken}`,
				},
				body: req.body,
			});
			const respHeaders = new Headers(upstream.headers);
			respHeaders.set("Access-Control-Allow-Origin", "*");
			return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
		}

		// WebSocket upgrade for /terminal/*
		if (pathname.startsWith("/terminal/")) {
			const manifest = readManifest();
			if (!manifest) {
				return new Response("host-service not running", { status: 503 });
			}
			const ok = server.upgrade(req, {
				data: { terminalPath: pathname, manifest, upstream: null, queue: [], pingTimer: null } satisfies WsData,
			});
			if (ok) return undefined as unknown as Response;
			return new Response("WebSocket upgrade failed", { status: 426 });
		}

		// Static file serving (SPA fallback to index.html)
		return serveStatic(pathname);
	},

	websocket: {
		idleTimeout: 0, // disable Bun's built-in idle timeout — we manage keepalive ourselves

		open(ws) {
			const { manifest, terminalPath } = ws.data;
			const ep = new URL(manifest.endpoint);
			const upstreamUrl = `ws://${ep.hostname}:${ep.port}${terminalPath}?token=${manifest.authToken}`;

			const upstream = new WebSocket(upstreamUrl);
			ws.data.upstream = upstream;

			upstream.onopen = () => {
				for (const msg of ws.data.queue) upstream.send(msg as string);
				ws.data.queue = [];

				// Ping upstream every 20s so NAT/host-service don't drop the idle connection
				ws.data.pingTimer = setInterval(() => {
					if (upstream.readyState === WebSocket.OPEN) {
						upstream.send(JSON.stringify({ type: "ping" }));
					}
				}, 20_000);
			};

			upstream.onmessage = (ev) => {
				try {
					ws.send(ev.data as string | ArrayBuffer);
				} catch {
					// client already closed
				}
			};

			upstream.onclose = (ev) => {
				console.log(`[ws-proxy] upstream closed path=${terminalPath} code=${ev.code} reason="${ev.reason}" wasClean=${ev.wasClean}`);
				clearInterval(ws.data.pingTimer ?? undefined);
				// Forward the upstream close code so the browser can distinguish
				// normal close (1000) from unexpected drops (anything else).
				// Clamp to valid range; use 1001 (Going Away) if upstream sent 1000
				// so the browser reconnect logic knows this wasn't intentional.
				const code = ev.code === 1000 ? 1001 : (ev.code >= 1000 && ev.code <= 4999 ? ev.code : 1001);
				try { ws.close(code, ev.reason || "upstream closed"); } catch { /* already closed */ }
			};

			upstream.onerror = (err) => {
				console.error("[ws-proxy] upstream error:", err);
				clearInterval(ws.data.pingTimer ?? undefined);
				try { ws.close(); } catch { /* already closed */ }
			};
		},

		message(ws, message) {
			const { upstream, queue } = ws.data;
			if (!upstream) return;
			if (upstream.readyState === WebSocket.OPEN) {
				upstream.send(message as string | ArrayBuffer);
			} else {
				queue.push(message as string | ArrayBuffer);
			}
		},

		close(ws) {
			clearInterval(ws.data.pingTimer ?? undefined);
			ws.data.upstream?.close();
		},
	},
});

const manifest = readManifest();
console.log(`\nRC Proxy running at http://0.0.0.0:${PORT}`);
console.log(`Host-service: ${manifest?.endpoint ?? "⚠ not found"}`);
console.log(`Manifest dir: ${join(SUPERSET_HOME, "host")}\n`);

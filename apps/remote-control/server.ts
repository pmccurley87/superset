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

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";

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
	".html": "text/html; charset=utf-8",
	".js":   "application/javascript",
	".css":  "text/css",
	".svg":  "image/svg+xml",
	".json": "application/json",
	".png":  "image/png",
	".ico":  "image/x-icon",
	".woff2":"font/woff2",
	".woff": "font/woff",
	".ttf":  "font/ttf",
};

function serveStatic(pathname: string, res: ServerResponse) {
	let filePath = join(DIST_DIR, decodeURIComponent(pathname));
	// SPA fallback: unknown paths → index.html
	if (!existsSync(filePath) || filePath === DIST_DIR) {
		filePath = join(DIST_DIR, "index.html");
	}
	try {
		const mime = MIME[extname(filePath)] ?? "application/octet-stream";
		const content = readFileSync(filePath);
		res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
		res.end(content);
	} catch {
		res.writeHead(404);
		res.end("Not found");
	}
}

async function proxyHttp(req: IncomingMessage, res: ServerResponse, manifest: Manifest) {
	const upstreamUrl = manifest.endpoint + req.url;

	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const body = Buffer.concat(chunks);

	try {
		const upstream = await fetch(upstreamUrl, {
			method: req.method,
			headers: {
				...(Object.fromEntries(
					Object.entries(req.headers)
						.filter(([k]) => k !== "host" && !Array.isArray(k))
						.map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]),
				)),
				Authorization: `Bearer ${manifest.authToken}`,
			},
			body: body.length > 0 ? body : undefined,
		});

		const headers: Record<string, string> = {};
		upstream.headers.forEach((v, k) => { headers[k] = v; });
		// Allow any Tailscale origin
		headers["Access-Control-Allow-Origin"] = "*";

		res.writeHead(upstream.status, headers);
		res.end(Buffer.from(await upstream.arrayBuffer()));
	} catch (err) {
		res.writeHead(502);
		res.end(JSON.stringify({ error: String(err) }));
	}
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://localhost`);
	const pathname = url.pathname;

	// Handle CORS preflight
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
		});
		res.end();
		return;
	}

	// Proxy config — tells the React app it's running behind this proxy
	if (pathname === "/rc/config") {
		const manifest = readManifest();
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ proxyMode: true, hostServiceRunning: !!manifest }));
		return;
	}

	// Proxy tRPC calls to host-service
	if (pathname.startsWith("/trpc/")) {
		const manifest = readManifest();
		if (!manifest) {
			res.writeHead(503, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "host-service not running — check manifest" }));
			return;
		}
		await proxyHttp(req, res, manifest);
		return;
	}

	// Static file serving (SPA fallback to index.html)
	serveStatic(pathname, res);
});

// WebSocket proxy for /terminal/*
server.on("upgrade", (req, socket, head) => {
	if (!req.url?.startsWith("/terminal/")) {
		socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
		socket.destroy();
		return;
	}

	const manifest = readManifest();
	if (!manifest) {
		socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
		socket.destroy();
		return;
	}

	// Parse host-service endpoint: "http://127.0.0.1:PORT"
	const endpointUrl = new URL(manifest.endpoint);
	const upstreamHost = endpointUrl.hostname;
	const upstreamPort = parseInt(endpointUrl.port);

	// Append the auth token to the upstream path
	const hasQuery = req.url.includes("?");
	const upstreamPath = req.url + (hasQuery ? "&" : "?") + `token=${manifest.authToken}`;

	const upstream = createConnection(upstreamPort, upstreamHost);

	upstream.once("connect", () => {
		const upgradeReq = [
			`GET ${upstreamPath} HTTP/1.1`,
			`Host: ${upstreamHost}:${upstreamPort}`,
			`Upgrade: websocket`,
			`Connection: Upgrade`,
			`Sec-WebSocket-Key: ${req.headers["sec-websocket-key"] ?? "dGhlIHNhbXBsZSBub25jZQ=="}`,
			`Sec-WebSocket-Version: 13`,
			`\r\n`,
		].join("\r\n");
		upstream.write(upgradeReq);
		if (head.length > 0) upstream.write(head);
	});

	// Pipe bidirectionally
	upstream.pipe(socket);
	socket.pipe(upstream);

	const cleanup = () => { upstream.destroy(); socket.destroy(); };
	socket.on("error", cleanup);
	socket.on("close", cleanup);
	upstream.on("error", cleanup);
	upstream.on("close", cleanup);
});

server.listen(PORT, "0.0.0.0", () => {
	const manifest = readManifest();
	console.log(`\nRC Proxy running at http://0.0.0.0:${PORT}`);
	console.log(`Host-service: ${manifest?.endpoint ?? "⚠ not found"}`);
	console.log(`Manifest dir: ${join(SUPERSET_HOME, "host")}\n`);
});

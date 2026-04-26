#!/usr/bin/env bun
/**
 * E2E WebSocket test: connects to the rc-proxy terminal endpoint and
 * reports connection lifecycle, timing, and close codes.
 *
 * Usage:
 *   bun run test-ws.ts [terminalId]
 *
 * If no terminalId is given, it lists available sessions and picks the first one.
 */

const PROXY_HOST = "100.68.9.36";
const PROXY_PORT = 5198;
const BASE = `http://${PROXY_HOST}:${PROXY_PORT}`;
const WS_BASE = `ws://${PROXY_HOST}:${PROXY_PORT}`;
const TEST_DURATION_MS = 30_000;

function ts() {
	return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function log(msg: string) {
	console.log(`[${ts()}] ${msg}`);
}

// ── Fetch sessions via tRPC ──────────────────────────────────────────────────

async function fetchSessions() {
	const input = encodeURIComponent(JSON.stringify({ "0": { json: null } }));
	const url = `${BASE}/trpc/terminal.listAll?batch=1&input=${input}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`tRPC listAll failed: ${res.status} ${await res.text()}`);
	const json = await res.json() as Array<{ result: { data: { json: { sessions: Array<{ terminalId: string; cwd: string; exited: boolean; attached: boolean }> } } } }>;
	return json[0]?.result?.data?.json?.sessions ?? [];
}

// ── Main ─────────────────────────────────────────────────────────────────────

const argId = process.argv[2];

let terminalId: string;

if (argId) {
	terminalId = argId;
	log(`Using provided terminalId: ${terminalId}`);
} else {
	log("Fetching sessions…");
	const sessions = await fetchSessions();
	if (!sessions.length) {
		console.error("No sessions found. Start a terminal session on the desktop first.");
		process.exit(1);
	}
	log(`Found ${sessions.length} session(s):`);
	for (const s of sessions) {
		log(`  ${s.terminalId} | cwd=${s.cwd} | exited=${s.exited} | attached=${s.attached}`);
	}
	const live = sessions.find((s) => !s.exited) ?? sessions[0];
	terminalId = live.terminalId;
	log(`Selected: ${terminalId}`);
}

const wsUrl = `${WS_BASE}/terminal/${encodeURIComponent(terminalId)}`;
log(`Connecting to ${wsUrl}`);

let connectTime = Date.now();
let messageCount = 0;
let bytesReceived = 0;

const ws = new WebSocket(wsUrl);

ws.onopen = () => {
	const elapsed = Date.now() - connectTime;
	log(`✓ Connected (${elapsed}ms). Sending resize 220x50…`);
	ws.send(JSON.stringify({ type: "resize", cols: 220, rows: 50 }));
};

ws.onmessage = (ev) => {
	messageCount++;
	const data = ev.data as string;
	bytesReceived += data.length;
	try {
		const msg = JSON.parse(data) as { type: string; data?: string; exitCode?: number; message?: string };
		if (msg.type === "replay") {
			log(`← replay (${msg.data?.length ?? 0} chars)`);
		} else if (msg.type === "data") {
			// Don't spam — just count
		} else {
			log(`← ${msg.type}: ${JSON.stringify(msg)}`);
		}
	} catch {
		log(`← (raw ${data.length} bytes)`);
	}
};

ws.onerror = (ev) => {
	log(`✗ WebSocket error: ${JSON.stringify(ev)}`);
};

ws.onclose = (ev) => {
	const elapsed = Date.now() - connectTime;
	log(`✗ Closed after ${elapsed}ms — code=${ev.code} reason="${ev.reason}" wasClean=${ev.wasClean}`);
	log(`  Messages received: ${messageCount}, bytes: ${bytesReceived}`);
	clearInterval(pingInterval);
	clearTimeout(testTimer);
	process.exit(ev.code === 1000 ? 0 : 1);
};

const noHeartbeat = process.argv.includes("--no-heartbeat");

// Optionally send a keepalive every 5s
const pingInterval = noHeartbeat ? null : setInterval(() => {
	if (ws.readyState === WebSocket.OPEN) {
		log("→ sending resize heartbeat");
		ws.send(JSON.stringify({ type: "resize", cols: 220, rows: 50 }));
	}
}, 5000);

if (noHeartbeat) log("Mode: idle (no heartbeat) — mimicking browser after initial resize");

// Auto-close after test duration
const testTimer = setTimeout(() => {
	const elapsed = Date.now() - connectTime;
	log(`✓ Test complete — connection stayed open for ${elapsed}ms`);
	log(`  Messages received: ${messageCount}, bytes: ${bytesReceived}`);
	ws.close(1000, "test complete");
}, TEST_DURATION_MS);

log(`Waiting up to ${TEST_DURATION_MS / 1000}s…`);

#!/usr/bin/env bun
/**
 * Simulates the browser reconnect loop:
 * connect → wait → force-close → reconnect immediately
 * Checks if the second connection also works.
 */

const PROXY_HOST = "100.68.9.36";
const PROXY_PORT = 5198;
const WS_BASE = `ws://${PROXY_HOST}:${PROXY_PORT}`;

const terminalId = process.argv[2] ?? "v1:pane-1776333871501-piwffbv5l";
const url = `${WS_BASE}/terminal/${encodeURIComponent(terminalId)}`;

function ts() { return new Date().toISOString().slice(11, 23); }
function log(msg: string) { console.log(`[${ts()}] ${msg}`); }

async function connect(label: string, holdMs: number): Promise<{ survived: boolean; closeCode: number }> {
	return new Promise((resolve) => {
		log(`[${label}] Connecting…`);
		const ws = new WebSocket(url);
		let openTime = 0;
		let replayReceived = false;

		ws.onopen = () => {
			openTime = Date.now();
			log(`[${label}] Connected. Sending resize…`);
			ws.send(JSON.stringify({ type: "resize", cols: 220, rows: 50 }));
		};

		ws.onmessage = (ev) => {
			const msg = JSON.parse(ev.data as string) as { type: string; data?: string };
			if (msg.type === "replay") {
				replayReceived = true;
				log(`[${label}] Got replay (${msg.data?.length ?? 0} chars). Will hold for ${holdMs}ms…`);
				setTimeout(() => {
					if (ws.readyState === WebSocket.OPEN) {
						log(`[${label}] Force-closing after ${holdMs}ms`);
						ws.close(4001, "test force-close");
					}
				}, holdMs);
			}
		};

		ws.onclose = (ev) => {
			const elapsed = openTime ? Date.now() - openTime : -1;
			const survived = ev.code === 4001; // we closed it ourselves
			log(`[${label}] Closed after ${elapsed}ms — code=${ev.code} reason="${ev.reason}" survived=${survived} replayReceived=${replayReceived}`);
			resolve({ survived, closeCode: ev.code });
		};

		ws.onerror = () => log(`[${label}] Error`);

		// Safety: if replay never arrives, timeout
		setTimeout(() => {
			if (ws.readyState === WebSocket.OPEN) ws.close(4002, "timeout");
		}, 15_000);
	});
}

log(`Testing rapid reconnect for: ${terminalId}`);

// Round 1: connect, hold 3s, close
const r1 = await connect("R1", 3000);
if (!r1.survived) {
	log("❌ R1 closed unexpectedly before we could force-close it");
	process.exit(1);
}

log("R1 done. Reconnecting immediately (no delay)…");

// Round 2: reconnect right away (simulating browser auto-reconnect)
const r2 = await connect("R2", 5000);
if (!r2.survived) {
	log(`❌ R2 closed unexpectedly (code=${r2.closeCode}) — RECONNECT FAILS`);
	process.exit(1);
}

log("✅ Both connections worked. Reconnect is stable.");
process.exit(0);

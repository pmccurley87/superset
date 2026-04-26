/**
 * Bridge between the internal terminal-host daemon (unix socket / NDJSON)
 * and the HTTP host-service WebSocket endpoint.
 *
 * terminal-host uses two socket roles:
 *   "control" — request/response for commands (createOrAttach, write, resize, detach)
 *   "stream"  — event stream (data, exit events for attached sessions)
 *
 * Wire format: newline-delimited JSON on a unix socket.
 *   Request:  {"id":"req_1","type":"...","payload":{...}}\n
 *   Response: {"id":"req_1","ok":true,"payload":{...}}\n
 *   Event:    {"type":"event","sessionId":"...","payload":{"type":"data","data":"..."}}\n
 */
import { connect, type Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROTOCOL_VERSION = 2;
const TIMEOUT_MS = 3000;

function sockPath(): string {
	const home = process.env.SUPERSET_HOME_DIR || process.env.HOME || "";
	return join(home, "terminal-host.sock");
}

function readToken(): string | null {
	const home = process.env.SUPERSET_HOME_DIR || process.env.HOME || "";
	const p = join(home, "terminal-host.token");
	if (!existsSync(p)) return null;
	return readFileSync(p, "utf-8").trim();
}

function isAvailable(): boolean {
	return existsSync(sockPath()) && readToken() !== null;
}

// Send one request and read lines until the matching response arrives.
// Returns the parsed payload and any leftover buffered data.
function doRequest<T>(
	sock: Socket,
	id: string,
	type: string,
	payload: unknown,
	leftover = "",
): Promise<{ payload: T; leftover: string }> {
	return new Promise((resolve, reject) => {
		let buf = leftover;

		const tid = setTimeout(() => {
			sock.off("data", onData);
			reject(new Error(`terminal-host request timeout: ${type}`));
		}, TIMEOUT_MS);

		const onData = (chunk: Buffer) => {
			buf += chunk.toString();
			let nl: number;
			while ((nl = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				try {
					const msg = JSON.parse(line) as {
						id?: string;
						ok?: boolean;
						payload?: unknown;
						error?: { message: string };
					};
					if (msg.id === id) {
						clearTimeout(tid);
						sock.off("data", onData);
						if (msg.ok) {
							resolve({ payload: msg.payload as T, leftover: buf });
						} else {
							reject(
								new Error(msg.error?.message ?? "terminal-host request failed"),
							);
						}
						return;
					}
				} catch {
					// ignore malformed lines
				}
			}
		};

		sock.on("data", onData);
		sock.write(`${JSON.stringify({ id, type, payload })}\n`);
	});
}

async function connectAndAuth(
	role: "control" | "stream",
): Promise<{ sock: Socket; leftover: string }> {
	const token = readToken();
	if (!token) throw new Error("terminal-host token not found");

	return new Promise((resolve, reject) => {
		const sock = connect(sockPath());
		sock.setTimeout(TIMEOUT_MS);
		sock.on("timeout", () => {
			sock.destroy();
			reject(new Error("terminal-host connect timeout"));
		});
		sock.on("error", reject);
		sock.on("connect", async () => {
			sock.off("error", reject);
			try {
				const { leftover } = await doRequest<{ protocolVersion: number }>(
					sock,
					"auth_1",
					"hello",
					{
						token,
						protocolVersion: PROTOCOL_VERSION,
						clientId: `host-service-bridge-${role}`,
						role,
					},
				);
				resolve({ sock, leftover });
			} catch (e) {
				sock.destroy();
				reject(e);
			}
		});
	});
}

// ─── Public: list V1 sessions ────────────────────────────────────────────────

export interface V1Session {
	sessionId: string;
	workspaceId: string | null;
	pid: number | null;
	createdAt: number;
	isAlive: boolean;
}

export async function listV1Sessions(): Promise<V1Session[]> {
	if (!isAvailable()) return [];
	try {
		const { sock, leftover } = await connectAndAuth("control");
		const { payload } = await doRequest<{ sessions: V1Session[] }>(
			sock,
			"req_list",
			"listSessions",
			{},
			leftover,
		);
		sock.destroy();
		return (payload.sessions ?? []).filter((s) => s.isAlive);
	} catch {
		return [];
	}
}

// ─── Public: proxy a WebSocket to a V1 session ───────────────────────────────

interface BridgeWs {
	send: (data: string) => void;
	readyState: number;
}

const WS_OPEN = 1;

export function attachV1Session(
	sessionId: string,
	ws: BridgeWs,
	onDetach: () => void,
): void {
	if (!isAvailable()) {
		ws.send(
			JSON.stringify({ type: "error", message: "terminal-host not available" }),
		);
		onDetach();
		return;
	}

	let closed = false;
	let controlSock: Socket | null = null;
	let streamSock: Socket | null = null;
	let reqCounter = 0;

	const close = () => {
		if (closed) return;
		closed = true;
		controlSock?.destroy();
		streamSock?.destroy();
		onDetach();
	};

	// Helper: send a fire-and-forget notification on the control socket
	const notify = (type: string, payload: unknown) => {
		if (!controlSock || closed) return;
		reqCounter++;
		controlSock.write(
			`${JSON.stringify({ id: `notify_${reqCounter}`, type, payload })}\n`,
		);
	};

	// Set up stream socket — receives data/exit events
	connectAndAuth("stream")
		.then(({ sock, leftover }) => {
			streamSock = sock;
			sock.on("error", close);
			sock.on("close", close);

			let buf = leftover;

			const process = () => {
				let nl: number;
				while ((nl = buf.indexOf("\n")) !== -1) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					try {
						const msg = JSON.parse(line) as {
							type?: string;
							sessionId?: string;
							payload?: { type: string; data?: string; exitCode?: number };
						};
						if (msg.type !== "event" || msg.sessionId !== sessionId) continue;
						const p = msg.payload;
						if (!p) continue;
						if (p.type === "data" && ws.readyState === WS_OPEN) {
							ws.send(JSON.stringify({ type: "data", data: p.data }));
						} else if (p.type === "exit") {
							if (ws.readyState === WS_OPEN) {
								ws.send(
									JSON.stringify({ type: "exit", exitCode: p.exitCode ?? 0 }),
								);
							}
							close();
						}
					} catch {
						// ignore
					}
				}
			};

			process(); // flush anything that arrived with the auth response
			sock.on("data", (chunk: Buffer) => {
				buf += chunk.toString();
				process();
			});
		})
		.catch(close);

	// Set up control socket — createOrAttach then handle write/resize
	connectAndAuth("control")
		.then(async ({ sock, leftover }) => {
			controlSock = sock;
			sock.on("error", close);
			sock.on("close", close);

			reqCounter++;
			const { payload: attachPayload } = await doRequest<{
				snapshot?: { snapshotAnsi?: string; rehydrateSequences?: string };
			}>(
				sock,
				`req_${reqCounter}`,
				"createOrAttach",
				{ sessionId, cols: 220, rows: 50 },
				leftover,
			);

			// Send the full terminal snapshot as replay so client sees current state
			const snap = attachPayload.snapshot;
			if (snap && ws.readyState === WS_OPEN) {
				const replay = (snap.rehydrateSequences ?? "") + (snap.snapshotAnsi ?? "");
				if (replay) ws.send(JSON.stringify({ type: "replay", data: replay }));
			}

			// Ignore remaining control responses (we use notify for writes)
			sock.on("data", () => {});
		})
		.catch(close);

	// Expose write/resize/detach so the WS handler can call them
	// We attach them directly to the ws object as side-channel (simpler than returning)
	(ws as BridgeWs & { _v1Write?: (d: string) => void; _v1Resize?: (c: number, r: number) => void; _v1Detach?: () => void })._v1Write = (data: string) => {
		notify("write", { sessionId, data });
	};
	(ws as BridgeWs & { _v1Resize?: (c: number, r: number) => void })._v1Resize = (cols: number, rows: number) => {
		notify("resize", { sessionId, cols, rows });
	};
	(ws as BridgeWs & { _v1Detach?: () => void })._v1Detach = () => {
		notify("detach", { sessionId });
		close();
	};
}

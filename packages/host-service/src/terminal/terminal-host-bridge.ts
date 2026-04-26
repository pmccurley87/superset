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
	clientId: string,
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
						clientId,
						role,
					},
				);
				// Disable the idle timeout now that auth is done — the socket stays
				// open indefinitely for streaming or awaiting write/resize commands.
				sock.setTimeout(0);
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
	createdAt: number; // epoch ms
	isAlive: boolean;
}

interface RawV1Session {
	sessionId: string;
	workspaceId?: string | null;
	pid?: number | null;
	createdAt?: string | number;
	isAlive: boolean;
}

export async function listV1Sessions(): Promise<V1Session[]> {
	if (!isAvailable()) return [];
	try {
		const { sock, leftover } = await connectAndAuth("control", "host-service-list");
		const { payload } = await doRequest<{ sessions: RawV1Session[] }>(
			sock,
			"req_list",
			"listSessions",
			{},
			leftover,
		);
		sock.destroy();
		return (payload.sessions ?? [])
			.filter((s) => s.isAlive)
			.map((s) => ({
				sessionId: s.sessionId,
				workspaceId: s.workspaceId ?? null,
				pid: s.pid ?? null,
				createdAt: s.createdAt
					? typeof s.createdAt === "string"
						? new Date(s.createdAt).getTime()
						: s.createdAt
					: Date.now(),
				isAlive: s.isAlive,
			}));
	} catch {
		return [];
	}
}

// ─── Public: proxy a WebSocket to a V1 session ───────────────────────────────

export interface V1BridgeHandle {
	write: (data: string) => void;
	resize: (cols: number, rows: number) => void;
	detach: () => void;
}

const WS_OPEN = 1;

/**
 * Attach to a V1 terminal-host session and stream its output via sendFn.
 * Returns a handle with write/resize/detach — store it in a closure variable
 * shared across onOpen/onMessage/onClose handlers, NOT as a property on ws.
 */
export function attachV1Session(
	sessionId: string,
	sendFn: (data: string) => void,
	onDetach: () => void,
): V1BridgeHandle {
	if (!isAvailable()) {
		sendFn(JSON.stringify({ type: "error", message: "terminal-host not available" }));
		onDetach();
		return { write: () => {}, resize: () => {}, detach: () => {} };
	}

	// Both sockets MUST share the same clientId so terminal-host links them
	const clientId = `host-service-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

	const notify = (type: string, payload: unknown) => {
		if (!controlSock || closed) return;
		reqCounter++;
		controlSock.write(
			`${JSON.stringify({ id: `notify_${reqCounter}`, type, payload })}\n`,
		);
	};

	// Connect stream socket first so terminal-host can link it to the client
	// before we call createOrAttach on the control socket.
	connectAndAuth("stream", clientId)
		.then(({ sock, leftover }) => {
			streamSock = sock;
			sock.on("error", close);
			sock.on("close", close);

			let buf = leftover;

			const processStream = () => {
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
						if (p.type === "data") {
							sendFn(JSON.stringify({ type: "data", data: p.data }));
						} else if (p.type === "exit") {
							sendFn(JSON.stringify({ type: "exit", exitCode: p.exitCode ?? 0 }));
							close();
						}
					} catch {
						// ignore malformed lines
					}
				}
			};

			processStream();
			sock.on("data", (chunk: Buffer) => {
				buf += chunk.toString();
				processStream();
			});

			// Stream is ready — now open the control socket and attach
			return connectAndAuth("control", clientId);
		})
		.then(async ({ sock, leftover }) => {
			if (closed) { sock.destroy(); return; }
			controlSock = sock;
			sock.on("error", close);
			sock.on("close", close);

			reqCounter++;
			const { payload: attachPayload } = await doRequest<{
				snapshotAnsi?: string;
				rehydrateSequences?: string;
				snapshot?: { snapshotAnsi?: string; rehydrateSequences?: string };
			}>(
				sock,
				`req_${reqCounter}`,
				"createOrAttach",
				{ sessionId, cols: 220, rows: 50 },
				leftover,
			);

			// Send snapshot as replay — terminal-host may nest it or return at top level
			const snap = attachPayload.snapshot ?? attachPayload;
			const replay = (snap?.rehydrateSequences ?? "") + (snap?.snapshotAnsi ?? "");
			if (replay) sendFn(JSON.stringify({ type: "replay", data: replay }));

			// Discard any further data on the control socket (acks for notify calls)
			sock.on("data", () => {});
		})
		.catch(close);

	return {
		write: (data: string) => notify("write", { sessionId, data }),
		resize: (cols: number, rows: number) => notify("resize", { sessionId, cols, rows }),
		detach: () => { notify("detach", { sessionId }); close(); },
	};
}

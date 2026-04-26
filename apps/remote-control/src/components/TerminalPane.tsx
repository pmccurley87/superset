import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { Credentials } from "../lib/types";

interface Props {
	terminalId: string;
	credentials: Credentials;
	visible: boolean;
}

interface Instance {
	term: Terminal;
	fit: FitAddon;
	ws: WebSocket;
	destroyed: boolean;
}

// Keep terminal instances alive across re-renders and tab switches
const instances = new Map<string, Instance>();

function buildWsUrl(credentials: Credentials, terminalId: string): string {
	const encodedId = encodeURIComponent(terminalId);
	if (!credentials.secret) {
		const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
		const host = credentials.ip && credentials.port
			? `${credentials.ip}:${credentials.port}`
			: window.location.host;
		return `${proto}//${host}/terminal/${encodedId}`;
	}
	return `ws://${credentials.ip}:${credentials.port}/terminal/${encodedId}?token=${credentials.secret}`;
}

function fitAndResize(fit: FitAddon, ws: WebSocket, term: Terminal) {
	fit.fit();
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
	}
}

function connectWs(
	credentials: Credentials,
	terminalId: string,
	inst: Instance,
	reconnect = false,
) {
	if (inst.destroyed) return;

	if (reconnect) {
		inst.term.writeln("\r\n\x1b[33m[Reconnecting…]\x1b[0m");
	}

	const ws = new WebSocket(buildWsUrl(credentials, terminalId));
	inst.ws = ws;

	ws.onopen = () => {
		if (reconnect) {
			inst.term.writeln("\x1b[32m[Reconnected]\x1b[0m\r\n");
		}
		fitAndResize(inst.fit, ws, inst.term);

		setTimeout(() => {
			if (ws.readyState !== WebSocket.OPEN) return;
			const prevCols = inst.term.cols;
			const prevRows = inst.term.rows;
			inst.fit.fit();
			if (inst.term.cols !== prevCols || inst.term.rows !== prevRows) {
				ws.send(JSON.stringify({ type: "resize", cols: inst.term.cols, rows: inst.term.rows }));
			}
		}, 300);
	};

	ws.onmessage = (ev) => {
		try {
			const msg = JSON.parse(ev.data as string);
			if (msg.type === "data" || msg.type === "replay") {
				inst.term.write(msg.data);
			} else if (msg.type === "exit") {
				inst.term.writeln(`\r\n[Process exited with code ${msg.exitCode}]`);
			} else if (msg.type === "error") {
				inst.term.writeln(`\r\n[Error: ${msg.message}]`);
			}
		} catch {
			inst.term.write(ev.data as string);
		}
	};

	ws.onerror = () => {
		// onclose will fire right after and handle reconnect
	};

	ws.onclose = (ev) => {
		if (inst.destroyed) return;
		// code 1000 = normal close (destroyTerminal was called externally), don't reconnect
		if (ev.code === 1000) {
			inst.term.writeln("\r\n[Connection closed]");
			return;
		}
		// Unexpected close — reconnect after a short delay
		setTimeout(() => connectWs(credentials, terminalId, inst, true), 2000);
	};
}

export function TerminalPane({ terminalId, credentials, visible }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);

	// useLayoutEffect runs synchronously after DOM commit but before paint,
	// so CSS layout is already computed — fit.fit() gets correct dimensions.
	useLayoutEffect(() => {
		if (!containerRef.current) return;

		if (instances.has(terminalId)) {
			// Move existing xterm DOM into this container (tab switch)
			const { term } = instances.get(terminalId)!;
			const el = term.element?.parentElement;
			if (el && el !== containerRef.current) {
				containerRef.current.appendChild(el);
			}
			return;
		}

		const term = new Terminal({
			theme: {
				background: "#111318",
				foreground: "#e8eaf0",
				cursor: "#6b8fd4",
				selectionBackground: "#2a3a5c",
				black: "#1a1d26", brightBlack: "#3a3f52",
				red: "#e06c75",   brightRed: "#f47d85",
				green: "#98c379", brightGreen: "#a8d38a",
				yellow: "#e5c07b", brightYellow: "#f0cc8a",
				blue: "#61afef",  brightBlue: "#7abfff",
				magenta: "#c678dd", brightMagenta: "#d688ed",
				cyan: "#56b6c2",  brightCyan: "#66c6d2",
				white: "#abb2bf", brightWhite: "#e8eaf0",
			},
			fontFamily: "monospace",
			fontSize: 13,
			cursorBlink: true,
		});

		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(containerRef.current);
		fit.fit();

		const inst: Instance = { term, fit, ws: null!, destroyed: false };
		instances.set(terminalId, inst);

		// Wire input: always send through the current ws (inst.ws, not a stale closure)
		term.onData((data) => {
			if (inst.ws?.readyState === WebSocket.OPEN) {
				inst.ws.send(JSON.stringify({ type: "input", data }));
			}
		});

		const resizeObserver = new ResizeObserver(() => {
			if (inst.ws) fitAndResize(inst.fit, inst.ws, inst.term);
		});
		resizeObserver.observe(containerRef.current);

		// Touch scroll: translate swipe gestures into xterm scroll calls.
		// xterm renders to canvas so native touch scroll doesn't work.
		let touchLastY = 0;
		const onTouchStart = (e: TouchEvent) => { touchLastY = e.touches[0].clientY; };
		const onTouchMove = (e: TouchEvent) => {
			const y = e.touches[0].clientY;
			const delta = touchLastY - y;
			touchLastY = y;
			const lines = delta / 17;
			if (Math.abs(lines) >= 0.5) term.scrollLines(Math.round(lines));
			e.preventDefault();
		};
		containerRef.current.addEventListener("touchstart", onTouchStart, { passive: true });
		containerRef.current.addEventListener("touchmove", onTouchMove, { passive: false });

		connectWs(credentials, terminalId, inst);
	}, [terminalId, credentials]);

	// Re-fit when pane becomes visible — display:none blocks ResizeObserver
	useEffect(() => {
		if (!visible) return;
		const inst = instances.get(terminalId);
		if (!inst) return;
		const id = requestAnimationFrame(() => {
			if (inst.ws) fitAndResize(inst.fit, inst.ws, inst.term);
		});
		return () => cancelAnimationFrame(id);
	}, [visible, terminalId]);

	// Tap the terminal to focus xterm's hidden textarea → shows mobile keyboard
	const handleClick = useCallback(() => {
		const inst = instances.get(terminalId);
		if (!inst) return;
		inst.term.focus();
		inst.term.textarea?.focus();
	}, [terminalId]);

	return (
		<div
			data-testid="terminal-pane"
			data-terminal-id={terminalId}
			ref={containerRef}
			onClick={handleClick}
			style={{
				position: "absolute", inset: 0,
				background: "#0d0f14",
				display: visible ? "block" : "none",
				padding: 6,
				cursor: "text",
			}}
		/>
	);
}

export function destroyTerminal(terminalId: string) {
	const inst = instances.get(terminalId);
	if (!inst) return;
	inst.destroyed = true;
	inst.ws?.close(1000, "destroyed");
	inst.term.dispose();
	instances.delete(terminalId);
}

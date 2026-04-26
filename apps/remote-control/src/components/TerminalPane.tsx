import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { Credentials } from "../lib/types";

interface Props {
	terminalId: string;
	credentials: Credentials;
	visible: boolean;
}

// Keep terminal instances alive across re-renders and tab switches
const instances = new Map<
	string,
	{ term: Terminal; fit: FitAddon; ws: WebSocket }
>();

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
		fit.fit(); // synchronous — layout is computed at this point

		const ws = new WebSocket(buildWsUrl(credentials, terminalId));

		ws.onopen = () => {
			// Send correct PTY dimensions immediately so server uses them for replay
			fitAndResize(fit, ws, term);

			// Retry after 300ms — catches cases where layout wasn't fully settled
			// on mobile (terminal panel transitioning from display:none → flex)
			setTimeout(() => {
				if (ws.readyState !== WebSocket.OPEN) return;
				const prevCols = term.cols;
				const prevRows = term.rows;
				fit.fit();
				if (term.cols !== prevCols || term.rows !== prevRows) {
					ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
				}
			}, 300);
		};

		ws.onmessage = (ev) => {
			try {
				const msg = JSON.parse(ev.data as string);
				if (msg.type === "data" || msg.type === "replay") {
					term.write(msg.data);
				} else if (msg.type === "exit") {
					term.writeln(`\r\n[Process exited with code ${msg.exitCode}]`);
				} else if (msg.type === "error") {
					term.writeln(`\r\n[Error: ${msg.message}]`);
				}
			} catch {
				term.write(ev.data as string);
			}
		};

		ws.onerror = () => term.writeln("\r\n[WebSocket error]");
		ws.onclose = () => term.writeln("\r\n[Connection closed]");

		term.onData((data) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "input", data }));
			}
		});

		const resizeObserver = new ResizeObserver(() => {
			fitAndResize(fit, ws, term);
		});
		resizeObserver.observe(containerRef.current);

		// Touch scroll: translate swipe gestures into xterm scroll calls.
		// xterm renders to canvas so native touch scroll doesn't work.
		let touchStartY = 0;
		let touchLastY = 0;
		const onTouchStart = (e: TouchEvent) => {
			touchStartY = e.touches[0].clientY;
			touchLastY = touchStartY;
		};
		const onTouchMove = (e: TouchEvent) => {
			const y = e.touches[0].clientY;
			const delta = touchLastY - y;
			touchLastY = y;
			// ~17px per line (fontSize 13 * ~1.3 line-height)
			const lines = delta / 17;
			if (Math.abs(lines) >= 0.5) {
				term.scrollLines(Math.round(lines));
			}
			e.preventDefault();
		};
		containerRef.current.addEventListener("touchstart", onTouchStart, { passive: true });
		containerRef.current.addEventListener("touchmove", onTouchMove, { passive: false });

		instances.set(terminalId, { term, fit, ws });
	}, [terminalId, credentials]);

	// Re-fit when pane becomes visible — display:none blocks ResizeObserver
	useEffect(() => {
		if (!visible) return;
		const inst = instances.get(terminalId);
		if (!inst) return;
		const id = requestAnimationFrame(() => {
			fitAndResize(inst.fit, inst.ws, inst.term);
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
	inst.ws.close();
	inst.term.dispose();
	instances.delete(terminalId);
}

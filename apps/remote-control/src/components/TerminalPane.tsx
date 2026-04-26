import { useEffect, useRef } from "react";
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
	// Keep the full terminalId including "v1:" prefix — the host-service WebSocket
	// handler routes on that prefix to reach the V1 terminal-host bridge.
	const encodedId = encodeURIComponent(terminalId);
	return `ws://${credentials.ip}:${credentials.port}/terminal/${encodedId}?token=${credentials.secret}`;
}

export function TerminalPane({ terminalId, credentials, visible }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!containerRef.current) return;

		if (!instances.has(terminalId)) {
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

			const wsUrl = buildWsUrl(credentials, terminalId);
			const ws = new WebSocket(wsUrl);

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
					// raw text fallback
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
				fit.fit();
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(
						JSON.stringify({
							type: "resize",
							cols: term.cols,
							rows: term.rows,
						}),
					);
				}
			});
			resizeObserver.observe(containerRef.current);

			instances.set(terminalId, { term, fit, ws });
		} else {
			// Terminal already exists — move its DOM element into this container
			const { term } = instances.get(terminalId)!;
			const el = term.element?.parentElement;
			if (el && el !== containerRef.current) {
				containerRef.current.appendChild(el);
			}
		}
	}, [terminalId, credentials]);

	// Re-fit whenever this pane becomes visible — display:none prevents ResizeObserver
	// from firing, so the terminal dimensions are stale until we force a fit+resize.
	useEffect(() => {
		if (!visible) return;
		const inst = instances.get(terminalId);
		if (!inst) return;
		// Use rAF so the DOM has fully painted with display:flex before measuring
		const id = requestAnimationFrame(() => {
			inst.fit.fit();
			if (inst.ws.readyState === WebSocket.OPEN) {
				inst.ws.send(JSON.stringify({ type: "resize", cols: inst.term.cols, rows: inst.term.rows }));
			}
		});
		return () => cancelAnimationFrame(id);
	}, [visible, terminalId]);

	// Absolute fill so xterm gets a concrete pixel box; the parent must be position:relative.
	return (
		<div
			data-testid="terminal-pane"
			data-terminal-id={terminalId}
			ref={containerRef}
			style={{
				position: "absolute", inset: 0,
				background: "#0d0f14",
				display: visible ? "block" : "none",
				padding: 6,
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

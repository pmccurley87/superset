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

	ws.onerror = (ev) => {
		console.error("[terminal] ws error", ev);
	};

	ws.onclose = (ev) => {
		console.log(`[terminal] ws closed terminalId=${terminalId} code=${ev.code} reason="${ev.reason}" wasClean=${ev.wasClean} destroyed=${inst.destroyed}`);
		if (inst.destroyed) return;
		// Always reconnect unless we explicitly destroyed this instance
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

		// Native-scroll proxy: a transparent overflow-y:scroll div sits on top of xterm's
		// canvas. The browser drives it with full native momentum/rubber-band physics.
		// We sync its scrollTop → .xterm-viewport so xterm re-renders the canvas to match.
		const xtermVp = term.element!.querySelector(".xterm-viewport") as HTMLElement;
		const scrollArea = xtermVp.querySelector(".xterm-scroll-area") as HTMLElement;

		const proxy = document.createElement("div");
		proxy.dataset.scrollProxy = "";
		proxy.style.cssText = "position:absolute;inset:0;z-index:10;overflow-y:scroll;overscroll-behavior:none;scrollbar-width:none;";
		const proxyInner = document.createElement("div");
		proxy.appendChild(proxyInner);
		containerRef.current.appendChild(proxy);

		// syncFromXterm: called when xterm's content height changes (new output).
		// Updates proxy inner height then syncs proxy position to wherever xterm scrolled.
		// Uses a short cooldown so the resulting proxy "scroll" event is ignored.
		let syncCooldown: ReturnType<typeof setTimeout> | null = null;
		let syncing = false;

		const syncFromXterm = () => {
			proxyInner.style.height = `${xtermVp.scrollHeight}px`;
			syncing = true;
			proxy.scrollTop = xtermVp.scrollTop;
			if (syncCooldown) clearTimeout(syncCooldown);
			syncCooldown = setTimeout(() => { syncing = false; }, 50);
		};
		syncFromXterm();

		// Watch xterm-scroll-area resize — fires after DOM is updated (unlike scroll events)
		const contentObserver = new ResizeObserver(syncFromXterm);
		contentObserver.observe(scrollArea);

		// Native scroll on proxy → drive xterm viewport
		proxy.addEventListener("scroll", () => {
			if (syncing) return;
			xtermVp.scrollTop = proxy.scrollTop;
		}, { passive: true });

		// Tap on proxy (minimal movement) → focus xterm so keyboard appears
		let tapStartY = 0;
		let isTap = false;
		proxy.addEventListener("touchstart", (e) => {
			tapStartY = e.touches[0]?.clientY ?? 0;
			isTap = true;
		}, { passive: true });
		proxy.addEventListener("touchmove", (e) => {
			if (Math.abs((e.touches[0]?.clientY ?? tapStartY) - tapStartY) > 8) isTap = false;
		}, { passive: true });
		proxy.addEventListener("touchend", () => {
			if (isTap) { term.focus(); term.textarea?.focus(); }
		}, { passive: true });

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

export function sendTerminalInput(terminalId: string, data: string) {
	const inst = instances.get(terminalId);
	if (!inst) return;
	if (inst.ws?.readyState === WebSocket.OPEN) {
		inst.ws.send(JSON.stringify({ type: "input", data }));
	}
}

export function destroyTerminal(terminalId: string) {
	const inst = instances.get(terminalId);
	if (!inst) return;
	inst.destroyed = true;
	inst.ws?.close(4000, "destroyed");
	inst.term.dispose();
	instances.delete(terminalId);
}

import { useState, useCallback, useEffect } from "react";
import { ConfigBar } from "./ConfigBar";
import { Sidebar } from "./Sidebar";
import { TerminalTabs } from "./TerminalTabs";
import { TerminalPane, destroyTerminal, sendTerminalInput } from "./TerminalPane";
import { trpc, trpcPost } from "../lib/trpc";
import type { Credentials, Project, Workspace, Session } from "../lib/types";

const STORAGE_KEY = "rc:credentials";

function loadCredentials(): Credentials {
	const params = new URLSearchParams(window.location.search);
	const fromUrl: Partial<Credentials> = {
		ip: params.get("rc_host") ?? undefined,
		port: params.get("rc_port") ?? undefined,
		secret: params.get("rc_secret") ?? undefined,
	};
	if (fromUrl.ip && fromUrl.port && fromUrl.secret) {
		const c = { ip: fromUrl.ip, port: fromUrl.port, secret: fromUrl.secret };
		saveCredentials(c);
		window.history.replaceState({}, "", window.location.pathname);
		return c;
	}
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) return JSON.parse(raw) as Credentials;
	} catch {
		// ignore
	}
	return { ip: "", port: "44037", secret: "" };
}

function saveCredentials(c: Credentials) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
}

function baseUrl(c: Credentials) {
	return `http://${c.ip}:${c.port}`;
}

function useIsMobile(breakpoint = 768) {
	const [v, setV] = useState(() => window.innerWidth < breakpoint);
	useEffect(() => {
		const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
		const h = (e: MediaQueryListEvent) => setV(e.matches);
		mq.addEventListener("change", h);
		return () => mq.removeEventListener("change", h);
	}, [breakpoint]);
	return v;
}

function useVisualViewport() {
	const [vpHeight, setVpHeight] = useState(() => window.visualViewport?.height ?? window.innerHeight);
	useEffect(() => {
		const vp = window.visualViewport;
		if (!vp) return;
		const update = () => setVpHeight(vp.height);
		vp.addEventListener("resize", update);
		vp.addEventListener("scroll", update);
		return () => {
			vp.removeEventListener("resize", update);
			vp.removeEventListener("scroll", update);
		};
	}, []);
	return vpHeight;
}

export function App() {
	const isMobile = useIsMobile();
	const vpHeight = useVisualViewport();
	const keyboardHeight = Math.max(0, window.innerHeight - vpHeight);
	const keyboardVisible = keyboardHeight > 100;

	const [credentials, setCredentials] = useState<Credentials>(loadCredentials);
	const [status, setStatus] = useState("Connecting…");
	const [statusOk, setStatusOk] = useState<boolean | null>(null);

	const [projects, setProjects] = useState<Project[]>([]);
	const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
	const [sessions, setSessions] = useState<Session[]>([]);

	const [tabs, setTabs] = useState<Array<{ terminalId: string; label: string }>>([]);
	const [activeId, setActiveId] = useState<string | null>(null);

	const handleCredentialsChange = useCallback((c: Credentials) => {
		setCredentials(c);
		saveCredentials(c);
	}, []);

	const fetchData = useCallback(async (creds: Credentials) => {
		// Allow empty secret in proxy mode (server injects auth)
		if (!creds.ip) {
			setStatus("Enter host IP and secret");
			setStatusOk(false);
			return;
		}
		const base = baseUrl(creds);
		setStatus("Fetching…");
		try {
			const [wsData, termData] = await Promise.all([
				trpc<{ projects: Project[]; workspaces: Workspace[] }>(base, creds.secret, "workspace.listAll"),
				trpc<{ sessions: Session[] }>(base, creds.secret, "terminal.listAll"),
			]);
			setProjects(wsData.projects);
			setWorkspaces(wsData.workspaces);
			const ss = termData.sessions;
			setSessions(ss);
			setStatus(`${ss.length} session(s) — ${new Date().toLocaleTimeString()}`);
			setStatusOk(true);
		} catch (err) {
			setStatus(`Failed: ${(err as Error).message}`);
			setStatusOk(false);
		}
	}, []);

	const handleConnect = useCallback(() => { fetchData(credentials); }, [credentials, fetchData]);
	const handleRefresh = useCallback(() => { fetchData(credentials); }, [credentials, fetchData]);

	// Auto-detect proxy mode on mount, then auto-fetch
	useEffect(() => {
		fetch("/rc/config")
			.then((r) => r.json())
			.then((cfg: { proxyMode?: boolean }) => {
				if (cfg.proxyMode) {
					const c: Credentials = {
						ip: window.location.hostname,
						port: window.location.port || "5198",
						secret: "",
					};
					setCredentials(c);
					saveCredentials(c);
					fetchData(c);
				} else if (credentials.ip && credentials.secret) {
					fetchData(credentials);
				} else {
					setStatus("Enter host IP and secret");
					setStatusOk(false);
				}
			})
			.catch(() => {
				if (credentials.ip && credentials.secret) {
					fetchData(credentials);
				} else {
					setStatus("Not connected");
					setStatusOk(false);
				}
			});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const handleOpenSession = useCallback(
		(terminalId: string) => {
			if (!tabs.find((t) => t.terminalId === terminalId)) {
				const session = sessions.find((s) => s.terminalId === terminalId);
				const workspace = session?.workspaceId
					? workspaces.find((w) => w.id === session.workspaceId)
					: undefined;
				const wsName = workspace?.name ?? workspace?.branch ?? null;
				const label = wsName ?? (terminalId.startsWith("v1:") ? "desktop" : terminalId.slice(0, 8));
				setTabs((prev) => [...prev, { terminalId, label }]);
			}
			setActiveId(terminalId);
		},
		[tabs, sessions, workspaces],
	);

	const handleNewTerminal = useCallback(
		async (worktreePath: string) => {
			const base = baseUrl(credentials);
			setStatus("Creating terminal…");
			try {
				const result = await trpcPost<{ terminalId: string }>(
					base, credentials.secret, "terminal.open", { worktreePath },
				);
				await fetchData(credentials);
				handleOpenSession(result.terminalId);
			} catch (err) {
				setStatus(`Failed to create terminal: ${(err as Error).message}`);
				setStatusOk(false);
			}
		},
		[credentials, fetchData, handleOpenSession],
	);

	const handleCloseTab = useCallback((terminalId: string) => {
		destroyTerminal(terminalId);
		setTabs((prev) => prev.filter((t) => t.terminalId !== terminalId));
		setActiveId((prev) => {
			if (prev !== terminalId) return prev;
			const remaining = tabs.filter((t) => t.terminalId !== terminalId);
			return remaining.length ? (remaining[remaining.length - 1]?.terminalId ?? null) : null;
		});
	}, [tabs]);

	const handleBack = useCallback(() => setActiveId(null), []);

	// On mobile: show terminal view when a session is active
	const inTerminalView = isMobile && !!activeId;
	const activeTab = tabs.find((t) => t.terminalId === activeId);

	return (
		<div style={{
			display: "flex", flexDirection: "column",
			height: isMobile ? `${vpHeight}px` : "100dvh",
			overflow: "hidden",
			background: "var(--color-bg)",
			position: isMobile ? "fixed" : undefined,
			top: isMobile ? 0 : undefined,
			left: isMobile ? 0 : undefined,
			right: isMobile ? 0 : undefined,
		}}>

			{/* Header — switches to terminal bar on mobile when a session is open */}
			{inTerminalView ? (
				<MobileTerminalBar
					label={activeTab?.label ?? ""}
					onBack={handleBack}
					statusOk={statusOk}
				/>
			) : (
				<ConfigBar
					credentials={credentials}
					onChange={handleCredentialsChange}
					onConnect={handleConnect}
					onRefresh={handleRefresh}
					status={status}
					statusOk={statusOk}
				/>
			)}

			{/* Body */}
			<div style={{ flex: 1, display: "flex", minHeight: 0 }}>

				{/* Sessions panel: full-width on mobile sessions view, sidebar on desktop */}
				<div style={{
					width: isMobile ? "100%" : 232,
					flexShrink: 0,
					display: inTerminalView ? "none" : "flex",
					flexDirection: "column",
					borderRight: isMobile ? "none" : "1px solid var(--color-border)",
					overflowY: "auto",
					background: "var(--color-surface)",
				}}>
					<Sidebar
						projects={projects}
						workspaces={workspaces}
						sessions={sessions}
						activeTerminalId={activeId}
						onOpenSession={handleOpenSession}
						onNewTerminal={handleNewTerminal}
						isMobile={isMobile}
					/>
					{sessions.length === 0 && statusOk && (
						<div style={{
							flex: 1, display: "flex", flexDirection: "column",
							alignItems: "center", justifyContent: "center", gap: 6,
							color: "var(--color-text-dim)",
						}}>
							<span style={{ fontSize: 24, opacity: 0.3 }}>⬛</span>
							<span style={{ fontSize: 13 }}>No active sessions</span>
						</div>
					)}
				</div>

				{/* Terminal panel: hidden on mobile sessions view, full-screen on mobile terminal view */}
				<div style={{
					flex: 1,
					minWidth: 0,
					display: (!isMobile || inTerminalView) ? "flex" : "none",
					flexDirection: "column",
				}}>
					{!isMobile && (
						<TerminalTabs
							tabs={tabs}
							activeId={activeId}
							onSelect={setActiveId}
							onClose={handleCloseTab}
						/>
					)}

					{tabs.length === 0 && !isMobile ? (
						<div style={{
							flex: 1, display: "flex", flexDirection: "column",
							alignItems: "center", justifyContent: "center", gap: 8,
							color: "var(--color-text-dim)",
						}}>
							<span style={{ fontSize: 28, opacity: 0.3 }}>⬛</span>
							<span style={{ fontSize: 12 }}>Select a session to open a terminal</span>
						</div>
					) : (
						<div style={{ flex: 1, minHeight: 0, position: "relative" }}>
							{tabs.map((t) => (
								<TerminalPane
									key={t.terminalId}
									terminalId={t.terminalId}
									credentials={credentials}
									visible={t.terminalId === activeId}
								/>
							))}
						</div>
					)}
					{isMobile && inTerminalView && keyboardVisible && activeId && (
						<MobileControlBar terminalId={activeId} />
					)}
				</div>
			</div>
		</div>
	);
}

const CONTROL_KEYS = [
	{ label: "↑", data: "\x1b[A" },
	{ label: "↓", data: "\x1b[B" },
	{ label: "←", data: "\x1b[D" },
	{ label: "→", data: "\x1b[C" },
	{ label: "Esc", data: "\x1b" },
	{ label: "/", data: "/" },
] as const;

function MobileControlBar({ terminalId }: { terminalId: string }) {
	return (
		<div style={{
			flexShrink: 0,
			display: "flex", alignItems: "center",
			background: "var(--color-surface)",
			borderTop: "1px solid var(--color-border)",
			padding: "6px 8px",
			gap: 6,
		}}>
			{CONTROL_KEYS.map(({ label, data }) => (
				<button
					key={label}
					onPointerDown={(e) => {
						e.preventDefault(); // prevent keyboard dismiss
						sendTerminalInput(terminalId, data);
					}}
					style={{
						flex: label === "Esc" ? 1.5 : 1,
						height: 40,
						display: "flex", alignItems: "center", justifyContent: "center",
						borderRadius: 7,
						border: "1px solid var(--color-border)",
						background: "var(--color-surface-2, var(--color-surface))",
						color: "var(--color-text-muted)",
						fontSize: label === "Esc" ? 12 : 16,
						fontFamily: "inherit",
						cursor: "pointer",
						WebkitUserSelect: "none",
						userSelect: "none",
					}}
				>
					{label}
				</button>
			))}
		</div>
	);
}

function MobileTerminalBar({ label, onBack, statusOk }: {
	label: string;
	onBack: () => void;
	statusOk: boolean | null;
}) {
	const dotColor =
		statusOk === true ? "var(--color-green)" :
		statusOk === false ? "var(--color-red, #e06c75)" :
		"var(--color-text-dim)";

	return (
		<div style={{
			height: 52, flexShrink: 0,
			display: "flex", alignItems: "center",
			padding: "0 12px", gap: 10,
			background: "var(--color-surface)",
			borderBottom: "1px solid var(--color-border)",
		}}>
			<button
				onClick={onBack}
				style={{
					display: "flex", alignItems: "center", gap: 4,
					padding: "6px 12px", borderRadius: 7,
					border: "1px solid var(--color-border-subtle)",
					background: "transparent",
					color: "var(--color-text-muted)",
					fontSize: 13, cursor: "pointer", flexShrink: 0,
					fontFamily: "inherit",
				}}
			>
				← Sessions
			</button>
			<span style={{
				flex: 1, textAlign: "center",
				fontSize: 14, fontWeight: 500,
				color: "var(--color-text)",
				overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
			}}>
				{label}
			</span>
			<span style={{
				width: 8, height: 8, borderRadius: "50%",
				background: dotColor, flexShrink: 0,
			}} />
		</div>
	);
}

import { useState, useCallback, useEffect } from "react";
import { ConfigBar } from "./ConfigBar";
import { Sidebar } from "./Sidebar";
import { TerminalTabs } from "./TerminalTabs";
import { TerminalPane, destroyTerminal } from "./TerminalPane";
import { trpc, trpcPost } from "../lib/trpc";
import type { Credentials, Project, Workspace, Session } from "../lib/types";

const STORAGE_KEY = "rc:credentials";

function loadCredentials(): Credentials {
	// Query params from run.sh override stored credentials
	const params = new URLSearchParams(window.location.search);
	const fromUrl: Partial<Credentials> = {
		ip: params.get("rc_host") ?? undefined,
		port: params.get("rc_port") ?? undefined,
		secret: params.get("rc_secret") ?? undefined,
	};
	if (fromUrl.ip && fromUrl.port && fromUrl.secret) {
		const c = { ip: fromUrl.ip, port: fromUrl.port, secret: fromUrl.secret };
		saveCredentials(c);
		// Strip params from URL without reload
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

export function App() {
	const [credentials, setCredentials] = useState<Credentials>(loadCredentials);
	const [status, setStatus] = useState("Not connected");
	const [statusOk, setStatusOk] = useState<boolean | null>(null);

	const [projects, setProjects] = useState<Project[]>([]);
	const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
	const [sessions, setSessions] = useState<Session[]>([]);

	// Tabs: list of open terminal IDs
	const [tabs, setTabs] = useState<Array<{ terminalId: string; label: string }>>([]);
	const [activeId, setActiveId] = useState<string | null>(null);

	const handleCredentialsChange = useCallback((c: Credentials) => {
		setCredentials(c);
		saveCredentials(c);
	}, []);

	const fetchData = useCallback(
		async (creds: Credentials) => {
			if (!creds.ip || !creds.secret) {
				setStatus("Enter host IP and secret");
				setStatusOk(false);
				return;
			}
			const base = baseUrl(creds);
			setStatus("Fetching…");
			try {
				// workspace.listAll returns { projects, workspaces } from local.db
				// terminal.listAll returns { sessions: [...] }
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
				setStatus(`Failed to fetch! ${(err as Error).message}`);
				setStatusOk(false);
			}
		},
		[],
	);

	const handleConnect = useCallback(() => {
		fetchData(credentials);
	}, [credentials, fetchData]);

	const handleRefresh = useCallback(() => {
		fetchData(credentials);
	}, [credentials, fetchData]);

	// Auto-fetch on load if credentials look set
	useEffect(() => {
		if (credentials.ip && credentials.secret) {
			fetchData(credentials);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const handleOpenSession = useCallback(
		(terminalId: string) => {
			if (!tabs.find((t) => t.terminalId === terminalId)) {
				const session = sessions.find((s) => s.terminalId === terminalId);
				const workspace = session?.workspaceId
					? workspaces.find((w) => w.id === session.workspaceId)
					: undefined;
				// Use workspace name from Superset if available, fall back to cwd basename
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
					base,
					credentials.secret,
					"terminal.open",
					{ worktreePath },
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

	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", background: "var(--color-bg)" }}>
			<ConfigBar
				credentials={credentials}
				onChange={handleCredentialsChange}
				onConnect={handleConnect}
				onRefresh={handleRefresh}
				status={status}
				statusOk={statusOk}
			/>
			<div style={{ display: "flex", flex: 1, minHeight: 0 }}>
				<Sidebar
					projects={projects}
					workspaces={workspaces}
					sessions={sessions}
					activeTerminalId={activeId}
					onOpenSession={handleOpenSession}
					onNewTerminal={handleNewTerminal}
				/>
				<div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
					<TerminalTabs
						tabs={tabs}
						activeId={activeId}
						onSelect={setActiveId}
						onClose={handleCloseTab}
					/>
					{tabs.length === 0 ? (
						<div
							data-testid="empty-state"
							style={{
								flex: 1, display: "flex", flexDirection: "column",
								alignItems: "center", justifyContent: "center", gap: 8,
								color: "var(--color-text-dim)",
							}}
						>
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
				</div>
			</div>
		</div>
	);
}

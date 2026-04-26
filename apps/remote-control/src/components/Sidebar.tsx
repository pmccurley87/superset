import { useState } from "react";
import type { Project, Session, Workspace } from "../lib/types";

function timeAgo(ms: number): string {
	const s = Math.floor((Date.now() - ms) / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	return `${Math.floor(s / 3600)}h`;
}

interface Props {
	projects: Project[];
	workspaces: Workspace[];
	sessions: Session[];
	activeTerminalId: string | null;
	onOpenSession: (terminalId: string) => void;
	onNewTerminal: (worktreePath: string) => void;
}

export function Sidebar({ projects, workspaces, sessions, activeTerminalId, onOpenSession, onNewTerminal }: Props) {
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

	const byProject = new Map<string, Workspace[]>();
	for (const w of workspaces) {
		if (!byProject.has(w.projectId)) byProject.set(w.projectId, []);
		byProject.get(w.projectId)!.push(w);
	}

	const matchedIds = new Set<string>();

	const toggle = (id: string) =>
		setCollapsed(prev => {
			const next = new Set(prev);
			next.has(id) ? next.delete(id) : next.add(id);
			return next;
		});

	return (
		<aside
			data-testid="sidebar"
			style={{
				width: 232, flexShrink: 0, overflowY: "auto",
				borderRight: "1px solid var(--color-border)",
				background: "var(--color-surface)",
				display: "flex", flexDirection: "column",
			}}
		>
			{projects.map((p) => {
				const pWs = byProject.get(p.id) ?? [];
				if (!pWs.length) return null;

				const visibleWs = pWs.filter((w) => {
					const hasSessions = sessions.some(
						(s) =>
							(w.worktreePath && s.cwd && s.cwd === w.worktreePath) ||
							(s.workspaceId && s.workspaceId === w.id),
					);
					return hasSessions || w.worktreePath;
				});
				if (!visibleWs.length) return null;

				const isCollapsed = collapsed.has(p.id);

				return (
					<div key={p.id} style={{ borderBottom: "1px solid var(--color-border-subtle)" }}>
						{/* Project header — click to collapse */}
						<button
							onClick={() => toggle(p.id)}
							style={{
								display: "flex", alignItems: "center", gap: 7,
								padding: "9px 12px 7px", width: "100%",
								background: "transparent", border: "none", cursor: "pointer",
								textAlign: "left",
							}}
						>
							{/* Collapse chevron */}
							<span style={{
								fontSize: 9, color: "var(--color-text-dim)",
								transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
								transition: "transform 0.15s", flexShrink: 0, lineHeight: 1,
							}}>▾</span>
							<span style={{
								width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
								background: p.color ?? "var(--color-accent)",
							}} />
							<span style={{
								fontSize: 11, fontWeight: 600, letterSpacing: "0.05em",
								textTransform: "uppercase", color: "var(--color-text-muted)",
								flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
							}}>
								{p.name}
							</span>
							<span style={{ fontSize: 10, color: "var(--color-text-dim)", fontVariantNumeric: "tabular-nums" }}>
								{visibleWs.length}
							</span>
						</button>

						{/* Workspaces — hidden when collapsed */}
						{!isCollapsed && visibleWs.map((w) => {
							const wSessions = sessions.filter(
								(s) =>
									(w.worktreePath && s.cwd && s.cwd === w.worktreePath) ||
									(s.workspaceId && s.workspaceId === w.id),
							);
							wSessions.forEach((s) => matchedIds.add(s.terminalId));

							const label = w.name ?? w.branch ?? w.id.slice(0, 8);

							return (
								<div key={w.id} style={{ padding: "2px 12px 6px 26px" }}>
									<div style={{ marginBottom: 3 }}>
										<span style={{ fontSize: 11, color: "var(--color-text-muted)", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={label}>
											{label}
										</span>
										{w.branch && label !== w.branch && (
											<span style={{ fontSize: 10, color: "var(--color-text-dim)", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
												{w.branch}
											</span>
										)}
									</div>

									<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
										{wSessions.map((s) => {
											const isV1 = s.terminalId.startsWith("v1:");
											const isActive = s.terminalId === activeTerminalId;
											const isAttached = s.attached === true;
											return (
												<button
													key={s.terminalId}
													data-testid="session-btn"
													onClick={() => onOpenSession(s.terminalId)}
													style={{
														display: "flex", alignItems: "center", gap: 6,
														padding: "4px 8px", borderRadius: 5,
														border: `1px solid ${isActive ? "var(--color-accent)" : "var(--color-border-subtle)"}`,
														background: isActive ? "var(--color-accent-dim)" : "transparent",
														color: isActive ? "var(--color-accent-text)" : "var(--color-text-muted)",
														fontSize: 11, cursor: "pointer", textAlign: "left", width: "100%",
														transition: "all 0.1s",
													}}
													onMouseEnter={e => {
														if (!isActive) {
															(e.currentTarget as HTMLElement).style.background = "var(--color-surface-2)";
															(e.currentTarget as HTMLElement).style.borderColor = "var(--color-border)";
															(e.currentTarget as HTMLElement).style.color = "var(--color-text)";
														}
													}}
													onMouseLeave={e => {
														if (!isActive) {
															(e.currentTarget as HTMLElement).style.background = "transparent";
															(e.currentTarget as HTMLElement).style.borderColor = "var(--color-border-subtle)";
															(e.currentTarget as HTMLElement).style.color = "var(--color-text-muted)";
														}
													}}
												>
													{/* Activity dot */}
													<span style={{
														width: 5, height: 5, borderRadius: "50%", flexShrink: 0,
														background: s.exited
															? "var(--color-text-dim)"
															: isAttached
																? "var(--color-green)"
																: "var(--color-accent)",
														boxShadow: (!s.exited && isAttached) ? "0 0 4px var(--color-green)" : "none",
													}} />
													<span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
														{isV1 ? "desktop" : s.terminalId.slice(0, 8)}
													</span>
													<span style={{ fontSize: 9, color: "var(--color-text-dim)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
														{timeAgo(s.createdAt)}
													</span>
												</button>
											);
										})}

										{w.worktreePath && wSessions.length === 0 && (
											<button
												data-testid="new-term-btn"
												onClick={() => onNewTerminal(w.worktreePath!)}
												style={{
													display: "flex", alignItems: "center", gap: 5,
													padding: "3px 8px", borderRadius: 5,
													border: "1px dashed var(--color-border-subtle)",
													background: "transparent", color: "var(--color-text-dim)",
													fontSize: 11, cursor: "pointer", textAlign: "left", width: "100%",
													transition: "all 0.1s",
												}}
												onMouseEnter={e => {
													(e.currentTarget as HTMLElement).style.borderColor = "var(--color-accent)";
													(e.currentTarget as HTMLElement).style.color = "var(--color-accent-text)";
												}}
												onMouseLeave={e => {
													(e.currentTarget as HTMLElement).style.borderColor = "var(--color-border-subtle)";
													(e.currentTarget as HTMLElement).style.color = "var(--color-text-dim)";
												}}
											>
												<span style={{ fontSize: 12, lineHeight: 1 }}>+</span>
												New terminal
											</button>
										)}
									</div>
								</div>
							);
						})}
					</div>
				);
			})}

			{/* Orphan sessions */}
			{(() => {
				const orphans = sessions.filter((s) => !matchedIds.has(s.terminalId));
				if (!orphans.length) return null;
				return (
					<div style={{ borderBottom: "1px solid var(--color-border-subtle)" }}>
						<div style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 12px 7px" }}>
							<span style={{ fontSize: 9, color: "var(--color-text-dim)" }}>▾</span>
							<span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-text-dim)", flexShrink: 0 }} />
							<span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--color-text-muted)" }}>
								Other
							</span>
						</div>
						<div style={{ padding: "2px 12px 6px 26px", display: "flex", flexDirection: "column", gap: 2 }}>
							{orphans.map((s) => {
								const short = s.cwd ? s.cwd.split("/").slice(-2).join("/") : s.terminalId.slice(0, 12);
								const isActive = s.terminalId === activeTerminalId;
								return (
									<button
										key={s.terminalId}
										data-testid="session-btn"
										onClick={() => onOpenSession(s.terminalId)}
										style={{
											display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 5,
											border: `1px solid ${isActive ? "var(--color-accent)" : "var(--color-border-subtle)"}`,
											background: isActive ? "var(--color-accent-dim)" : "transparent",
											color: isActive ? "var(--color-accent-text)" : "var(--color-text-muted)",
											fontSize: 11, cursor: "pointer", textAlign: "left", width: "100%",
										}}
									>
										<span style={{ width: 5, height: 5, borderRadius: "50%", flexShrink: 0, background: s.exited ? "var(--color-text-dim)" : "var(--color-accent)" }} />
										<span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.cwd}>{short}</span>
										<span style={{ fontSize: 9, color: "var(--color-text-dim)", flexShrink: 0 }}>{timeAgo(s.createdAt)}</span>
									</button>
								);
							})}
						</div>
					</div>
				);
			})()}
		</aside>
	);
}

import { useState } from "react";
import type { Credentials } from "../lib/types";

interface Props {
	credentials: Credentials;
	onChange: (c: Credentials) => void;
	onConnect: () => void;
	onRefresh: () => void;
	status: string;
	statusOk: boolean | null;
}

export function ConfigBar({ credentials, onChange, onConnect, onRefresh, status, statusOk }: Props) {
	const [expanded, setExpanded] = useState(!credentials.ip);
	const set = (key: keyof Credentials) => (e: React.ChangeEvent<HTMLInputElement>) =>
		onChange({ ...credentials, [key]: e.target.value });

	const handleConnect = () => {
		onConnect();
		setExpanded(false);
	};

	const dot =
		statusOk === true ? "bg-[var(--color-green)]" :
		statusOk === false ? "bg-[var(--color-red)]" :
		"bg-[var(--color-text-dim)]";

	return (
		<header
			data-testid="config-bar"
			style={{ background: "var(--color-surface)", borderBottom: "1px solid var(--color-border)" }}
			className="shrink-0"
		>
			{/* Collapsed status strip */}
			<div className="flex items-center gap-3 px-4 h-11">
				{/* Wordmark */}
				<span style={{ color: "var(--color-text-muted)", fontSize: 11, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase" }}>
					Remote Control
				</span>

				<div style={{ width: 1, height: 16, background: "var(--color-border)" }} />

				{/* Connection address — click to edit */}
				<button
					onClick={() => setExpanded(v => !v)}
					style={{
						display: "flex", alignItems: "center", gap: 6,
						padding: "3px 8px", borderRadius: 5,
						border: "1px solid var(--color-border-subtle)",
						background: expanded ? "var(--color-surface-2)" : "transparent",
						color: credentials.ip ? "var(--color-text)" : "var(--color-text-dim)",
						fontSize: 12, fontFamily: "ui-monospace, monospace", cursor: "pointer",
						transition: "background 0.15s",
					}}
				>
					<span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
					{credentials.ip
						? `${credentials.ip}:${credentials.port}`
						: "not connected"}
				</button>

				{/* Status text */}
				<span data-testid="status" style={{ color: "var(--color-text-muted)", fontSize: 11, flex: 1 }}>
					{status}
				</span>

				{/* Refresh */}
				<button
					data-testid="btn-refresh"
					onClick={onRefresh}
					title="Refresh sessions"
					style={{
						width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center",
						borderRadius: 6, border: "1px solid transparent",
						color: "var(--color-text-muted)", cursor: "pointer", background: "transparent",
						fontSize: 14, transition: "all 0.15s",
					}}
					onMouseEnter={e => {
						(e.currentTarget as HTMLElement).style.background = "var(--color-surface-2)";
						(e.currentTarget as HTMLElement).style.borderColor = "var(--color-border)";
						(e.currentTarget as HTMLElement).style.color = "var(--color-text)";
					}}
					onMouseLeave={e => {
						(e.currentTarget as HTMLElement).style.background = "transparent";
						(e.currentTarget as HTMLElement).style.borderColor = "transparent";
						(e.currentTarget as HTMLElement).style.color = "var(--color-text-muted)";
					}}
				>
					↺
				</button>
			</div>

			{/* Expandable credentials form */}
			{expanded && (
				<div
					style={{ borderTop: "1px solid var(--color-border-subtle)", padding: "12px 16px", background: "var(--color-bg)" }}
					className="flex items-center gap-2 flex-wrap"
				>
					{[
						{ testid: "input-ip", key: "ip" as const, placeholder: "Host IP", width: 140, type: "text" },
						{ testid: "input-port", key: "port" as const, placeholder: "Port", width: 72, type: "text" },
						{ testid: "input-secret", key: "secret" as const, placeholder: "Secret / PSK", width: 260, type: "password" },
					].map(f => (
						<input
							key={f.key}
							data-testid={f.testid}
							type={f.type}
							placeholder={f.placeholder}
							value={credentials[f.key]}
							onChange={set(f.key)}
							onKeyDown={e => e.key === "Enter" && handleConnect()}
							style={{
								width: f.width, height: 30, padding: "0 10px",
								background: "var(--color-surface)",
								border: "1px solid var(--color-border)",
								borderRadius: 6, color: "var(--color-text)",
								fontSize: 12, fontFamily: f.key === "ip" || f.key === "port" ? "ui-monospace, monospace" : undefined,
								outline: "none",
							}}
						/>
					))}
					<button
						data-testid="btn-connect"
						onClick={handleConnect}
						style={{
							height: 30, padding: "0 14px", borderRadius: 6,
							background: "var(--color-accent)", border: "none",
							color: "#fff", fontSize: 12, fontWeight: 500, cursor: "pointer",
							transition: "opacity 0.15s",
						}}
						onMouseEnter={e => (e.currentTarget.style.opacity = "0.85")}
						onMouseLeave={e => (e.currentTarget.style.opacity = "1")}
					>
						Connect
					</button>
				</div>
			)}
		</header>
	);
}

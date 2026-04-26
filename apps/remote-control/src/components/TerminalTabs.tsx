interface Tab {
	terminalId: string;
	label: string;
}

interface Props {
	tabs: Tab[];
	activeId: string | null;
	onSelect: (id: string) => void;
	onClose: (id: string) => void;
}

export function TerminalTabs({ tabs, activeId, onSelect, onClose }: Props) {
	if (!tabs.length) return null;
	return (
		<div
			data-testid="terminal-tabs"
			style={{
				display: "flex", alignItems: "stretch", gap: 1,
				padding: "0 12px",
				background: "var(--color-surface)",
				borderBottom: "1px solid var(--color-border)",
				flexShrink: 0, overflowX: "auto", height: 36,
			}}
		>
			{tabs.map((t) => {
				const isActive = t.terminalId === activeId;
				return (
					<div
						key={t.terminalId}
						data-testid="tab"
						data-active={isActive ? "true" : undefined}
						style={{
							display: "flex", alignItems: "center", gap: 6,
							padding: "0 10px", cursor: "pointer", fontSize: 12, flexShrink: 0,
							color: isActive ? "var(--color-text)" : "var(--color-text-muted)",
							borderBottom: isActive ? "2px solid var(--color-accent)" : "2px solid transparent",
							marginBottom: -1,
							transition: "color 0.1s, border-color 0.1s",
							userSelect: "none",
						}}
						onClick={() => onSelect(t.terminalId)}
						onMouseEnter={e => {
							if (!isActive) (e.currentTarget as HTMLElement).style.color = "var(--color-text)";
						}}
						onMouseLeave={e => {
							if (!isActive) (e.currentTarget as HTMLElement).style.color = "var(--color-text-muted)";
						}}
					>
						<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>
							{t.label}
						</span>
						<button
							data-testid="tab-close"
							onClick={(e) => { e.stopPropagation(); onClose(t.terminalId); }}
							style={{
								width: 16, height: 16, borderRadius: 3, border: "none",
								background: "transparent", cursor: "pointer", padding: 0,
								display: "flex", alignItems: "center", justifyContent: "center",
								color: "var(--color-text-dim)", fontSize: 14, lineHeight: 1,
								transition: "color 0.1s, background 0.1s",
							}}
							onMouseEnter={e => {
								(e.currentTarget as HTMLElement).style.color = "var(--color-red)";
								(e.currentTarget as HTMLElement).style.background = "var(--color-surface-2)";
							}}
							onMouseLeave={e => {
								(e.currentTarget as HTMLElement).style.color = "var(--color-text-dim)";
								(e.currentTarget as HTMLElement).style.background = "transparent";
							}}
						>
							×
						</button>
					</div>
				);
			})}
		</div>
	);
}

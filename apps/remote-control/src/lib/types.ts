export interface Credentials {
	ip: string;
	port: string;
	secret: string;
}

export interface Project {
	id: string;
	name: string;
	color?: string;
}

export interface Workspace {
	id: string;
	projectId: string;
	name?: string;
	branch?: string;
	worktreePath?: string;
}

export interface Session {
	terminalId: string;
	workspaceId: string | null;
	cwd: string;
	createdAt: number;
	exited: boolean;
	attached?: boolean;
	source?: string;
}

export type InboundMessage =
	| { type: "data"; data: string }
	| { type: "replay"; data: string }
	| { type: "exit"; exitCode: number }
	| { type: "error"; message: string };

export type OutboundMessage =
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number };

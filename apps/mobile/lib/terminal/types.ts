export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "dispose" };

export type TerminalServerMessage =
  | { type: "data"; data: string }
  | { type: "error"; message: string }
  | { type: "exit"; exitCode: number; signal: number }
  | { type: "replay"; data: string };

export type ConnectionState = "disconnected" | "connecting" | "open" | "closed";

import { useQuery } from "@tanstack/react-query";
import SuperJSON from "superjson";
import { buildHostTrpcUrl, getHostConfig } from "@/lib/terminal/host";

interface TerminalSessionSummary {
  terminalId: string;
  workspaceId: string;
  createdAt: number;
  exited: boolean;
}

async function fetchSessions(workspaceId?: string): Promise<TerminalSessionSummary[]> {
  const { secret } = getHostConfig();
  const input = workspaceId ? { workspaceId } : {};
  const url = buildHostTrpcUrl("terminal.listSessions");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(SuperJSON.serialize(input)),
  });

  if (!res.ok) throw new Error(`Host-service error: ${res.status}`);

  const body = await res.json() as { result?: { data?: unknown } };
  if (!body.result?.data) throw new Error("Invalid host-service response");

  const result = SuperJSON.deserialize(body.result.data as never) as { sessions: TerminalSessionSummary[] };
  return result.sessions;
}

export function useTerminalSessions() {
  return useQuery({
    queryKey: ["terminalSessions"],
    queryFn: () => fetchSessions(),
    refetchInterval: 10_000,
  });
}

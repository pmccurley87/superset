import { useQuery } from "@tanstack/react-query";
import SuperJSON from "superjson";
import { authClient } from "@/lib/auth/client";
import { buildRelayTrpcUrl } from "@/lib/terminal/relay";

interface TerminalSessionSummary {
  terminalId: string;
  workspaceId: string;
  createdAt: number;
  exited: boolean;
}

async function fetchSessions(hostId: string, workspaceId?: string): Promise<TerminalSessionSummary[]> {
  const cookies = authClient.getCookie();
  const tokenRes = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/api/auth/token`, {
    headers: cookies ? { Cookie: cookies } : {},
  });
  if (!tokenRes.ok) throw new Error("Failed to get auth token");
  const { token: jwt } = await tokenRes.json() as { token: string };

  const input = workspaceId ? { workspaceId } : {};
  const url = buildRelayTrpcUrl(hostId, "terminal.listSessions");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(SuperJSON.serialize(input)),
  });

  if (!res.ok) throw new Error(`Relay error: ${res.status}`);

  const body = await res.json() as { result?: { data?: unknown } };
  if (!body.result?.data) throw new Error("Invalid relay response");

  const result = SuperJSON.deserialize(body.result.data as never) as { sessions: TerminalSessionSummary[] };
  return result.sessions;
}

export function useTerminalSessions(hostId: string | null) {
  return useQuery({
    queryKey: ["terminalSessions", hostId],
    queryFn: () => fetchSessions(hostId!),
    enabled: !!hostId,
    refetchInterval: 10_000,
  });
}

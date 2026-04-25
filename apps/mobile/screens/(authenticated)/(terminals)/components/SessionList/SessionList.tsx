import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { Card, CardContent } from "@/components/ui/card";

interface TerminalSession {
  terminalId: string;
  workspaceId: string;
  createdAt: number;
  exited: boolean;
}

interface SessionListProps {
  sessions: TerminalSession[];
  onSelectSession: (session: TerminalSession) => void;
  onBack: () => void;
  hostName: string;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function SessionList({ sessions, onSelectSession, onBack, hostName }: SessionListProps) {
  const activeSessions = sessions.filter((s) => !s.exited);
  const exitedSessions = sessions.filter((s) => s.exited);

  return (
    <View className="gap-3">
      <Pressable onPress={onBack}>
        <Text className="text-sm text-primary">&larr; Back to hosts</Text>
      </Pressable>
      <Text className="text-lg font-bold text-foreground">{hostName}</Text>

      {activeSessions.length === 0 && exitedSessions.length === 0 && (
        <View className="items-center justify-center py-20">
          <Text className="text-center text-muted-foreground">
            No terminal sessions running on this host.
          </Text>
        </View>
      )}

      {activeSessions.length > 0 && (
        <>
          <Text className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Active Sessions
          </Text>
          {activeSessions.map((session) => (
            <Pressable key={session.terminalId} onPress={() => onSelectSession(session)}>
              <Card>
                <CardContent className="flex-row items-center justify-between py-3 px-4">
                  <View className="flex-row items-center gap-3">
                    <View className="h-2.5 w-2.5 rounded-full bg-green-500" />
                    <View>
                      <Text className="font-mono text-sm text-foreground">
                        {session.terminalId.slice(0, 8)}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        Started {formatTime(session.createdAt)}
                      </Text>
                    </View>
                  </View>
                  <Text className="text-xs text-primary">Attach</Text>
                </CardContent>
              </Card>
            </Pressable>
          ))}
        </>
      )}

      {exitedSessions.length > 0 && (
        <>
          <Text className="text-sm font-medium text-muted-foreground uppercase tracking-wide mt-4">
            Exited
          </Text>
          {exitedSessions.map((session) => (
            <Card key={session.terminalId} className="opacity-50">
              <CardContent className="flex-row items-center gap-3 py-3 px-4">
                <View className="h-2.5 w-2.5 rounded-full bg-muted-foreground" />
                <View>
                  <Text className="font-mono text-sm text-foreground">
                    {session.terminalId.slice(0, 8)}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    Started {formatTime(session.createdAt)}
                  </Text>
                </View>
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </View>
  );
}

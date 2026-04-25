import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { Text } from "@/components/ui/text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HostList } from "./components/HostList";
import { SessionList } from "./components/SessionList";
import { useHosts } from "./hooks/useHosts";
import { useTerminalSessions } from "./hooks/useTerminalSessions";

interface Host {
  id: string;
  name: string;
  machineId: string;
  isOnline: boolean;
}

export function TerminalsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [selectedHost, setSelectedHost] = useState<Host | null>(null);
  const { data: hostsData, isLoading: hostsLoading, refetch: refetchHosts } = useHosts();
  const { data: sessions, isLoading: sessionsLoading, refetch: refetchSessions } = useTerminalSessions(
    selectedHost?.id ?? null,
  );

  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (selectedHost) {
      await refetchSessions();
    } else {
      await refetchHosts();
    }
    setRefreshing(false);
  }, [selectedHost, refetchHosts, refetchSessions]);

  const handleSelectSession = useCallback(
    (session: { terminalId: string }) => {
      if (!selectedHost) return;
      router.push({
        pathname: "/(authenticated)/(terminals)/terminal/[sessionId]",
        params: {
          sessionId: session.terminalId,
          hostId: selectedHost.id,
          hostName: selectedHost.name,
        },
      });
    },
    [selectedHost, router],
  );

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: 120 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View className="px-6 gap-4">
        <Text className="text-2xl font-bold text-foreground">Terminals</Text>

        {!selectedHost ? (
          hostsLoading ? (
            <Text className="text-muted-foreground">Loading hosts...</Text>
          ) : (
            <HostList
              hosts={hostsData?.hosts ?? []}
              onSelectHost={setSelectedHost}
            />
          )
        ) : (
          sessionsLoading ? (
            <Text className="text-muted-foreground">Loading sessions...</Text>
          ) : (
            <SessionList
              sessions={sessions ?? []}
              onSelectSession={handleSelectSession}
              onBack={() => setSelectedHost(null)}
              hostName={selectedHost.name}
            />
          )
        )}
      </View>
    </ScrollView>
  );
}

import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { Text } from "@/components/ui/text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isHostConfigured } from "@/lib/terminal/host";
import { SessionList } from "./components/SessionList";
import { useTerminalSessions } from "./hooks/useTerminalSessions";

export function TerminalsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const configured = isHostConfigured();
  const { data: sessions, isLoading, refetch } = useTerminalSessions();

  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const handleSelectSession = useCallback(
    (session: { terminalId: string }) => {
      router.push({
        pathname: "/(authenticated)/(terminals)/terminal/[sessionId]",
        params: { sessionId: session.terminalId },
      });
    },
    [router],
  );

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: 120 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View className="px-6 gap-4">
        <Text className="text-2xl font-bold text-foreground">Terminals</Text>

        {!configured ? (
          <View className="items-center justify-center py-20 gap-3">
            <Text className="text-center text-muted-foreground">
              Not connected to a host.
            </Text>
            <Text className="text-center text-sm text-muted-foreground">
              Set EXPO_PUBLIC_HOST_IP, EXPO_PUBLIC_HOST_PORT, and
              EXPO_PUBLIC_HOST_SECRET to your desktop's Tailscale IP, host-service
              port, and PSK.
            </Text>
          </View>
        ) : isLoading ? (
          <Text className="text-muted-foreground">Loading sessions...</Text>
        ) : (
          <SessionList
            sessions={sessions ?? []}
            onSelectSession={handleSelectSession}
            onBack={() => {}}
            hostName="Desktop"
          />
        )}
      </View>
    </ScrollView>
  );
}

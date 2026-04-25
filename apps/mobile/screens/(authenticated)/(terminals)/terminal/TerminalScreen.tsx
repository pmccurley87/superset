import { useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeft } from "lucide-react-native";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { buildTerminalWsUrl } from "@/lib/terminal/host";
import type { ConnectionState } from "@/lib/terminal/types";
import { TerminalWebView } from "../components/TerminalWebView";
import { ConnectionStatusBar } from "../components/ConnectionStatusBar";

export function TerminalScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");

  const wsUrl = useMemo(() => {
    if (!sessionId) return null;
    return buildTerminalWsUrl(sessionId);
  }, [sessionId]);

  const handleExit = useCallback((_exitCode: number, _signal: number) => {
    // Terminal exited — could show a "session ended" overlay
  }, []);

  return (
    <View className="flex-1 bg-[#1a1a2e]" style={{ paddingTop: insets.top }}>
      {/* Header */}
      <View className="flex-row items-center px-3 py-2 bg-[#1a1a2e]">
        <Pressable onPress={() => router.back()} className="p-2 mr-2">
          <Icon as={ChevronLeft} className="text-white size-5" />
        </Pressable>
        <Text className="text-white font-medium flex-1" numberOfLines={1}>
          Terminal — {sessionId?.slice(0, 8)}
        </Text>
      </View>

      {/* Connection status */}
      <ConnectionStatusBar state={connectionState} />

      {/* Terminal */}
      <TerminalWebView
        wsUrl={wsUrl}
        onConnectionStateChange={setConnectionState}
        onExit={handleExit}
      />
    </View>
  );
}

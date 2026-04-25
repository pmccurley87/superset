import { useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeft } from "lucide-react-native";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { authClient } from "@/lib/auth/client";
import { buildTerminalWsUrl } from "@/lib/terminal/relay";
import type { ConnectionState } from "@/lib/terminal/types";
import { TerminalWebView } from "../components/TerminalWebView";
import { ConnectionStatusBar } from "../components/ConnectionStatusBar";

export function TerminalScreen() {
  const { sessionId, hostId, hostName } = useLocalSearchParams<{
    sessionId: string;
    hostId: string;
    hostName: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");

  // Build WebSocket URL with auth token
  // Note: In production, this should fetch a JWT from the API's token endpoint.
  // For now, use the session cookie to get a token.
  const wsUrl = useMemo(() => {
    if (!hostId || !sessionId) return null;
    const cookies = authClient.getCookie();
    if (!cookies) return null;
    // The relay accepts the session token directly for WebSocket auth
    return buildTerminalWsUrl(hostId, sessionId, cookies);
  }, [hostId, sessionId]);

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
          {hostName ?? "Terminal"} — {sessionId?.slice(0, 8)}
        </Text>
      </View>

      {/* Connection status */}
      <ConnectionStatusBar state={connectionState} hostName={hostName} />

      {/* Terminal */}
      <TerminalWebView
        wsUrl={wsUrl}
        onConnectionStateChange={setConnectionState}
        onExit={handleExit}
      />
    </View>
  );
}

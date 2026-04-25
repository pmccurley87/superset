import { View } from "react-native";
import { Text } from "@/components/ui/text";
import type { ConnectionState } from "@/lib/terminal/types";

interface ConnectionStatusBarProps {
  state: ConnectionState;
  hostName?: string;
}

const STATE_CONFIG: Record<ConnectionState, { label: string; color: string }> = {
  disconnected: { label: "Disconnected", color: "bg-muted" },
  connecting: { label: "Connecting...", color: "bg-yellow-600" },
  open: { label: "Connected", color: "bg-green-600" },
  closed: { label: "Reconnecting...", color: "bg-yellow-600" },
};

export function ConnectionStatusBar({ state, hostName }: ConnectionStatusBarProps) {
  const config = STATE_CONFIG[state];
  return (
    <View className={`flex-row items-center px-3 py-1.5 ${config.color}`}>
      <View className="h-2 w-2 rounded-full bg-white mr-2" />
      <Text className="text-xs text-white font-medium">
        {config.label}
        {hostName ? ` — ${hostName}` : ""}
      </Text>
    </View>
  );
}

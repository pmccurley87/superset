import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { Card, CardContent } from "@/components/ui/card";

interface Host {
  id: string;
  name: string;
  machineId: string;
  isOnline: boolean;
}

interface HostListProps {
  hosts: Host[];
  onSelectHost: (host: Host) => void;
}

export function HostList({ hosts, onSelectHost }: HostListProps) {
  if (hosts.length === 0) {
    return (
      <View className="items-center justify-center py-20">
        <Text className="text-center text-muted-foreground">
          No hosts found. Start Superset on your desktop to see it here.
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-3">
      <Text className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
        Your Machines
      </Text>
      {hosts.map((host) => (
        <Pressable
          key={host.id}
          onPress={() => host.isOnline && onSelectHost(host)}
          disabled={!host.isOnline}
        >
          <Card className={host.isOnline ? "" : "opacity-50"}>
            <CardContent className="flex-row items-center justify-between py-3 px-4">
              <View className="flex-row items-center gap-3">
                <View
                  className={`h-2.5 w-2.5 rounded-full ${host.isOnline ? "bg-green-500" : "bg-muted-foreground"}`}
                />
                <View>
                  <Text className="font-medium text-foreground">{host.name}</Text>
                  <Text className="text-xs text-muted-foreground">{host.machineId}</Text>
                </View>
              </View>
              <Text className="text-xs text-muted-foreground">
                {host.isOnline ? "Online" : "Offline"}
              </Text>
            </CardContent>
          </Card>
        </Pressable>
      ))}
    </View>
  );
}

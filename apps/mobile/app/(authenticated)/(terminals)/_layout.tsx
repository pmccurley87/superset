import { Stack } from "expo-router";

export default function TerminalsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="terminal/[sessionId]" />
    </Stack>
  );
}

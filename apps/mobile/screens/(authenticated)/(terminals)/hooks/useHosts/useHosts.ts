import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/trpc/client";

export function useHosts() {
  return useQuery({
    queryKey: ["hosts"],
    queryFn: () => apiClient.device.listHosts.query(),
    refetchInterval: 15_000,
  });
}

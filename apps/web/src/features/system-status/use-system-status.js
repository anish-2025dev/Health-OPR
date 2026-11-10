import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export function useSystemStatus() {
  return useQuery({
    queryKey: ['system', 'readiness'],
    queryFn: ({ signal }) => apiFetch('/health/ready', { signal }),
    refetchInterval: 15_000,
    retry: false,
  });
}

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export const CATEGORY = {
  payroll: ['Payroll', 'brand'],
  performance: ['Performance', 'green'],
  leave: ['Leave', 'amber'],
  attendance: ['Attendance', 'amber'],
  general: ['General', 'slate'],
};
export const when = (iso) =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Unread count for the navigation badge. */
export function useUnreadMessages(enabled) {
  const q = useQuery({
    queryKey: ['my-messages'],
    queryFn: () => apiFetch('/me/messages'),
    enabled,
    refetchInterval: 60_000,
  });
  return q.data?.unread ?? 0;
}

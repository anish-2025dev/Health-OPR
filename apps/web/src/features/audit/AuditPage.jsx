import { useInfiniteQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { useAuth } from '@/features/auth/auth-context';
import { Button, Card, ErrorMessage, PageHeader, Spinner } from '@/components/ui';

const ACTION_LABELS = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.login_failed': 'Failed sign-in',
  'auth.account_locked': 'Account locked',
  'auth.password_changed': 'Changed password',
  'auth.refresh_reuse_detected': 'Session token reuse detected',
  'organization.created': 'Organization created',
  'organization.updated': 'Organization updated',
  'branch.created': 'Branch created',
  'branch.updated': 'Branch updated',
  'user.created': 'User created',
  'user.updated': 'User updated',
  'user.disabled': 'User disabled',
  'user.roles_changed': 'Roles changed',
  'user.password_reset': 'Password reset by admin',
};

export function AuditPage() {
  const auth = useAuth();
  const query = useInfiniteQuery({
    queryKey: ['audit-logs'],
    queryFn: ({ pageParam }) =>
      apiFetch(
        `/audit-logs?limit=50${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextBefore,
  });
  const rows = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Security events and administrative changes. Entries cannot be edited or deleted."
      />
      <Card>
        {query.isPending && <Spinner />}
        <ErrorMessage error={query.error} />
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4">When</th>
                  <th className="py-2 pr-4">Who</th>
                  <th className="py-2 pr-4">What</th>
                  <th className="py-2 pr-4">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="py-2 pr-4 whitespace-nowrap text-slate-600">
                      {formatDateTime(e.createdAt, auth.me.organization.timezone)}
                    </td>
                    <td className="py-2 pr-4">{e.actorName ?? 'System'}</td>
                    <td className="py-2 pr-4">
                      {ACTION_LABELS[e.action] ?? e.action}
                      {e.entityType && (
                        <span className="text-xs text-slate-400"> · {e.entityType}</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-slate-600">{e.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {query.hasNextPage && (
          <div className="mt-4">
            <Button
              variant="secondary"
              disabled={query.isFetchingNextPage}
              onClick={() => query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { useAuth } from '../../hooks/useAuth';
import { getAdminAuthorizationRefundIssues } from '../../services/paymentsService';

const formatDate = (value) => {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString();
};

export const AdminPaymentsPage = () => {
  const { profile, logout } = useAuth();
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadIssues = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await getAdminAuthorizationRefundIssues();
      setIssues(result.issues || []);
    } catch (loadError) {
      setError(loadError.message || 'Could not load authorization refund records.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadIssues();
  }, [loadIssues]);

  return (
    <AppShell title="Payments" subtitle="Subscription payment status and temporary authorization refunds." role="admin" user={profile} onLogout={logout}>
      <div className="space-y-5">
        <section className="panel space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-slate-950">Authorization refund reconciliation</h2>
              <p className="mt-1 text-sm text-slate-600">R1 card-authorization payments whose automatic refund needs review.</p>
            </div>
            <button type="button" className="btn-secondary" onClick={loadIssues} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
          {loading && <p className="text-sm text-slate-600">Loading refund records…</p>}
          {!loading && !error && issues.length === 0 && (
            <p className="rounded-xl bg-lime-50 p-3 text-sm text-slate-700">No authorization refunds need review.</p>
          )}
          {issues.length > 0 && (
            <div className="space-y-3">
              {issues.map((issue) => (
                <article key={issue.reference} className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-slate-800">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold">{issue.email || issue.studentId || 'Unknown account'}</p>
                      <p className="mt-1 break-all text-xs text-slate-600">Payment reference: {issue.reference}</p>
                    </div>
                    <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-900">
                      {issue.refundStatus.replaceAll('-', ' ')}
                    </span>
                  </div>
                  <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                    <div><dt className="text-slate-500">Temporary charge</dt><dd className="font-medium">R{Number(issue.amount).toFixed(2)}</dd></div>
                    <div><dt className="text-slate-500">Refund attempts</dt><dd className="font-medium">{issue.attempts}</dd></div>
                    <div><dt className="text-slate-500">Last updated</dt><dd className="font-medium">{formatDate(issue.updatedAt)}</dd></div>
                  </dl>
                  {issue.error && <p className="mt-3 break-words text-xs text-red-800">{issue.error}</p>}
                  <p className="mt-3 text-xs text-slate-600">Check the matching transaction and refund in Paystack before initiating any manual refund.</p>
                </article>
              ))}
            </div>
          )}
        </section>
        <div className="panel p-5 text-sm text-slate-600">Payment amounts are calculated and verified server-side. Paystack authorization details remain server-only.</div>
      </div>
    </AppShell>
  );
};

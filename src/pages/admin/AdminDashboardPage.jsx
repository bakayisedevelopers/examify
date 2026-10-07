import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { StatCard } from '../../components/common/StatCard';
import { SectionHeader } from '../../components/common/SectionHeader';
import { LoadingState } from '../../components/common/LoadingState';
import { useAuth } from '../../hooks/useAuth';
import { useScreenLoadMetrics } from '../../hooks/useScreenLoadMetrics';
import { getRecentExerciseGenerationWarningsForAdmin, getRoleDashboardData } from '../../services/firestoreService';

export const AdminDashboardPage = () => {
  const { profile, logout } = useAuth();
  const [dashboard, setDashboard] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [generationWarnings, setGenerationWarnings] = useState([]);
  const [warningsLoading, setWarningsLoading] = useState(true);

  useScreenLoadMetrics('Admin dashboard', 'admin', Boolean(dashboard || loadError));

  useEffect(() => {
    getRoleDashboardData('admin').then(setDashboard).catch((error) => {
      console.error('[Examifying][AdminDashboard] load:error', error);
      setLoadError(error.message || 'Could not load admin dashboard data.');
    });
    getRecentExerciseGenerationWarningsForAdmin().then(setGenerationWarnings).catch((error) => {
      console.error('[Examifying][AdminDashboard] generation warnings load:error', error);
    }).finally(() => setWarningsLoading(false));
  }, []);

  const latestWarnings = [...new Map([...generationWarnings]
    .sort((left, right) => (right.updatedAt?.toMillis?.() ?? right.finishedAtMs ?? 0) - (left.updatedAt?.toMillis?.() ?? left.finishedAtMs ?? 0))
    .map((warning) => [`${warning.studentId}:${warning.subject}`, warning])).values()].slice(0, 10);

  return (
    <AppShell title="Admin dashboard" subtitle="Monitor users, tutors, papers, subscriptions, and overall platform activity across Examifying." role="admin" user={profile} onLogout={logout}>
      {loadError ? <div className="panel border border-rose-200 p-4 text-sm font-medium text-rose-700" role="alert">{loadError}</div> : null}
      {!dashboard && !loadError ? <LoadingState label="Loading admin dashboard…" /> : null}
      {dashboard ? <>
      {warningsLoading ? <LoadingState label="Loading exercise-generation alerts…" /> : null}
      {latestWarnings.length && !warningsLoading ? <section className="panel border border-amber-300/30 p-5">
        <SectionHeader eyebrow="Question coverage" title="More analyzed questions needed" description="Some topics or exercise dates could not be fully covered by distinct analyzed paper questions. Add and analyze more past papers to expand coverage." />
        <div className="mt-4 space-y-3">
          {latestWarnings.map((warning) => <div key={`${warning.studentId}:${warning.subject}:${warning.id}`} className="rounded-lg border border-amber-200/20 bg-amber-400/5 p-3">
            <p className="font-semibold text-slate-100">{warning.subject || 'Subject'} · {warning.grade || 'Grade unavailable'} · {warning.studentId || 'Student'}</p>
            <p className="text-xs text-slate-400">{warning.region || 'Region unavailable'} · run date {warning.dateKey || warning.id}</p>
            <p className="mt-1 text-sm text-slate-300">
              {Number(warning.questionShortageCount) > 0 ? `${warning.questionShortageCount} question slot(s) were left unfilled. ` : ''}
              {warning.topicsWithoutSources?.length ? `No analyzed questions found for ${warning.topicsWithoutSources.join(', ')}.` : 'Analyze more past papers to add distinct questions.'}
            </p>
          </div>)}
        </div>
        <Link className="btn-secondary mt-4 inline-flex" to="/admin/papers">Open past papers</Link>
      </section> : null}
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {(dashboard.stats ?? []).map((item) => <StatCard key={item.label} {...item} />)}
      </section>
      <section className="grid gap-6 xl:grid-cols-[1fr_1fr]">
        <div>
          <SectionHeader eyebrow="Payments" title="Latest payment activity" description="Payments and subscription records appear here after secure Paystack verification." />
          <div className="mt-4 space-y-4">
            {(dashboard.payments ?? []).map((payment) => (
              <div key={payment.id} className="panel p-5">
                <p className="font-semibold text-slate-950">{payment.studentName}</p>
                <p className="mt-2 text-sm text-slate-600">{payment.amount} • {payment.status} • {payment.month}</p>
              </div>
            ))}
            {!dashboard.payments?.length ? <div className="panel p-5 text-sm text-slate-500">No payment records are available yet.</div> : null}
          </div>
        </div>
        <div>
          <SectionHeader eyebrow="Tutors" title="Tutor coverage" description="Admins manage tutor supply and can monitor assignment load and province coverage." />
          <div className="mt-4 space-y-4">
            {(dashboard.tutors ?? []).map((tutor) => (
              <div key={tutor.id} className="panel p-5">
                <p className="font-semibold text-slate-950">{tutor.name}</p>
                <p className="mt-2 text-sm text-slate-600">{tutor.students} students • {tutor.province}</p>
              </div>
            ))}
            {!dashboard.tutors?.length ? <div className="panel p-5 text-sm text-slate-500">No tutor records are available yet.</div> : null}
          </div>
        </div>
      </section>
      </> : null}
    </AppShell>
  );
};

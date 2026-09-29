import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { useAuth } from '../../hooks/useAuth';
import { ROLES } from '../../lib/constants';
import { getTutorBillingSummary } from '../../services/firestoreService';

export const ProfileBillingPage = ({ role }) => {
  const { profile, logout } = useAuth();
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    if (role === ROLES.TUTOR && profile?.uid) {
      getTutorBillingSummary(profile.uid).then(setSummary).catch((error) => {
        console.error('[Examifying][TutorBilling] load:error', error);
        setSummary({ totalLessons: 0, studentsTutored: 0, subjectsTutored: [], recentLessons: [] });
      });
    }
  }, [profile?.uid, role]);

  if (role === ROLES.STUDENT) {
    return (
      <AppShell title="Billing" subtitle="Manage your student subscription and payment access." role={role} user={profile} onLogout={logout}>
        <div className="panel p-5 text-sm text-slate-600">
          Student billing is managed on the billing workflow page.
          <div className="mt-4">
            <Link to="/student/billing" className="btn-primary">Open student billing</Link>
          </div>
        </div>
      </AppShell>
    );
  }

  if (role === ROLES.TUTOR) {
    return (
      <AppShell title="Tutor billing" subtitle="Review tutoring activity used for billing and reconciliation." role={role} user={profile} onLogout={logout}>
        <section className="grid gap-4 md:grid-cols-3">
          <div className="panel p-5"><p className="text-sm text-slate-500">Lessons tutored</p><p className="mt-2 text-3xl font-bold text-slate-950">{summary?.totalLessons ?? 0}</p></div>
          <div className="panel p-5"><p className="text-sm text-slate-500">Students tutored</p><p className="mt-2 text-3xl font-bold text-slate-950">{summary?.studentsTutored ?? 0}</p></div>
          <div className="panel p-5"><p className="text-sm text-slate-500">Subjects tutored</p><p className="mt-2 text-3xl font-bold text-slate-950">{summary?.subjectsTutored?.length ?? 0}</p></div>
        </section>
        <section className="panel p-5">
          <p className="text-sm font-semibold text-slate-950">Recent lessons</p>
          <div className="mt-4 space-y-3">
            {(summary?.recentLessons ?? []).map((lesson) => (
              <div key={lesson.id ?? `${lesson.studentId}-${lesson.topic}-${lesson.completedOn}`} className="rounded-2xl bg-slate-50 p-4 text-sm">
                <p className="font-semibold text-slate-900">{lesson.topic}</p>
                <p className="mt-1 text-slate-500">{lesson.subject} • {lesson.studentName ?? 'Student'} • {lesson.completedOn ?? 'No date'}</p>
              </div>
            ))}
            {summary && !summary.recentLessons?.length ? <p className="text-sm text-slate-500">No completed lessons have been recorded yet.</p> : null}
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell title="Billing" subtitle="Billing information for this account." role={role} user={profile} onLogout={logout}>
      <div className="panel p-5 text-sm text-slate-600">No billing workflow is configured for this role yet.</div>
    </AppShell>
  );
};

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { StatCard } from '../../components/common/StatCard';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { getRoleDashboardData } from '../../services/firestoreService';

export const AdminDashboardPage = () => {
  const { profile, logout } = useAuth();
  const [dashboard, setDashboard] = useState(null);

  useEffect(() => {
    getRoleDashboardData('admin').then(setDashboard);
  }, []);

  if (!dashboard) return null;

  return (
    <AppShell title="Admin dashboard" subtitle="Monitor users, tutors, papers, subscriptions, and overall platform activity across Examifying." role="admin" user={profile} onLogout={logout}>
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
    </AppShell>
  );
};

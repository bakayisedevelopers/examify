import { Link } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { useAuth } from '../../hooks/useAuth';

export const ProfileLegalPage = ({ role }) => {
  const { profile, logout } = useAuth();
  const links = [
    { label: 'Terms of Service', to: '/policies#terms' },
    { label: 'Refund & Cancellation', to: '/policies#refunds' },
    { label: 'Privacy Policy', to: '/policies#privacy' },
    { label: 'Contact Info', to: '/policies#contact' },
  ];

  return (
    <AppShell title="Legal" subtitle="Open Examifying legal pages and policy links." role={role} user={profile} onLogout={logout}>
      <div className="grid gap-4 md:grid-cols-2">
        {links.map((item) => (
          <Link key={item.to} to={item.to} className="panel block p-5 transition hover:-translate-y-1 hover:shadow-lg">
            <p className="text-lg font-semibold text-slate-950">{item.label}</p>
            <p className="mt-2 text-sm text-slate-500">Open {item.label.toLowerCase()}.</p>
          </Link>
        ))}
      </div>
    </AppShell>
  );
};

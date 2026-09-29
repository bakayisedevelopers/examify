import { Link } from 'react-router-dom';
import { BookOpen, ChevronRight, CreditCard, FileSignature, LogOut, Scale, Settings, UserRound } from 'lucide-react';
import { AppShell } from '../../components/common/AppShell';
import { useAuth } from '../../hooks/useAuth';
import { APP_VERSION, ROLES } from '../../lib/constants';

const cardClass = 'panel flex items-center gap-3 p-2.5 transition hover:bg-slate-50 md:block md:p-5 md:hover:-translate-y-1 md:hover:shadow-lg';

export const ProfileHubPage = ({ role }) => {
  const { profile, logout } = useAuth();
  const basePath = `/${role}/profile`;
  const items = [
    { to: `${basePath}/details`, label: 'Personal details', description: 'Update your name, password, and profile information.', icon: UserRound },
    { to: `${basePath}/subjects`, label: 'Subjects', description: role === ROLES.TUTOR ? 'Upload marks proof to add approved teaching subjects.' : 'Manage the subjects attached to your account.', icon: BookOpen },
    { to: role === ROLES.STUDENT ? '/student/billing' : `${basePath}/billing`, label: 'Billing', description: role === ROLES.TUTOR ? 'View lesson totals and tutor billing context.' : 'Open billing and subscription information.', icon: CreditCard },
    { to: `${basePath}/legal`, label: 'Legal', description: 'Open privacy policy, terms, refunds, and contact information.', icon: Scale },
    { to: `${basePath}/settings`, label: 'Settings', description: 'Manage account preferences for this workspace.', icon: Settings },
    ...(role === ROLES.TUTOR ? [{ to: `${basePath}/agreement`, label: 'Tutor agreement', description: 'Review and sign the tutor contract/agreement.', icon: FileSignature }] : []),
  ];

  return (
    <AppShell title="Profile" subtitle="Manage account details, subjects, billing, legal links, and settings." role={role} user={profile} onLogout={logout}>
      <div className="grid gap-2 md:gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.map(({ to, label, description, icon: Icon }) => (
          <Link key={to} to={to} className={cardClass}>
            <span className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-brand-50 md:h-auto md:w-auto md:bg-transparent">
              <Icon className="h-5 w-5 text-brand-700 md:h-6 md:w-6" />
            </span>
            <span className="min-w-0 flex-1 md:block">
              <span className="block truncate text-sm font-semibold text-slate-950 md:mt-4 md:text-lg">{label}</span>
              <span className="mt-2 hidden text-sm text-slate-500 md:block">{description}</span>
            </span>
            <ChevronRight className="h-5 w-5 flex-none text-slate-400 md:hidden" />
          </Link>
        ))}
      </div>
      <div className="panel flex flex-wrap items-center justify-between gap-3 p-5">
        <p className="text-sm font-semibold text-slate-500">Examifying v{APP_VERSION}</p>
        <button type="button" onClick={logout} className="inline-flex items-center gap-2 rounded-full bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-600 transition hover:bg-rose-100">
          <LogOut className="h-4 w-4" />
          Log out
        </button>
      </div>
    </AppShell>
  );
};

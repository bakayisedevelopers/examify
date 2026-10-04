import { useMemo, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, BookOpen, ClipboardCheck, CreditCard, FileText, LogOut, Users, ShieldCheck, Menu, X, ChevronLeft, GraduationCap, Tag } from 'lucide-react';
import { Logo } from './Logo';
import { ROLES } from '../../lib/constants';
import { useAuth } from '../../hooks/useAuth';
import { useStudentSubscriptionState } from '../../hooks/useStudentSubscriptionState';

const navigationByRole = {
  [ROLES.STUDENT]: [
    { to: '/student', label: 'Overview', icon: LayoutDashboard },
    // { to: '/student/exercises', label: 'Exercises', icon: BookOpen },
    { to: '/student/lessons', label: 'Lessons', icon: GraduationCap },
    { to: '/student/papers', label: 'Past papers', icon: BookOpen },
    { to: '/student/peer-reviews', label: 'Peer reviews', icon: ClipboardCheck },
    { to: '/student/guide', label: 'Examifying Guide', icon: ClipboardCheck },
  ],
  [ROLES.TUTOR]: [
    { to: '/tutor', label: 'Overview', icon: LayoutDashboard },
    { to: '/tutor/exercises', label: 'Exercises', icon: ClipboardCheck },
    { to: '/tutor/lessons', label: 'Lessons', icon: GraduationCap },
    { to: '/tutor/papers', label: 'Past papers', icon: BookOpen },
    { to: '/tutor/reports', label: 'Reports', icon: FileText },
    { to: '/tutor/guide', label: 'Examifying Guide', icon: ClipboardCheck },
  ],
  [ROLES.ADMIN]: [
    { to: '/admin', label: 'Overview', icon: LayoutDashboard },
    { to: '/admin/users', label: 'Users', icon: Users },
    { to: '/admin/papers', label: 'Past papers', icon: BookOpen },
    { to: '/admin/payments', label: 'Payments', icon: CreditCard },
    { to: '/admin/discount-codes', label: 'Discount codes', icon: Tag },
    { to: '/admin/settings', label: 'Settings', icon: ShieldCheck },
  ],
  [ROLES.PARENT]: [
    { to: '/parent', label: 'Overview', icon: LayoutDashboard },
  ],
};

import { useEffectiveRole } from '../../utils/effectiveRole';

const getNavigationForRole = (role, isTeacher) => {
  const prefix = isTeacher ? '/teacher' : `/${role}`;
  if (role === ROLES.TUTOR || isTeacher) {
    return [
      { to: prefix, label: 'Overview', icon: LayoutDashboard },
      { to: `${prefix}/exercises`, label: 'Exercises', icon: ClipboardCheck },
      { to: `${prefix}/lessons`, label: 'Lessons', icon: GraduationCap },
      { to: `${prefix}/papers`, label: 'Past papers', icon: BookOpen },
      { to: `${prefix}/reports`, label: 'Reports', icon: FileText },
      { to: `${prefix}/guide`, label: 'Examifying Guide', icon: ClipboardCheck },
    ];
  }
  return navigationByRole[role] ?? [];
};

export const AppShell = ({ title, subtitle, role: propRole, user, onLogout, mobileHeaderContent, children }) => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { role, isTeacher } = useEffectiveRole();
  const effectiveRole = propRole === 'teacher' || isTeacher ? 'teacher' : (propRole || role);
  const { profile, user: authUser } = useAuth();
  const account = useMemo(() => ({ ...(authUser ?? {}), ...(profile ?? {}), ...(user ?? {}) }), [authUser, profile, user]);
  const subscriptionState = useStudentSubscriptionState(effectiveRole === ROLES.STUDENT ? account : null);
  const isFreeStudent = effectiveRole === ROLES.STUDENT && !subscriptionState?.paymentCompleted;
  const roleNavigation = getNavigationForRole(effectiveRole, effectiveRole === 'teacher');
  const navigation = isFreeStudent
    ? roleNavigation.filter((item) => item.to === '/student/papers')
    : roleNavigation;
  const homePath = isFreeStudent ? '/student/papers' : `/${effectiveRole}`;
  const profilePath = `/${effectiveRole}/profile`;
  const displayName = account.displayName || account.name || account.fullName || 'Account';
  const email = account.email || '';
  const avatarUrl = account.photoURL || account.photoUrl || account.avatarUrl || account.profileImageUrl || account.avatar || '';
  const initials = (displayName !== 'Account' ? displayName : email)
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || 'U';
  const identityLabel = effectiveRole === ROLES.STUDENT
    ? (subscriptionState?.subscriptionPlanName || 'Checking subscription')
    : ({ teacher: 'Teacher', tutor: 'Tutor', admin: 'Admin', parent: 'Parent' }[effectiveRole] || 'Account');
  const navigate = useNavigate();

  return (
    <div className="fixed inset-0 overflow-hidden bg-slate-950 text-slate-100 selection:bg-lime-400 selection:text-slate-950 lg:static lg:h-screen">
      <div className="mx-auto flex h-[100dvh] max-h-[100dvh] max-w-7xl flex-col gap-4 px-4 py-4 lg:grid lg:h-screen lg:max-h-none lg:grid-cols-[260px_1fr] lg:gap-6 lg:px-6">
        
        {/* Mobile Header */}
        <div className="panel z-30 grid flex-none grid-cols-[auto_1fr_auto] items-center gap-3 p-4 border-slate-800 bg-slate-900/95 lg:hidden">
          <div className="flex min-w-10 items-center justify-start">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-lime-400 transition hover:bg-slate-800 hover:text-lime-300"
              aria-label="Go back"
            >
              <ChevronLeft className="h-6 w-6 stroke-[2.5]" />
            </button>
          </div>
          <div className="min-w-0 text-center">
            {mobileHeaderContent ?? (
              <h1
                className="truncate bg-gradient-to-r from-lime-400 via-lime-300 to-emerald-400 bg-clip-text text-base font-extrabold text-transparent"
                style={{
                  backgroundImage: 'linear-gradient(90deg, #a3e635 0%, #bef264 50%, #34d399 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                {title}
              </h1>
            )}
          </div>
          <button
            onClick={() => setIsMobileMenuOpen(true)}
            className="rounded-lg p-2 text-lime-400 transition hover:bg-slate-800 hover:text-lime-300"
            aria-label="Open navigation"
          >
            <Menu className="h-6 w-6" />
          </button>
        </div>

        {/* Mobile Drawer Backdrop */}
        {isMobileMenuOpen && (
          <div 
            className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden transition-opacity"
            onClick={() => setIsMobileMenuOpen(false)}
          />
        )}

        <aside 
          className={`panel z-50 flex flex-col p-5 border-slate-800 bg-slate-900/95 transition-transform duration-300 ease-in-out
            fixed inset-y-4 left-4 max-h-[calc(100dvh-2rem)] max-w-[300px] w-[90vw] overflow-y-auto overscroll-contain
            ${isMobileMenuOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-[calc(100%+1.5rem)]'}
            lg:sticky lg:top-4 lg:h-[calc(100vh-2rem)] lg:w-auto lg:max-w-none lg:translate-x-0 lg:shadow-sm`}
        >
          <div className="mb-5 flex items-center justify-between lg:hidden">
            <Link to={homePath} className="block" onClick={() => setIsMobileMenuOpen(false)}>
              <Logo showText={false} />
            </Link>
            <button
              onClick={() => setIsMobileMenuOpen(false)}
              className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 lg:hidden transition"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <Link
            to={profilePath}
            onClick={() => setIsMobileMenuOpen(false)}
            className="mb-5 flex min-w-0 flex-col items-center border-b border-slate-800 pb-5 text-center transition hover:opacity-90"
          >
            <span className="relative flex h-14 w-14 flex-none items-center justify-center overflow-hidden rounded-full border border-slate-700 bg-slate-800 text-sm font-semibold text-lime-300">
              {initials}
              {avatarUrl ? <img src={avatarUrl} alt="" className="absolute inset-0 h-full w-full object-cover" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : null}
            </span>
            <span className="mt-3 w-full truncate text-sm font-semibold text-white">{displayName}</span>
            {email ? <span className="mt-1 w-full truncate text-xs text-slate-400">{email}</span> : null}
            <span className="mt-2 max-w-full truncate rounded-full border border-lime-400/20 bg-lime-400/10 px-2.5 py-1 text-xs font-medium text-lime-300">
              {identityLabel}{effectiveRole === ROLES.STUDENT ? ' plan' : ''}
            </span>
          </Link>
          <nav className="space-y-2">
            {navigation.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === `/${effectiveRole}`}
                onClick={() => setIsMobileMenuOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition ${
                    isActive
                      ? 'bg-lime-400/15 text-lime-400 border border-lime-400/30 font-semibold shadow-[0_0_15px_rgba(163,230,53,0.15)]'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100'
                  }`
                }
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto rounded-2xl border border-slate-800 bg-slate-950/80 p-4">
            <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Signed in</p>
            <button type="button" onClick={() => { setIsMobileMenuOpen(false); onLogout(); }} className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-rose-400 hover:text-rose-300">
              <LogOut className="h-4 w-4" />
              Log out
            </button>
          </div>
        </aside>
        <main className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain pb-[calc(2rem+env(safe-area-inset-bottom))] pr-1 lg:pb-4">
          <header className="panel hidden flex-col gap-3 p-6 border-slate-800 bg-slate-900/90 md:flex-row md:items-center md:justify-between lg:sticky lg:top-0 lg:z-30 lg:flex">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.25em] text-lime-400">{role} workspace</p>
              <h1 className="mt-2 text-3xl font-bold tracking-tight text-white">{title}</h1>
              <p className="mt-2 max-w-3xl text-sm text-slate-400">{subtitle}</p>
            </div>
          </header>
          {children}
        </main>
      </div>
    </div>
  );
};

import { ArrowRight, BookOpen, CheckCircle2, FileCheck2, GraduationCap, LockKeyhole, ShieldCheck, Users } from 'lucide-react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Logo } from '../components/common/Logo';
import { useAuth } from '../hooks/useAuth';
import { getPortalConfig, getPortalForProfile, getSignupPathForPortal } from '../utils/portal';

const portalContent = {
  teacher: {
    eyebrow: 'Maths teacher workspace',
    title: 'Connect your Maths lessons with learner progress and practice.',
    description: 'Review learner work, follow topic understanding, and keep Mathematics lessons connected to regular practice.',
    cards: [
      { icon: GraduationCap, title: 'Support your learners', body: 'Open the students connected to your teacher account.' },
      { icon: FileCheck2, title: 'Review exercise work', body: 'Use the existing submission, marking, and understanding-score tools.' },
      { icon: BookOpen, title: 'Plan the next steps', body: 'Keep lessons, completed topics, and student progress together.' },
    ],
  },
  tutor: {
    eyebrow: 'Online Maths tutor workspace',
    title: 'Help your Maths students make steady progress.',
    description: 'Review assigned learner work, follow topic understanding, and keep lessons and daily Maths practice connected in one place.',
    cards: [
      { icon: Users, title: 'Manage your learners', body: 'See the students connected to your tutor account.' },
      { icon: FileCheck2, title: 'Review their work', body: 'Open exercise submissions and use the existing marking and score tools.' },
      { icon: BookOpen, title: 'Keep learning moving', body: 'Work with exercises, topics, lessons, and progress reports.' },
    ],
  },
  parent: {
    eyebrow: 'Parent and caregiver portal',
    title: 'Follow your child’s Maths learning and progress.',
    description: 'Use the Examifying parent portal to follow linked learners, exercise activity, and the progress information available to your family.',
    cards: [
      { icon: GraduationCap, title: 'Follow linked learners', body: 'View the learners connected to your parent account.' },
      { icon: FileCheck2, title: 'Review progress', body: 'Keep track of exercise activity and available learning updates.' },
      { icon: ShieldCheck, title: 'Manage your account', body: 'Access your profile and family account settings in one place.' },
    ],
  },
  admin: {
    eyebrow: 'Restricted administration',
    title: 'Examifying administration workspace.',
    description: 'Sign in with an administrator account to manage platform users, payments, settings, and learning resources.',
    cards: [
      { icon: Users, title: 'User administration', body: 'Review platform accounts and the existing role and access information.' },
      { icon: FileCheck2, title: 'Payments and codes', body: 'Access administration tools for payment records and discount codes.' },
      { icon: LockKeyhole, title: 'Protected access', body: 'Administrator access is granted by the Examifying platform owner.' },
    ],
  },
};

const getDashboardPath = (profile) => {
  if (getPortalForProfile(profile) === 'teacher') return '/teacher';
  return `/${profile.role}`;
};

export const RoleLandingPage = ({ portal }) => {
  const { profile } = useAuth();
  const location = useLocation();
  const config = getPortalConfig(portal);
  const content = portalContent[portal];

  if (!content) return <Navigate to="/" replace />;

  if (profile?.role) {
    const selection = new URLSearchParams(location.search);
    if (selection.has('discountCode') && profile.role === 'student') {
      if (!selection.has('planId')) selection.set('planId', 'circle');
      if (!selection.has('billingPeriod')) selection.set('billingPeriod', 'monthly');
      if (!selection.has('subjectCount')) selection.set('subjectCount', '1');
      return <Navigate to={`/student/billing?${selection.toString()}`} replace />;
    }
    if (selection.has('discountCode') && profile.role === 'parent') {
      return <Navigate to={`/parent?discountCode=${encodeURIComponent(selection.get('discountCode'))}`} replace />;
    }
    return <Navigate to={getDashboardPath(profile)} replace />;
  }

  const loginPath = location.search ? `/login${location.search}` : '/login';
  const signupPath = getSignupPathForPortal(portal, location.search);

  return (
    <main className="relative min-h-[calc(100vh-76px)] overflow-hidden bg-slate-950 px-4 py-14 text-slate-100 sm:py-20 lg:px-6">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[34rem] w-[52rem] -translate-x-1/2 rounded-full bg-[radial-gradient(circle_at_center,rgba(163,230,53,0.16)_0%,rgba(16,185,129,0.08)_42%,transparent_72%)] blur-3xl" />
      <div className="relative mx-auto max-w-7xl">
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
          <section className="max-w-3xl">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-lime-400/30 bg-lime-400/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-lime-300">
              <span className="h-2 w-2 rounded-full bg-lime-400" />
              {content.eyebrow}
            </div>
            <h1 className="text-4xl font-black leading-tight tracking-tight text-white sm:text-5xl lg:text-6xl">
              {content.title}
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-8 text-slate-300 sm:text-lg">
              {content.description}
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link to={loginPath} className="btn-primary gap-2 px-7 py-3.5">
                Sign in to the {config.label.toLowerCase()} portal
                <ArrowRight className="h-4 w-4" />
              </Link>
              {signupPath ? (
                <Link to={signupPath} className="btn-secondary px-6 py-3.5">Create a {config.label.toLowerCase()} account</Link>
              ) : (
                <p className="self-center text-sm text-slate-400">Accounts are issued by the Examifying platform owner.</p>
              )}
            </div>
            <div className="mt-9 flex items-center gap-3 text-sm text-slate-400">
              <CheckCircle2 className="h-5 w-5 text-lime-400" />
              <span>One Examifying app, with access controlled by your existing account role.</span>
            </div>
          </section>

          <aside className="panel relative overflow-hidden p-6 sm:p-8">
            <div className="mb-7 flex items-center justify-between gap-4 border-b border-white/10 pb-6">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-lime-400">{config.audience}</p>
                <h2 className="mt-2 text-xl font-bold text-white">Your Examifying portal</h2>
              </div>
              <Logo showText={false} className="rounded-2xl border border-lime-400/20 bg-lime-400/5 p-2" />
            </div>
            <div className="space-y-3">
              {content.cards.map(({ icon: Icon, title, body }) => (
                <div key={title} className="flex gap-4 rounded-2xl border border-white/5 bg-slate-950/60 p-4">
                  <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-lime-400/10 text-lime-300">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="font-semibold text-white">{title}</h3>
                    <p className="mt-1 text-sm leading-6 text-slate-400">{body}</p>
                  </div>
                </div>
              ))}
            </div>
            {portal === 'admin' ? (
              <div className="mt-5 rounded-xl border border-amber-300/20 bg-amber-300/5 p-4 text-sm leading-6 text-amber-100/80">
                Administrator pages remain protected by the signed-in account’s existing role.
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </main>
  );
};

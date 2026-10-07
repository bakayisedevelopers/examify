import { Link, Outlet, useLocation } from 'react-router-dom';
import { Logo } from '../components/common/Logo';
import { useAuth } from '../hooks/useAuth';
import { getPortal, getPortalForProfile, getPortalSiteUrl, getSignupPathForPortal } from '../utils/portal';

export const MarketingLayout = () => {
  const { profile } = useAuth();
  const location = useLocation();
  const portal = getPortal();
  const signupParams = new URLSearchParams(location.search);
  if (signupParams.has('discountCode')) signupParams.set('checkout', '1');
  const signupPath = getSignupPathForPortal(portal, signupParams.toString());
  const studentContentUrl = getPortalSiteUrl('student');
  const methodHref = portal === 'student' ? '/#method' : `${studentContentUrl}/#method`;
  const pricingHref = portal === 'student' ? '/#pricing' : `${studentContentUrl}/#pricing`;
  const homePath = profile?.role
    ? (getPortalForProfile(profile) === 'teacher' ? '/teacher' : `/${profile.role}`)
    : '/';
  
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 selection:bg-lime-400 selection:text-slate-950">
      <header className="sticky top-0 z-30 border-b border-lime-500/20 bg-slate-950/90 shadow-[0_4px_25px_rgba(0,0,0,0.6)] backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap sm:py-4 lg:px-6">
          <Link to={homePath} className="inline-flex items-center group">
            <Logo />
          </Link>
          <nav aria-label="Quick access" className="order-3 flex w-full items-center justify-center gap-5 border-t border-white/5 pt-2 text-xs font-semibold text-slate-300 sm:order-none sm:w-auto sm:gap-4 sm:border-0 sm:pt-0 sm:text-sm">
            <a href={methodHref} className="whitespace-nowrap transition hover:text-lime-300">Method of Teaching</a>
            <a href={pricingHref} className="whitespace-nowrap transition hover:text-lime-300">Pricing</a>
          </nav>
          <div className="flex flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3">
            <Link
              to={`/login${location.search}`}
              className="text-xs sm:text-sm font-semibold text-slate-300 hover:text-white px-2 py-0.5 sm:rounded-full sm:border sm:border-lime-400/30 sm:bg-slate-900/60 sm:px-5 sm:py-2.5 sm:text-lime-300 sm:backdrop-blur transition sm:hover:border-lime-400 sm:hover:bg-lime-400/10"
            >
              Login
            </Link>
            {signupPath ? (
              <Link
                to={signupPath}
                className="text-xs sm:text-sm font-bold text-lime-400 hover:text-lime-300 px-2 py-0.5 sm:rounded-full sm:bg-gradient-to-r sm:from-lime-400 sm:via-lime-400 sm:to-emerald-400 sm:px-5 sm:py-2.5 sm:text-slate-950 sm:shadow-[0_0_20px_rgba(163,230,53,0.35)] transition"
              >
                {portal === 'admin' ? 'Admin sign in' : 'Get started'}
              </Link>
            ) : null}
          </div>
        </div>
      </header>
      <Outlet />
    </div>
  );
};

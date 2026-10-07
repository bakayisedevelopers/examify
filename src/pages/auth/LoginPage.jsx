import { useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { Logo } from '../../components/common/Logo';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import { getPortal, getPortalConfig, getPortalForProfile, getPortalSiteUrl, getSignupPathForPortal, isProfileAllowedOnPortal } from '../../utils/portal';

export const LoginPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, logout } = useAuth();
  const { runOperation } = useOperationStatus();
  const [form, setForm] = useState({ email: '', password: '' });
  const [status, setStatus] = useState('');
  const [accountPortal, setAccountPortal] = useState(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const portal = getPortal();
  const portalConfig = getPortalConfig(portal);
  const signupParams = new URLSearchParams(location.search);
  if (signupParams.has('discountCode')) signupParams.set('checkout', '1');
  const signupPath = getSignupPathForPortal(portal, signupParams.toString());

  const redirectByRole = (profile) => {
    const selection = new URLSearchParams(location.search);
    const planId = selection.get('planId');
    if (profile.role === 'student' && (['free', 'circle', 'personalized'].includes(planId) || selection.has('discountCode'))) {
      navigate(`/student/billing?${selection.toString()}`);
      return;
    }
    if (profile.role === 'parent' && selection.get('discountCode')) {
      navigate(`/parent?discountCode=${encodeURIComponent(selection.get('discountCode'))}`);
      return;
    }
    const target = getPortalForProfile(profile) === 'teacher' ? '/teacher' : `/${profile.role}`;
    navigate(target);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsLoggingIn(true);
    setStatus('');
    setAccountPortal(null);
    try {
      const result = await runOperation({ operationName: 'Signing in', successMessage: 'Signed in successfully.', autoDismissMs: 650 }, () => login(form));
      if (!isProfileAllowedOnPortal(result.profile, portal)) {
        const correctPortal = getPortalForProfile(result.profile);
        await logout();
        setAccountPortal(correctPortal);
        setStatus(`This account does not have access to the ${portalConfig.label.toLowerCase()} site.`);
        return;
      }
      redirectByRole(result.profile);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setIsLoggingIn(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-[calc(100vh-88px)] max-w-lg items-center justify-center px-4 py-12 lg:px-6">
      <form onSubmit={handleSubmit} className="panel w-full space-y-5 p-8 border border-slate-800 bg-slate-900/90 shadow-2xl">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-lime-400">{portalConfig.label} portal</p>
          <h2 className="mt-2 text-2xl sm:text-3xl font-bold text-white">Sign in to Examifying</h2>
          <p className="mt-2 text-sm text-slate-400">Use the account linked to your {portalConfig.audience.toLowerCase()} access.</p>
          <Logo className="mt-4" />
        </div>
        <label className="block">
          <span className="label">Email</span>
          <input type="email" autoComplete="email" className="input" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} disabled={isLoggingIn} required />
        </label>
        <label className="block">
          <span className="label">Password</span>
          <input type="password" autoComplete="current-password" className="input" value={form.password} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} disabled={isLoggingIn} required />
        </label>
        <div className="flex items-start gap-3 text-xs sm:text-sm text-slate-400">
          <p>
            By logging in you agree to Examifying{' '}
            <Link to="/policies#terms" className="font-semibold text-lime-400 hover:text-lime-300 hover:underline">
              Terms of Use
            </Link>,{' '}
            <Link to="/policies#refunds" className="font-semibold text-lime-400 hover:text-lime-300 hover:underline">
              Refund Policy
            </Link>, and acknowledge our{' '}
            <Link to="/policies#contact" className="font-semibold text-lime-400 hover:text-lime-300 hover:underline">
              Contact Information
            </Link>.
          </p>
        </div>
        <button type="submit" className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-70" disabled={isLoggingIn}>
          {isLoggingIn ? 'Logging in...' : 'Login'}
        </button>
        {status ? <p className="text-sm text-rose-500">{status}</p> : null}
        {accountPortal ? (
          <a href={getPortalSiteUrl(accountPortal)} className="block text-center text-sm font-semibold text-lime-400 hover:text-lime-300 hover:underline">
            Go to the {getPortalConfig(accountPortal).label.toLowerCase()} site
          </a>
        ) : null}
        {signupPath ? (
          <p className="text-sm text-slate-400 text-center">
            Need an account? <Link to={signupPath} className="font-semibold text-lime-400 hover:text-lime-300 hover:underline">Create one</Link>.
          </p>
        ) : (
          <p className="text-sm text-slate-400 text-center">Administrator accounts are managed by the Examifying platform owner.</p>
        )}
      </form>
    </main>
  );
};

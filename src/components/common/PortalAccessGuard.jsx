import { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import { getPortal, getPortalConfig, getPortalForProfile, getPortalSiteUrl, isProfileAllowedOnPortal } from '../../utils/portal';

export const PortalAccessGuard = ({ children }) => {
  const { profile, logout } = useAuth();
  const { runOperation } = useOperationStatus();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');
  const portal = getPortal();

  if (!profile || isProfileAllowedOnPortal(profile, portal)) return children;

  const accountPortal = getPortalForProfile(profile);
  const siteConfig = getPortalConfig(portal);
  const accountConfig = accountPortal ? getPortalConfig(accountPortal) : null;

  const handleSignOut = async () => {
    setSigningOut(true);
    setError('');
    try {
      await runOperation({ operationName: 'Signing out', successMessage: 'You have been signed out.', autoDismissMs: 650 }, logout);
    } catch (signOutError) {
      setError(signOutError.message || 'Could not sign out. Please try again.');
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-12 text-slate-100">
      <section className="panel w-full max-w-xl space-y-5 p-7 sm:p-9">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-lime-400">Role-specific site</p>
        <h1 className="text-2xl font-bold text-white">This account cannot access this site</h1>
        <p className="text-sm leading-6 text-slate-300">
          This site is for {siteConfig.audience.toLowerCase()}. The signed-in account
          {accountConfig ? ` belongs to the ${accountConfig.label.toLowerCase()} portal.` : ' does not have a supported portal role.'}
        </p>
        {accountPortal ? (
          <a className="btn-secondary" href={getPortalSiteUrl(accountPortal)}>
            Go to the {accountConfig.label.toLowerCase()} site
          </a>
        ) : null}
        <div className="space-y-2">
          <button type="button" className="btn-primary" onClick={handleSignOut} disabled={signingOut}>
            {signingOut ? 'Signing out…' : 'Sign out of this site'}
          </button>
          {error ? <p role="alert" className="text-sm text-rose-300">{error}</p> : null}
        </div>
      </section>
    </main>
  );
};

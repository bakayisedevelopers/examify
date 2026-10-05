import { useEffect, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { isFirebaseConfigured } from '../../firebase/config';
import {
  createCookieConsent,
  getAccountCookieConsent,
  readLocalCookieConsent,
  saveAccountCookieConsent,
  writeLocalCookieConsent,
} from '../../services/cookieConsentService';

const openedPreferencesEvent = 'examifying:open-cookie-preferences';

const timestamp = (consent) => consent?.updatedAt ? Date.parse(consent.updatedAt) : 0;

export const CookieConsentManager = () => {
  const { user, loading: authLoading } = useAuth();
  const [consent, setConsent] = useState(() => readLocalCookieConsent());
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [consentReady, setConsentReady] = useState(false);

  useEffect(() => {
    const openPreferences = () => setPreferencesOpen(true);
    window.addEventListener(openedPreferencesEvent, openPreferences);
    return () => window.removeEventListener(openedPreferencesEvent, openPreferences);
  }, []);

  useEffect(() => {
    if (authLoading) return undefined;
    if (!user?.uid || !isFirebaseConfigured) {
      setConsentReady(true);
      return undefined;
    }

    let active = true;
    setConsentReady(false);
    const localAtStart = readLocalCookieConsent();

    const synchronize = async () => {
      const remote = await getAccountCookieConsent(user.uid);
      if (!active) return;

      const localNow = readLocalCookieConsent();
      if (localNow?.updatedAt !== localAtStart?.updatedAt) return;

      if (localNow && (!remote || timestamp(localNow) > timestamp(remote))) {
        await saveAccountCookieConsent(user.uid, localNow);
        return;
      }

      if (remote) {
        writeLocalCookieConsent(remote);
        setConsent(remote);
      } else if (!localNow) {
        setConsent(null);
      }
    };

    synchronize().catch((error) => {
      console.warn('Cookie preference account sync failed:', error);
    }).finally(() => {
      if (active) setConsentReady(true);
    });

    return () => {
      active = false;
    };
  }, [authLoading, user?.uid]);

  const saveChoice = async (choice) => {
    const nextConsent = createCookieConsent(choice);
    setConsent(nextConsent);
    setPreferencesOpen(false);
    setSyncMessage('');

    const savedLocally = writeLocalCookieConsent(nextConsent);
    if (!savedLocally) {
      setSyncMessage('Your choice is active for this visit, but this browser could not store it.');
    }

    if (user?.uid && isFirebaseConfigured) {
      try {
        await saveAccountCookieConsent(user.uid, nextConsent);
      } catch (error) {
        console.warn('Cookie preference account sync failed:', error);
        setSyncMessage('Your choice is saved on this device, but could not be synced to your account.');
      }
    }
  };

  const showBanner = consentReady && !consent;

  return (
    <>
      {showBanner ? (
        <section
          aria-label="Cookie preferences"
          className="fixed inset-x-3 bottom-3 z-[90] mx-auto max-w-3xl rounded-2xl border border-lime-400/25 bg-slate-950/95 p-4 text-slate-100 shadow-2xl backdrop-blur sm:inset-x-5 sm:bottom-5 sm:p-5"
        >
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-lime-300" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-bold text-white">Your privacy choices</h2>
              <p className="mt-1 text-xs leading-5 text-slate-300 sm:text-sm">
                Examifying uses necessary browser storage for sign-in, security, and your saved preferences. We do not currently use analytics or advertising trackers.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={() => saveChoice('accept-all')} className="btn-primary px-4 py-2 text-xs sm:text-sm">
                  Accept All
                </button>
                <button type="button" onClick={() => saveChoice('necessary-only')} className="btn-secondary px-4 py-2 text-xs sm:text-sm">
                  Necessary Only
                </button>
                <button
                  type="button"
                  onClick={() => setPreferencesOpen(true)}
                  className="rounded-full px-3 py-2 text-xs font-semibold text-lime-200 underline decoration-lime-400/40 underline-offset-4 hover:text-white sm:text-sm"
                >
                  Manage Preferences
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : consentReady ? (
        <button
          type="button"
          onClick={() => setPreferencesOpen(true)}
          className="fixed bottom-3 right-3 z-[70] rounded-full border border-slate-700 bg-slate-950/90 px-3 py-2 text-[11px] font-semibold text-slate-300 shadow-lg backdrop-blur transition hover:border-lime-400/50 hover:text-lime-200 sm:bottom-4 sm:right-4"
        >
          Cookie Preferences
        </button>
      ) : null}

      {syncMessage ? (
        <p role="status" className="fixed bottom-14 right-3 z-[71] max-w-[min(24rem,calc(100vw-1.5rem))] rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-300 shadow-lg sm:bottom-16 sm:right-4">
          {syncMessage}
        </p>
      ) : null}

      {preferencesOpen ? (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 p-3 backdrop-blur-sm sm:items-center sm:p-5"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreferencesOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="cookie-preferences-title"
            className="w-full max-w-lg rounded-2xl border border-lime-400/25 bg-slate-950 p-5 text-slate-100 shadow-2xl sm:p-6"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="cookie-preferences-title" className="text-lg font-bold text-white">Cookie Preferences</h2>
                <p className="mt-1 text-sm leading-6 text-slate-400">
                  Choose how Examifying remembers your privacy choice. No optional analytics or marketing trackers are currently active.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreferencesOpen(false)}
                className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-white"
                aria-label="Close cookie preferences"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-5 rounded-xl border border-lime-400/20 bg-lime-400/5 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="font-semibold text-white">Necessary</p>
                <span className="rounded-full border border-lime-400/30 bg-lime-400/10 px-2.5 py-1 text-xs font-semibold text-lime-200">
                  Always Active
                </span>
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                Required for Firebase sign-in, application security, and storing this preference on your device.
              </p>
            </div>

            <p className="mt-4 text-xs leading-5 text-slate-500">
              Your selection is stored on this device. When you are signed in, Examifying also saves it to your account so it can be respected on another device.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => saveChoice('necessary-only')} className="btn-secondary px-4 py-2 text-sm">
                Save Preferences
              </button>
              <button type="button" onClick={() => saveChoice('accept-all')} className="btn-primary px-4 py-2 text-sm">
                Accept All
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
};

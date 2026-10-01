import { useEffect, useRef, useState } from 'react';
import { subscribePeerMarkingAssignmentsForStudent } from '../../services/firestoreService';
import { getNotificationSupportState, registerStudentNotificationDevice } from '../../services/notificationService';

const getNotificationPermission = () => {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
};

const isAiStudioPreview = () => {
  if (typeof window === 'undefined') return false;
  const hostname = window.location.hostname || '';
  const isAiStudioHost = /^ais-(?:dev|pre)-.*\.run\.app$/i.test(hostname) || /aistudio/i.test(hostname);
  const hasAiStudioAncestor = Boolean(
    window.location.ancestorOrigins &&
      Array.from(window.location.ancestorOrigins).some((origin) => /aistudio\.google\.com/i.test(origin))
  );
  const hasAiStudioReferrer = typeof document !== 'undefined' && /aistudio\.google\.com/i.test(document.referrer || '');
  return isAiStudioHost || hasAiStudioAncestor || hasAiStudioReferrer;
};

const getNotificationEnvironment = () => {
  if (typeof navigator === 'undefined') return { ios: false, android: false, windows: false, safari: false, installed: false, aiStudio: false };
  const userAgent = navigator.userAgent ?? '';
  const ios = /iPhone|iPad|iPod/i.test(userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /Safari/i.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(userAgent);
  const installed = Boolean(navigator.standalone) || window.matchMedia?.('(display-mode: standalone)').matches === true;
  const windows = /Windows/i.test(userAgent) || /Win/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');
  const aiStudio = isAiStudioPreview();
  return { ios, android: /Android/i.test(userAgent), windows, safari, installed, aiStudio };
};

const getSettingsGuidance = () => {
  const { ios, android, safari, installed } = getNotificationEnvironment();
  if (ios && safari && !installed) {
    return 'On iPhone or iPad, web notifications work from the installed web app. In Safari, tap Share, choose Add to Home Screen, open Examifying from its new Home Screen icon, then tap Enable notifications.';
  }
  if (ios && installed) {
    return 'Open iPhone or iPad Settings, find Examifying under Notifications (or Settings > Notifications), and allow notifications. Return to the installed Examifying app and tap Check notification access.';
  }
  if (android) {
    return 'In Chrome, open Examifying site settings and set Notifications to Allow. Also check Android Settings > Apps > Chrome > Notifications. Return here and tap Check notification access.';
  }
  return 'Open this site’s permissions from your browser’s address bar or site settings and allow notifications. Return here and tap Check notification access.';
};

const buildAssignmentText = (assignment) => {
  const subject = assignment.subject ? `${assignment.subject} ` : '';
  const title = assignment.title || 'exercise';
  return `${subject}${title}`.trim();
};

export const StudentNotificationGate = ({ profile, children, required = true }) => {
  const { android, windows, aiStudio } = getNotificationEnvironment();
  const requiresNotificationPermission = required && (android || windows) && !aiStudio;
  const [permission, setPermission] = useState(getNotificationPermission);
  const [error, setError] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [deviceRegistered, setDeviceRegistered] = useState(false);
  const initializedRef = useRef(false);
  const seenAssignmentsRef = useRef(new Set());

  useEffect(() => {
    setPermission(getNotificationPermission());
  }, []);

  useEffect(() => {
    const refreshPermission = () => setPermission(getNotificationPermission());
    window.addEventListener('focus', refreshPermission);
    document.addEventListener('visibilitychange', refreshPermission);
    return () => {
      window.removeEventListener('focus', refreshPermission);
      document.removeEventListener('visibilitychange', refreshPermission);
    };
  }, []);

  useEffect(() => {
    if (!profile?.uid || permission !== 'granted' || !deviceRegistered) return undefined;

    return subscribePeerMarkingAssignmentsForStudent(profile.uid, (assignments) => {
      const openAssignments = assignments.filter((assignment) => assignment.status !== 'completed');

      if (!initializedRef.current) {
        openAssignments.forEach((assignment) => seenAssignmentsRef.current.add(assignment.id));
        initializedRef.current = true;
        return;
      }

      openAssignments.forEach((assignment) => {
        if (seenAssignmentsRef.current.has(assignment.id)) return;
        seenAssignmentsRef.current.add(assignment.id);

        const notification = new Notification('New work to mark', {
          body: `${buildAssignmentText(assignment)} is ready for peer marking.`,
          icon: '/logo.png',
          tag: `peer-marking-${assignment.id}`,
        });
        notification.onclick = () => {
          window.focus();
          window.location.href = '/student?tab=mark';
          notification.close();
        };
      });
    });
  }, [deviceRegistered, permission, profile?.uid]);

  const requestPermission = async () => {
    setError('');
    setDeviceRegistered(false);
    if (getNotificationPermission() === 'unsupported') {
      setPermission('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setPermission('denied');
      setError(getSettingsGuidance());
      return;
    }

    setIsRegistering(true);
    try {
      // Keep the permission prompt directly inside the user's tap gesture.
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') {
        setError(getSettingsGuidance());
        return;
      }

      const support = await getNotificationSupportState();
      if (!support.supported) {
        throw new Error('Permission is enabled, but this browser cannot register push notifications with the current notification service.');
      }
      await registerStudentNotificationDevice(profile.uid);
      setDeviceRegistered(true);
    } catch (requestError) {
      setDeviceRegistered(false);
      setError(requestError?.message ?? 'Could not request notification permission.');
    } finally {
      setIsRegistering(false);
    }
  };

  const checkNotificationAccess = async () => {
    const currentPermission = getNotificationPermission();
    setPermission(currentPermission);
    setError('');
    if (currentPermission !== 'granted') {
      setError(getSettingsGuidance());
      return;
    }
    if (!profile?.uid) return;
    setIsRegistering(true);
    try {
      const support = await getNotificationSupportState();
      if (!support.supported) {
        throw new Error('Permission is enabled, but this browser cannot register push notifications with the current notification service.');
      }
      await registerStudentNotificationDevice(profile.uid);
      setDeviceRegistered(true);
    } catch (checkError) {
      setError(checkError?.message ?? 'Could not register this browser for notifications.');
    } finally {
      setIsRegistering(false);
    }
  };

  useEffect(() => {
    if (permission !== 'granted' || !profile?.uid || deviceRegistered) return;
    registerStudentNotificationDevice(profile.uid)
      .then(() => setDeviceRegistered(true))
      .catch((registrationError) => {
        setDeviceRegistered(false);
        setError(registrationError?.message ?? 'Could not register this browser for notifications.');
      });
  }, [deviceRegistered, permission, profile?.uid]);

  if (permission === 'granted' && deviceRegistered) return children;

  if (!requiresNotificationPermission) {
    if (aiStudio) {
      return children;
    }
    return (
      <>
        <div className="mx-auto max-w-7xl px-4 pt-4 lg:px-6">
          <div className="panel flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-slate-600">
            <div className="min-w-0 flex-1">
              <p>Enable browser notifications to receive important Examifying alerts on this device.</p>
              {permission === 'denied' ? <p className="mt-1 text-xs text-slate-500">{getSettingsGuidance()}</p> : null}
              {error ? <p className="mt-1 text-xs font-medium text-rose-700">{error}</p> : null}
            </div>
            <button type="button" className="btn-secondary" onClick={permission === 'denied' ? checkNotificationAccess : requestPermission} disabled={isRegistering || permission === 'unsupported'}>
              {isRegistering ? 'Enabling...' : permission === 'denied' ? 'Check notification access' : 'Enable notifications'}
            </button>
          </div>
        </div>
        {children}
      </>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6 text-slate-900">
      <div className="panel max-w-lg p-6 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-2xl">🔔</div>
        <h1 className="mt-5 text-2xl font-bold text-slate-950">Enable Examifying notifications</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Examifying requires browser notifications so students receive exercise, marking, payment, and learning alerts on time.
        </p>
        {permission === 'unsupported' ? (
          <p className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm font-medium text-amber-800">
            This browser does not support notifications. Please use a browser that supports notifications to access student exercises.
          </p>
        ) : null}
        {permission === 'denied' ? <p className="mt-4 rounded-2xl bg-rose-50 p-4 text-sm font-medium text-rose-700">{getSettingsGuidance()}</p> : null}
        {error ? (
          <div className="mt-4 rounded-2xl bg-rose-50 p-4 text-sm font-medium text-rose-700">
            <p>{error}</p>
            {permission !== 'unsupported' && permission !== 'denied' ? (
              <button type="button" className="mt-3 text-sm font-bold text-rose-800 underline" onClick={requestPermission} disabled={isRegistering}>
                Try again
              </button>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          className="btn-primary mt-6 w-full"
          onClick={permission === 'denied' ? checkNotificationAccess : requestPermission}
          disabled={isRegistering || permission === 'unsupported'}
        >
          {isRegistering ? 'Enabling notifications...' : permission === 'denied' ? 'Check notification access' : error ? 'Retry notifications' : 'Enable notifications'}
        </button>
        <p className="mt-4 text-xs text-slate-500">
          Access to today’s exercises and peer marking will unlock after browser permission is granted and this device is saved for push notifications.
        </p>
      </div>
    </div>
  );
};

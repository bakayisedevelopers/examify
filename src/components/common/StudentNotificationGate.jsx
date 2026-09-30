import { useEffect, useRef, useState } from 'react';
import { subscribePeerMarkingAssignmentsForStudent } from '../../services/firestoreService';
import { getNotificationSupportState, registerStudentNotificationDevice } from '../../services/notificationService';

const getNotificationPermission = () => {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
};

const buildAssignmentText = (assignment) => {
  const subject = assignment.subject ? `${assignment.subject} ` : '';
  const title = assignment.title || 'exercise';
  return `${subject}${title}`.trim();
};

export const StudentNotificationGate = ({ profile, children, required = true }) => {
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
    setIsRegistering(true);
    if (getNotificationPermission() === 'unsupported') {
      setPermission('unsupported');
      setIsRegistering(false);
      return;
    }

    try {
      const support = await getNotificationSupportState();
      if (!support.supported) {
        throw new Error('This browser cannot receive Examifying push notifications.');
      }

      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') {
        setError('Notifications are required before students can access today’s exercises. Enable browser notifications for Examifying and try again.');
        return;
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

  if (!required) {
    return (
      <>
        <div className="mx-auto max-w-7xl px-4 pt-4 lg:px-6">
          <div className="panel flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-slate-600">
            <span>Enable browser notifications to receive important Examifying alerts on this device.</span>
            <button type="button" className="btn-secondary" onClick={requestPermission} disabled={isRegistering || permission === 'unsupported' || permission === 'denied'}>
              {isRegistering ? 'Enabling...' : 'Enable notifications'}
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
        {permission === 'denied' ? (
          <p className="mt-4 rounded-2xl bg-rose-50 p-4 text-sm font-medium text-rose-700">
            Notifications are blocked in your browser settings. Open the site permissions for Examifying, allow notifications, then reload this page.
          </p>
        ) : null}
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
          onClick={requestPermission}
          disabled={isRegistering || permission === 'unsupported' || permission === 'denied'}
        >
          {isRegistering ? 'Enabling notifications...' : error ? 'Retry notifications' : 'Enable notifications'}
        </button>
        <p className="mt-4 text-xs text-slate-500">
          Access to today’s exercises and peer marking will unlock after browser permission is granted and this device is saved for push notifications.
        </p>
      </div>
    </div>
  );
};

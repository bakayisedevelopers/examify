import { useEffect, useRef, useState } from 'react';
import { subscribePeerMarkingAssignmentsForStudent } from '../../services/firestoreService';

const getNotificationPermission = () => {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
};

const buildAssignmentText = (assignment) => {
  const subject = assignment.subject ? `${assignment.subject} ` : '';
  const title = assignment.title || 'exercise';
  return `${subject}${title}`.trim();
};

export const StudentNotificationGate = ({ profile, children }) => {
  const [permission, setPermission] = useState(getNotificationPermission);
  const [error, setError] = useState('');
  const initializedRef = useRef(false);
  const seenAssignmentsRef = useRef(new Set());

  useEffect(() => {
    setPermission(getNotificationPermission());
  }, []);

  useEffect(() => {
    if (!profile?.uid || permission !== 'granted') return undefined;

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
  }, [permission, profile?.uid]);

  const requestPermission = async () => {
    setError('');
    if (getNotificationPermission() === 'unsupported') {
      setPermission('unsupported');
      return;
    }

    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') {
        setError('Notifications are required before students can access today’s exercises. Enable browser notifications for Examifying and try again.');
      }
    } catch (requestError) {
      setError(requestError?.message ?? 'Could not request notification permission.');
    }
  };

  if (permission === 'granted') return children;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6 text-slate-900">
      <div className="panel max-w-lg p-6 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-2xl">🔔</div>
        <h1 className="mt-5 text-2xl font-bold text-slate-950">Enable marking notifications</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Examifying requires browser notifications for students so you know when another learner’s submitted exercise is ready for you to mark.
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
        {error ? <p className="mt-4 rounded-2xl bg-rose-50 p-4 text-sm font-medium text-rose-700">{error}</p> : null}
        <button
          type="button"
          className="btn-primary mt-6 w-full"
          onClick={requestPermission}
          disabled={permission === 'unsupported' || permission === 'denied'}
        >
          Enable notifications
        </button>
        <p className="mt-4 text-xs text-slate-500">
          Access to today’s exercises and peer marking will unlock after permission is granted.
        </p>
      </div>
    </div>
  );
};

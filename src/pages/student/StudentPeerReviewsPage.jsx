import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { PeerReviewForm } from '../../components/dashboard/PeerReviewForm';
import { useAuth } from '../../hooks/useAuth';
import { getRoleDashboardData, getStudentAccessState, getSubmissionById, savePeerReview } from '../../services/firestoreService';
import { canSubmitPeerReview } from '../../utils/exerciseRules';
import { DEFAULT_SUBJECT } from '../../lib/constants';
import { getUserSubjects } from '../../utils/tutorSubjects';

const peerReviewViewCache = new Map();

export const StudentPeerReviewsPage = () => {
  const { profile, logout } = useAuth();
  const availableSubjects = useMemo(() => getUserSubjects(profile), [profile]);
  const firstSubject = availableSubjects[0] ?? DEFAULT_SUBJECT;
  const cacheKey = `${profile?.uid ?? 'anonymous'}:${firstSubject}`;
  const cachedView = peerReviewViewCache.get(cacheKey);
  const [assignment, setAssignment] = useState(cachedView?.assignment ?? null);
  const [submission, setSubmission] = useState(cachedView?.submission ?? null);
  const [paymentCompleted, setPaymentCompleted] = useState(cachedView?.paymentCompleted ?? null);
  const [selectedSubject, setSelectedSubject] = useState(firstSubject);
  const [isLoading, setIsLoading] = useState(!cachedView);

  useEffect(() => {
    if (availableSubjects.length && !availableSubjects.includes(selectedSubject)) {
      setSelectedSubject(availableSubjects[0]);
    }
  }, [availableSubjects, selectedSubject]);

  useEffect(() => {
    if (!profile?.uid) return undefined;

    const subjectCacheKey = `${profile.uid}:${selectedSubject}`;
    const cachedSubjectView = peerReviewViewCache.get(subjectCacheKey);
    let isCancelled = false;

    if (cachedSubjectView) {
      setAssignment(cachedSubjectView.assignment);
      setSubmission(cachedSubjectView.submission);
      setPaymentCompleted(cachedSubjectView.paymentCompleted);
      setIsLoading(false);
    } else {
      setIsLoading(true);
    }

    const load = async () => {
      const access = await getStudentAccessState(profile, selectedSubject);
      if (isCancelled) return;

      if (!access.paymentCompleted) {
        const nextView = { assignment: null, submission: null, paymentCompleted: false };
        peerReviewViewCache.set(subjectCacheKey, nextView);
        setAssignment(nextView.assignment);
        setSubmission(nextView.submission);
        setPaymentCompleted(nextView.paymentCompleted);
        setIsLoading(false);
        return;
      }

      const data = await getRoleDashboardData('student', { studentId: profile.uid, subject: selectedSubject });
      const peerAssignment = data.peerReviewAssignment ?? null;
      const peerSubmission = peerAssignment?.submissionId ? await getSubmissionById(peerAssignment.submissionId) : null;

      if (isCancelled) return;

      const nextView = {
        assignment: peerAssignment,
        submission: peerSubmission,
        paymentCompleted: true,
      };
      peerReviewViewCache.set(subjectCacheKey, nextView);
      setAssignment(nextView.assignment);
      setSubmission(nextView.submission);
      setPaymentCompleted(nextView.paymentCompleted);
      setIsLoading(false);
    };

    load().catch((error) => {
      console.error('[Examifying][PeerReviews] load:error', error);
      if (!isCancelled) setIsLoading(false);
    });

    return () => {
      isCancelled = true;
    };
  }, [profile, selectedSubject]);

  return (
    <AppShell title="Peer reviews" subtitle="Review a classmate’s uploaded answer after you have submitted your own work." role="student" user={profile} onLogout={logout}>
      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-semibold text-slate-950">Subject</p>
          <p className="text-xs text-slate-500">Peer review context follows the selected subject.</p>
        </div>
        <select className="input max-w-xs" value={selectedSubject} onChange={(event) => setSelectedSubject(event.target.value)} disabled={!availableSubjects.length}>
          {availableSubjects.map((subject) => <option key={subject}>{subject}</option>)}
        </select>
      </div>
      {isLoading ? <div className="panel p-5 text-sm text-slate-500">Loading peer review context...</div> : null}
      {!isLoading && paymentCompleted === false ? <div className="panel p-5 text-sm text-amber-700">Payment is required before peer review activities unlock.</div> : null}
      {!isLoading ? <PeerReviewForm
        submission={submission}
        canReview={Boolean(paymentCompleted) && canSubmitPeerReview(assignment ?? {})}
        onSubmit={(payload) =>
          savePeerReview({
            ...payload,
            reviewerId: profile?.uid,
            submissionId: assignment?.submissionId,
            assignmentDate: assignment?.assignmentDate,
            subject: selectedSubject,
          })
        }
      /> : null}
    </AppShell>
  );
};

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { PeerReviewForm } from '../../components/dashboard/PeerReviewForm';
import { useAuth } from '../../hooks/useAuth';
import {
  completePeerMarkingAssignment,
  getActiveSubjectEpisodesForStudent,
  getPeerMarkingAssignmentsForStudent,
  getStudentEntitlementState,
} from '../../services/firestoreService';
import { uploadPeerReviewImage } from '../../services/storageService';
import { DEFAULT_SUBJECT } from '../../lib/constants';

export const StudentPeerReviewsPage = () => {
  const { profile, logout } = useAuth();
  const [availableSubjects, setAvailableSubjects] = useState([]);
  const [availableSubjectEpisodes, setAvailableSubjectEpisodes] = useState([]);
  const [selectedSubject, setSelectedSubject] = useState(DEFAULT_SUBJECT);
  const [assignment, setAssignment] = useState(null);
  const [paymentCompleted, setPaymentCompleted] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!profile?.uid) return undefined;
    let active = true;
    getActiveSubjectEpisodesForStudent(profile.uid).then((episodes) => {
      if (!active) return;
      const subjects = [...new Set(episodes.map((episode) => episode.subjectKey).filter(Boolean))].sort();
      setAvailableSubjectEpisodes(episodes);
      setAvailableSubjects(subjects);
      if (subjects.length && !subjects.includes(selectedSubject)) setSelectedSubject(subjects[0]);
    }).catch((error) => setStatus(error.message || 'Could not load your active subjects.'));
    return () => { active = false; };
  }, [profile?.uid]);

  useEffect(() => {
    if (!profile?.uid || !selectedSubject) return undefined;
    let active = true;
    setIsLoading(true);
    setStatus('');
    const episode = availableSubjectEpisodes.find((item) => item.studentId === profile.uid && item.subjectKey === selectedSubject) ?? null;
    Promise.all([
      getStudentEntitlementState(profile, selectedSubject, episode),
      getPeerMarkingAssignmentsForStudent(profile.uid),
    ]).then(([access, assignments]) => {
      if (!active) return;
      setPaymentCompleted(Boolean(access.paidSubscriptionActive));
      setAssignment(assignments.find((item) => item.subject === selectedSubject) ?? null);
    }).catch((error) => {
      if (active) setStatus(error.message || 'Could not load peer marking.');
    }).finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [profile, selectedSubject, availableSubjectEpisodes]);

  const submitMarkedPages = async (files) => {
    if (!assignment || !profile?.uid) throw new Error('No peer marking assignment is available.');
    setIsSubmitting(true);
    setStatus('Uploading marked pages...');
    try {
      const reviewImages = await Promise.all(files.map(async (file, index) => {
        const upload = await uploadPeerReviewImage({
          file,
          studentId: profile.uid,
          exerciseId: assignment.reviewerExerciseId,
          subjectInstanceId: assignment.reviewerSubjectInstanceId,
        });
        return { ...upload, pageNumber: index + 1 };
      }));
      await completePeerMarkingAssignment({
        assignmentId: assignment.id,
        assignmentPath: assignment.assignmentPath,
        reviewerId: profile.uid,
        reviewImages,
      });
      setAssignment(null);
      setStatus('Peer marking submitted successfully.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const images = assignment?.submittedImages?.length
    ? assignment.submittedImages
    : assignment?.submittedImageUrl ? [{ url: assignment.submittedImageUrl }] : [];

  return (
    <AppShell title="Peer marking" subtitle="Mark a classmate’s handwritten answers and upload the marked pages." role="student" user={profile} onLogout={logout}>
      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-semibold text-slate-950">Subject</p>
          <p className="text-xs text-slate-500">Assignments are tied to an active subject episode.</p>
        </div>
        <select className="input max-w-xs" value={selectedSubject} onChange={(event) => setSelectedSubject(event.target.value)} disabled={!availableSubjects.length}>
          {availableSubjects.map((subject) => <option key={subject}>{subject}</option>)}
        </select>
      </div>
      {status ? <div role="status" className="panel p-4 text-sm text-slate-600">{status}</div> : null}
      {isLoading ? <div className="panel p-5 text-sm text-slate-500">Loading peer marking...</div> : null}
      {!isLoading && paymentCompleted === false ? <div className="panel p-5 text-sm text-amber-700">An active paid subject is required before peer marking unlocks.</div> : null}
      {!isLoading && paymentCompleted && !assignment ? <div className="panel p-5 text-sm text-slate-500">No peer marking assignment is available for this subject yet.</div> : null}
      {!isLoading && assignment ? <PeerReviewForm
        key={assignment.id}
        submission={{ images, imageUrl: images[0]?.url, exerciseTitle: assignment.title || 'Maths exercise' }}
        canReview={Boolean(paymentCompleted && assignment.status === 'assigned' && !isSubmitting)}
        onSubmit={submitMarkedPages}
      /> : null}
    </AppShell>
  );
};

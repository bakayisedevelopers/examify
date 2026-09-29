import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { MarkingCanvas as ImageEditor } from '../../components/canvas/pictureEditorCanvas';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { canOpenExercise, getExerciseAvailability } from '../../utils/exerciseRules';
import {
  generateExercisePlanIfEligible,
  completePeerMarkingAssignment,
  getPeerMarkingAssignmentsForStudent,
  getStudentAccessState,
  getTodayExercise,
} from '../../services/firestoreService';
import { uploadPeerReviewImage } from '../../services/storageService';
import { DEFAULT_SUBJECT } from '../../lib/constants';
import { getUserSubjects } from '../../utils/tutorSubjects';

const TodayExerciseCard = ({ exercise, onOpen }) => {
  const submitted = Boolean(exercise.submittedImageUrl || exercise.submitted === 'Yes');
  const availability = getExerciseAvailability(exercise.assignmentDate, submitted);

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!canOpenExercise(exercise.assignmentDate)}
      className="panel w-full p-5 text-left transition hover:-translate-y-0.5 hover:shadow-soft disabled:cursor-not-allowed disabled:opacity-70"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">{exercise.subject ?? DEFAULT_SUBJECT}</span>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{availability.label}</span>
      </div>
      <h3 className="mt-4 text-xl font-bold text-slate-950">{exercise.title}</h3>
      <p className="mt-2 text-sm font-semibold text-accent">{exercise.topic}</p>
      <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-500">{exercise.instruction}</p>
      <div className="mt-4 flex items-center justify-between gap-3 text-xs uppercase tracking-[0.25em] text-slate-400">
        <span>{exercise.assignmentDate}</span>
        <span>{canOpenExercise(exercise.assignmentDate) ? 'Open exercise' : 'Locked'}</span>
      </div>
    </button>
  );
};

export const StudentDashboardPage = () => {
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const availableSubjects = useMemo(() => {
    const subjects = getUserSubjects(profile);
    return subjects.length ? subjects : [DEFAULT_SUBJECT];
  }, [profile]);
  const [todayExercises, setTodayExercises] = useState([]);
  const [peerAssignments, setPeerAssignments] = useState([]);
  const [activeTab, setActiveTab] = useState('exercises');
  const [markSubjectFilter, setMarkSubjectFilter] = useState('all');
  const [reviewingAssignment, setReviewingAssignment] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [paymentLocked, setPaymentLocked] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [generationMessage, setGenerationMessage] = useState('');

  useEffect(() => {
    let active = true;

    const runGeneratePlan = async (subject, mode) => {
      setIsGenerating(true);
      setGenerationProgress(25);
      setGenerationMessage(`${subject}: ${mode === 'initial' ? 'Initial' : 'Weekly'} AI generation started...`);

      const result = await generateExercisePlanIfEligible({
        student: profile,
        mode,
        subject,
        onProgress: (message) => setGenerationMessage(`${subject}: ${message}`),
      });

      setGenerationProgress(75);
      if (result?.generated) {
        setGenerationMessage(`${subject}: generated ${result.assignments?.length ?? 0} exercise(s).`);
      } else {
        setGenerationMessage(`${subject}: ${result?.reason ?? 'generation criteria not met'}.`);
      }
      return result;
    };

    const load = async () => {
      if (!profile?.uid) return;
      try {
        setLoadError('');
        const loadedExercises = [];
        let anyPaidSubject = false;

        for (const subject of availableSubjects) {
          const access = await getStudentAccessState(profile, subject);
          anyPaidSubject = anyPaidSubject || Boolean(access.paymentCompleted);

          if (access.paymentCompleted && access.initialGenerationReady) {
            await runGeneratePlan(subject, 'initial');
          } else if (access.paymentCompleted && access.weeklyGenerationReady) {
            await runGeneratePlan(subject, 'weekly');
          }

          const today = await getTodayExercise(profile.uid, subject);
          if (today) loadedExercises.push(today);
        }

        if (!active) return;
        setPaymentLocked(!anyPaidSubject);
        setTodayExercises(loadedExercises.sort((left, right) => String(left.subject).localeCompare(String(right.subject))));
        setPeerAssignments(await getPeerMarkingAssignmentsForStudent(profile.uid));
        setGenerationProgress(100);
      } catch (error) {
        if (!active) return;
        setTodayExercises([]);
        setLoadError(error?.message ?? 'Some exercises could not be loaded yet.');
      } finally {
        if (active) setTimeout(() => setIsGenerating(false), 500);
      }
    };

    load();
    return () => { active = false; };
  }, [availableSubjects, profile]);

  const markSubjects = [...new Set(peerAssignments.map((assignment) => assignment.subject).filter(Boolean))];
  const visiblePeerAssignments = peerAssignments.filter((assignment) => markSubjectFilter === 'all' || assignment.subject === markSubjectFilter);

  const handleSavePeerMarking = async (file) => {
    if (!reviewingAssignment) return;
    const reviewFileName = (reviewingAssignment.submittedFileName || 'submission.png').replace(/\.[^/.]+$/, '-peer-review.png');
    const renamedFile = new File([file], reviewFileName, { type: file.type });
    const upload = await uploadPeerReviewImage({ file: renamedFile, studentId: profile.uid, exerciseId: reviewingAssignment.exerciseId });
    await completePeerMarkingAssignment({ assignmentId: reviewingAssignment.id, reviewImageUrl: upload.url, reviewFileName: upload.fileName });
    setPeerAssignments(await getPeerMarkingAssignmentsForStudent(profile.uid));
    setReviewingAssignment(null);
  };

  return (
    <AppShell
      title="Today’s exercises"
      subtitle="Open today’s exercise, view the exact question pages, and submit your work from the exercise details page."
      role="student"
      user={profile}
      onLogout={logout}
    >
      {loadError ? <div className="panel p-4 text-sm text-amber-700">{loadError}</div> : null}

      {isGenerating ? (
        <div className="panel p-4">
          <p className="font-medium text-slate-700">{generationMessage}</p>
          <div className="mt-3 h-2 w-full rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-brand-600 transition-all duration-300" style={{ width: `${Math.min(100, Math.max(0, generationProgress))}%` }} />
          </div>
        </div>
      ) : null}

      <div className="panel mx-auto flex w-fit justify-center gap-2 p-2">
        <button type="button" className={activeTab === 'exercises' ? 'btn-primary' : 'btn-secondary'} onClick={() => setActiveTab('exercises')}>Exercises</button>
        <button type="button" className={activeTab === 'mark' ? 'btn-primary' : 'btn-secondary'} onClick={() => setActiveTab('mark')}>Mark</button>
      </div>

      {activeTab === 'exercises' ? (
        <>
          <SectionHeader
            eyebrow="Exercises"
            title="Due today"
            description="Each card shows the subject and opens the exercise details page for uploads and paper links."
          />
          <section className="grid gap-4 lg:grid-cols-2">
            {!paymentLocked && todayExercises.length ? todayExercises.map((exercise) => (
              <TodayExerciseCard
                key={exercise.id}
                exercise={exercise}
                onOpen={() => navigate(`/student/exercises/${exercise.id}`)}
              />
            )) : (
              <div className="panel col-span-full flex min-h-72 items-center justify-center p-6 text-center text-sm text-slate-500">
                {paymentLocked ? 'Exercises are locked until payment is complete.' : 'No exercises have been assigned for today yet.'}
              </div>
            )}
          </section>
        </>
      ) : (
        <>
          <SectionHeader eyebrow="Peer marking" title="Work to mark" description="Mark submitted work from learners in your grade and subject." />
          <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="text-sm font-semibold text-slate-950">Filter marking work</p>
            <select className="input max-w-xs" value={markSubjectFilter} onChange={(event) => setMarkSubjectFilter(event.target.value)}>
              <option value="all">All subjects</option>
              {markSubjects.map((subject) => <option key={subject}>{subject}</option>)}
            </select>
          </div>
          <section className="grid gap-4">
            {visiblePeerAssignments.map((assignment) => (
              <div key={assignment.id} className="panel p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-950">{assignment.title || 'Exercise submission'}</p>
                    <p className="mt-1 text-sm text-slate-500">{assignment.subject} • {assignment.grade} • {assignment.assignmentDate}</p>
                    <p className="mt-2 text-sm text-slate-600">{assignment.topic}</p>
                  </div>
                  <button type="button" className="btn-primary" onClick={() => setReviewingAssignment(assignment)}>Mark</button>
                </div>
                {reviewingAssignment?.id === assignment.id ? (
                  <div className="mt-4">
                    <ImageEditor imageUrl={assignment.submittedImageUrl} onSave={handleSavePeerMarking} />
                    <button type="button" className="btn-secondary mt-2" onClick={() => setReviewingAssignment(null)}>Cancel</button>
                  </div>
                ) : null}
              </div>
            ))}
            {!visiblePeerAssignments.length ? <div className="panel p-5 text-sm text-slate-500">No one to mark for yet. When learners in your grade and subject submit, marking work will appear here.</div> : null}
          </section>
        </>
      )}
    </AppShell>
  );
};

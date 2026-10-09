import { useEffect, useState } from 'react';
import { CalendarDays, FileText, Lock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { SubmissionUpload } from './SubmissionUpload';
import { ExerciseStatusBadges } from './ExerciseStatusBadges';
import { deleteExerciseSubmissionFiles, uploadSubmissionImages, uploadTutorMarkedWork } from '../../services/storageService';
import { getQuestionPapersByIds, saveTutorMarkedExercise } from '../../services/firestoreService';
import { MarkingCanvas as ImageEditor } from '../canvas/pictureEditorCanvas';
import { ImagePageViewer } from '../common/ImagePageViewer';
import { ExerciseTopicScoresTable } from './ExerciseTopicScoresTable';
import { OperationStatusOverlay } from '../common/OperationStatusOverlay';
import { useOperationStatus } from '../../hooks/useOperationStatus';

const imagePages = (images, fallbackUrl, fallbackName) => Array.isArray(images) && images.length
  ? images
  : fallbackUrl ? [{ url: fallbackUrl, fileName: fallbackName || '' }] : [];

export const ExerciseCard = ({
  exercise,
  availability,
  paymentLocked,
  studentId,
  tutorId,
  topicScores = {},
  scoreEntries = [],
  completedMarkingAssignments = [],
  onTopicScoreSaved,
  showQuestionLinks = false,
  viewerRole = 'student',
  accessRole = 'co-owner',
  isHistorical = false,
}) => {
  const navigate = useNavigate();
  const exerciseQuestionCount = Array.isArray(exercise?.questions) && exercise.questions.length
    ? exercise.questions.length
    : Array.isArray(exercise?.questionLinks) && exercise.questionLinks.length
      ? exercise.questionLinks.length
      : Array.isArray(exercise?.questionReferences) ? exercise.questionReferences.length : 0;
  const [openingPapers, setOpeningPapers] = useState(false);
  const [markedImages, setMarkedImages] = useState(() => imagePages(exercise.tutorMarkedImages, exercise.tutorMarkedImageUrl, exercise.tutorMarkedFileName));
  const peerMarkedImages = imagePages(exercise.peerMarkedImages, exercise.peerMarkedImageUrl ?? exercise.submittedReviewImageUrl ?? exercise.reviewImageUrl, exercise.peerMarkedFileName ?? exercise.submittedReviewFileName);
  const peerMarkingImages = imagePages(exercise.peerMarkingImages, exercise.peerMarkingImageUrl, exercise.peerMarkingFileName);
  const [studentSubmissionImages, setStudentSubmissionImages] = useState(() => imagePages(exercise.submittedImages, exercise.submittedImageUrl, exercise.submittedFileName));
  const [studentSubmissionUrl, setStudentSubmissionUrl] = useState(exercise.submittedImageUrl ?? '');
  const [studentSubmissionFileName, setStudentSubmissionFileName] = useState(exercise.submittedFileName ?? '');
  const [isTutorMarking, setIsTutorMarking] = useState(false);
  const [markStatus, setMarkStatus] = useState('');
  const [openViewer, setOpenViewer] = useState('');
  const { operationStatus, runOperation, closeOperationStatus } = useOperationStatus();

  useEffect(() => {
    setMarkedImages(imagePages(exercise.tutorMarkedImages, exercise.tutorMarkedImageUrl, exercise.tutorMarkedFileName));
    setStudentSubmissionImages(imagePages(exercise.submittedImages, exercise.submittedImageUrl, exercise.submittedFileName));
    setStudentSubmissionUrl(exercise.submittedImageUrl ?? '');
    setStudentSubmissionFileName(exercise.submittedFileName ?? '');
    setOpenViewer('');
  }, [exercise.id, exercise.submittedImageUrl, exercise.submittedFileName, exercise.submittedImages, exercise.tutorMarkedFileName, exercise.tutorMarkedImageUrl, exercise.tutorMarkedImages]);

  const handleOpenPapers = async (targetExercise = exercise) => {
    const firstLink = Array.isArray(targetExercise?.questionLinks) ? targetExercise.questionLinks[0] : null;
    if (firstLink?.paperId) {
      const page = Math.max(1, Number(firstLink.pageNumber ?? 1) || 1);
      const params = new URLSearchParams({ page: String(page) });
      if (firstLink.questionReference) params.set('question', firstLink.questionReference);
      navigate(`/${viewerRole}/papers/${firstLink.paperId}?${params.toString()}`);
      return;
    }

    if (!targetExercise?.paperIds?.length) return;
    setOpeningPapers(true);
    try {
      const papers = await getQuestionPapersByIds(targetExercise.paperIds);
      const firstPaper = papers[0];
      if (firstPaper?.id) navigate(`/${viewerRole}/papers/${firstPaper.id}?page=1`);
    } catch {
      // Opening the linked papers is best-effort; preserve the exercise card state.
    } finally {
      setOpeningPapers(false);
    }
  };

  const handleSaveTutorMark = async (files) => runOperation({
    operationName: 'Saving tutor-marked work',
    successMessage: 'The marked pages were uploaded and saved successfully.',
    failureMessage: 'Could not save marked work.',
  }, async () => {
    const uploads = [];
    setMarkStatus('Saving marked work...');
    try {
      const newMarkedImages = await Promise.all(files.map(async (file, index) => {
        const upload = await uploadTutorMarkedWork({ file, studentId: exercise.studentId, exerciseId: exercise.id, subjectInstanceId: exercise.subjectInstanceId });
        uploads.push(upload);
        return { ...upload, pageNumber: index + 1 };
      }));
      await saveTutorMarkedExercise({ tutorId, exerciseId: exercise.id, markedImages: newMarkedImages });
      setMarkedImages(newMarkedImages);
      setMarkStatus('Marked work saved and completed.');
      setIsTutorMarking(false);
      return newMarkedImages;
    } catch (error) {
      await deleteExerciseSubmissionFiles(uploads.map((upload) => upload.url));
      setMarkStatus(error.message || 'Could not save marked work.');
      throw error;
    }
  });

  const handleStudentSubmit = async ({ files, exerciseId }) => runOperation({
    operationName: 'Submitting exercise work',
    successMessage: 'Your work was uploaded and the submission was saved.',
    failureMessage: 'Could not submit your exercise work.',
  }, async () => {
    const result = await uploadSubmissionImages({ files, exerciseId, studentId, subjectInstanceId: exercise.subjectInstanceId });
    setStudentSubmissionUrl(result.submittedImageUrl);
    setStudentSubmissionFileName(result.submittedFileName);
    setStudentSubmissionImages(result.submittedImages ?? imagePages([], result.submittedImageUrl, result.submittedFileName));
    return result;
  });

  const hasMarkingImages = peerMarkingImages.length || peerMarkedImages.length || markedImages.length;
  const hasSubmittedImages = studentSubmissionImages.length > 0;
  const canTutorAct = viewerRole === 'tutor' && accessRole !== 'viewer' && !isHistorical;
  const canEditTopicScores = canTutorAct && hasSubmittedImages;

  return (
    <div className="w-full space-y-5">
      <section className="space-y-4">
        <div className="rounded-2xl bg-gradient-to-r from-lime-300 via-lime-400 to-emerald-400 p-5 text-slate-950 shadow-soft sm:p-6">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-950/70">Exercise</p>
          <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Work to Complete</h2>
          <p className="mt-2 max-w-2xl text-sm text-emerald-950/80">Review the exercise details and question pages. Students can submit their work here.</p>
        </div>
        <div className="panel space-y-5 p-5 sm:p-6">

        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
          <span className="inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1 font-semibold text-brand-700"><CalendarDays className="h-4 w-4" />{exercise.assignmentDate}</span>
          <ExerciseStatusBadges exercise={exercise} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-2xl font-bold text-slate-950">{exercise.title}</h3>
          {exerciseQuestionCount > 0 ? <span className="rounded-full bg-lime-100 px-3 py-1 text-sm font-semibold text-lime-800">{exerciseQuestionCount} {exerciseQuestionCount === 1 ? 'question' : 'questions'}</span> : null}
        </div>
        <p className="text-sm font-semibold text-accent">{exercise.topic}</p>
        {exercise.sourceLabel ? <p className="text-sm text-slate-500">{exercise.sourceLabel}</p> : null}
        <p className="text-sm leading-7 text-slate-600">{exercise.instruction}</p>

        {showQuestionLinks && Array.isArray(exercise?.questionLinks) && exercise.questionLinks.length > 0 ? (
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-800">Question pages</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {exercise.questionLinks.map((link, index) => {
                const page = Math.max(1, Number(link.pageNumber ?? 1) || 1);
                const params = new URLSearchParams({ page: String(page) });
                if (link.questionReference) params.set('question', link.questionReference);
                return <button key={`${link.paperId}-${link.questionReference}-${index}`} type="button" onClick={() => navigate(`/${viewerRole}/papers/${link.paperId}?${params.toString()}`)} className="btn-secondary px-3 py-2 text-sm">
                  {link.questionReference || `Question ${index + 1}`} • page {page}{Number(link.marks) > 0 ? ` • ${link.marks} marks` : ''}
                </button>;
              })}
            </div>
          </div>
        ) : null}

        {exercise?.paperIds?.length > 0 ? <button type="button" onClick={() => handleOpenPapers(exercise)} disabled={openingPapers} className="btn-secondary inline-flex items-center gap-2">
          <FileText className="h-4 w-4" />{openingPapers ? 'Opening...' : 'View Question Papers'}
        </button> : null}

        {viewerRole === 'student' ? (
          <div className="space-y-4 border-t border-slate-200 pt-4">
            {availability.state === 'active' ? (
              !(studentSubmissionUrl && studentSubmissionFileName) && !paymentLocked && exercise ? (
                <SubmissionUpload exerciseId={exercise.id} onSubmit={handleStudentSubmit} exercise={exercise} />
              ) : !(studentSubmissionUrl && studentSubmissionFileName) ? (
                <div className="panel flex min-h-36 items-center justify-center p-6 text-center text-sm text-slate-500">Uploads unlock only after payment is complete and an exercise has been assigned.</div>
              ) : null
            ) : !(studentSubmissionUrl && studentSubmissionFileName) ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-500"><Lock className="h-4 w-4" />Submission unavailable</span>
            ) : null}
            {hasSubmittedImages ? <div className="flex flex-wrap items-center gap-3">
              {studentSubmissionUrl ? <span className="text-sm font-semibold text-lime-800">Work submitted ✓</span> : null}
              <button type="button" className="btn-secondary px-3 py-2 text-sm" onClick={() => setOpenViewer((current) => current === 'submission' ? '' : 'submission')}>
                {openViewer === 'submission' ? 'Close Submitted Work' : 'Open Submitted Work'}
              </button>
            </div> : null}
            {openViewer === 'submission' ? <ImagePageViewer images={studentSubmissionImages} title="Your submitted work" /> : null}
          </div>
        ) : null}
        </div>
      </section>

      {viewerRole === 'tutor' && hasSubmittedImages ? (
        <section className="space-y-4">
          <div className="rounded-2xl bg-gradient-to-r from-lime-300 via-lime-400 to-emerald-400 p-5 text-slate-950 shadow-soft sm:p-6">
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-950/70">Tutor review</p>
            <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Work to Mark</h2>
            <p className="mt-2 max-w-2xl text-sm text-emerald-950/80">Open the student’s submitted pages or use the existing marking tools.</p>
          </div>
          <div className="panel space-y-4 p-5 sm:p-6">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary px-3 py-2 text-sm" onClick={() => setOpenViewer((current) => current === 'submission' ? '' : 'submission')}>
              {openViewer === 'submission' ? 'Close Submitted Work' : 'Open Submitted Work'}
            </button>
            {hasMarkingImages ? <button type="button" className="btn-secondary px-3 py-2 text-sm" onClick={() => setOpenViewer((current) => current === 'marking' ? '' : 'marking')}>
              {openViewer === 'marking' ? 'Close Marking' : 'Open Marking'}
            </button> : null}
            {canEditTopicScores && !markedImages.length && !isTutorMarking ? <button type="button" className="btn-primary px-3 py-2 text-sm" onClick={() => setIsTutorMarking(true)} disabled={!tutorId}>Mark student work</button> : null}
          </div>
          {openViewer === 'submission' ? <ImagePageViewer images={studentSubmissionImages} title="Student's original work" alt="Unmarked student exercise work" /> : null}
          {openViewer === 'marking' ? <div className="grid gap-5 lg:grid-cols-2">
            {peerMarkingImages.length ? <ImagePageViewer images={peerMarkingImages} title="Student's marking of another learner's work" alt="Peer marking submitted by this student" /> : null}
            {peerMarkedImages.length ? <ImagePageViewer images={peerMarkedImages} title="Peer-marked version of this exercise" alt="Peer markings on this student's work" /> : null}
            {markedImages.length ? <ImagePageViewer images={markedImages} title="Tutor-marked work" alt="Tutor annotations on the student's exercise work" /> : null}
          </div> : null}
          {canEditTopicScores && isTutorMarking ? <ImageEditor imageUrls={studentSubmissionImages} onSave={handleSaveTutorMark} onCancel={() => setIsTutorMarking(false)} saveLabel="Save marked work" /> : null}
          {markStatus ? <p role="status" className="text-sm text-slate-600">{markStatus}</p> : null}
          </div>
        </section>
      ) : null}

      {viewerRole === 'student' && hasMarkingImages ? (
        <section className="space-y-4">
          <div className="rounded-2xl bg-gradient-to-r from-lime-300 via-lime-400 to-emerald-400 p-5 text-slate-950 shadow-soft sm:p-6">
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-950/70">Peer marking</p>
            <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Work to Mark</h2>
            <p className="mt-2 max-w-2xl text-sm text-emerald-950/80">Open completed marking work and feedback for this exercise.</p>
          </div>
          <div className="panel space-y-4 p-5 sm:p-6">
          <button type="button" className="btn-secondary px-3 py-2 text-sm" onClick={() => setOpenViewer((current) => current === 'marking' ? '' : 'marking')}>
            {openViewer === 'marking' ? 'Close Marking' : 'Open Marking'}
          </button>
          {openViewer === 'marking' ? <div className="grid gap-5 lg:grid-cols-2">
            {peerMarkingImages.length ? <ImagePageViewer images={peerMarkingImages} title="Your marking of another learner's work" alt="Peer marking you submitted" /> : null}
            {markedImages.length ? <ImagePageViewer images={markedImages} title="Tutor-marked work" alt="Tutor-marked version of your exercise work" /> : null}
            {peerMarkedImages.length ? <ImagePageViewer images={peerMarkedImages} title="Peer-marked work on your submission" alt="Peer-marked version of your exercise work" /> : null}
          </div> : null}
          </div>
        </section>
      ) : null}

      <ExerciseTopicScoresTable
        exercise={exercise}
        viewerRole={viewerRole}
        tutorId={tutorId}
        studentId={exercise.studentId || studentId}
        topicScores={topicScores}
        scoreEntries={scoreEntries}
        completedMarkingAssignments={completedMarkingAssignments}
        canEditScores={canEditTopicScores}
        canEditMarkingScores={canTutorAct}
        onTopicScoreSaved={onTopicScoreSaved}
      />
      <OperationStatusOverlay
        state={operationStatus?.state}
        operationName={operationStatus?.operationName}
        message={operationStatus?.message}
        onDone={closeOperationStatus}
      />
    </div>
  );
};

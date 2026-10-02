import { CalendarDays, Lock, FileText } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubmissionUpload } from './SubmissionUpload';
import { deleteExerciseSubmissionFiles, uploadSubmissionImages, uploadTutorMarkedWork } from '../../services/storageService';
import { getQuestionPapersByIds, saveTutorMarkedExercise } from '../../services/firestoreService';
import { MarkingCanvas as ImageEditor } from '../canvas/pictureEditorCanvas';
import { TutorTopicScoreEditor } from '../tutor/TutorTopicScoreEditor';
import { ImagePageViewer } from '../common/ImagePageViewer';

const imagePages = (images, fallbackUrl, fallbackName) => Array.isArray(images) && images.length
  ? images
  : fallbackUrl ? [{ url: fallbackUrl, fileName: fallbackName || '' }] : [];

export const ExerciseCard = ({ exercise, availability, paymentLocked, studentId, tutorId, topicScores = {}, onTopicScoreSaved, showQuestionLinks = false, viewerRole = 'student', accessRole = 'co-owner' }) => {
  const navigate = useNavigate();
  const [openingPapers, setOpeningPapers] = useState(false);
  const [markedImages, setMarkedImages] = useState(() => imagePages(exercise.tutorMarkedImages, exercise.tutorMarkedImageUrl, exercise.tutorMarkedFileName));
  const peerMarkedImages = imagePages(exercise.peerMarkedImages, exercise.peerMarkedImageUrl ?? exercise.submittedReviewImageUrl ?? exercise.reviewImageUrl, exercise.peerMarkedFileName ?? exercise.submittedReviewFileName);
  const peerMarkingImages = imagePages(exercise.peerMarkingImages, exercise.peerMarkingImageUrl, exercise.peerMarkingFileName);
  const [studentSubmissionImages, setStudentSubmissionImages] = useState(() => imagePages(exercise.submittedImages, exercise.submittedImageUrl, exercise.submittedFileName));
  const [studentSubmissionUrl, setStudentSubmissionUrl] = useState(exercise.submittedImageUrl ?? '');
  const [studentSubmissionFileName, setStudentSubmissionFileName] = useState(exercise.submittedFileName ?? '');
  const [isTutorMarking, setIsTutorMarking] = useState(false);
  const [markStatus, setMarkStatus] = useState('');

  useEffect(() => {
    setMarkedImages(imagePages(exercise.tutorMarkedImages, exercise.tutorMarkedImageUrl, exercise.tutorMarkedFileName));
    setStudentSubmissionImages(imagePages(exercise.submittedImages, exercise.submittedImageUrl, exercise.submittedFileName));
    setStudentSubmissionUrl(exercise.submittedImageUrl ?? '');
    setStudentSubmissionFileName(exercise.submittedFileName ?? '');
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
      if (firstPaper?.id) {
        navigate(`/${viewerRole}/papers/${firstPaper.id}?page=1`);
      }
    } catch (error) {
      console.error('Failed to open papers:', error);
    } finally {
      setOpeningPapers(false);
    }
  };

  const handleSaveTutorMark = async (files) => {
    const uploads = [];
    setMarkStatus('Saving marked work...');
    try {
      const markedImages = await Promise.all(files.map(async (file, index) => {
        const upload = await uploadTutorMarkedWork({ file, studentId: exercise.studentId, exerciseId: exercise.id, subjectInstanceId: exercise.subjectInstanceId });
        uploads.push(upload);
        return { ...upload, pageNumber: index + 1 };
      }));
      await saveTutorMarkedExercise({
        tutorId,
        exerciseId: exercise.id,
        markedImages,
      });
      setMarkedImages(markedImages);
      setMarkStatus('Marked work saved and completed.');
      setIsTutorMarking(false);
    } catch (error) {
      await deleteExerciseSubmissionFiles(uploads.map((upload) => upload.url));
      setMarkStatus(error.message || 'Could not save marked work.');
      throw error;
    }
  };

  const handleStudentSubmit = async ({ files, exerciseId }) => {
    const result = await uploadSubmissionImages({ files, exerciseId, studentId, subjectInstanceId: exercise.subjectInstanceId });
    setStudentSubmissionUrl(result.submittedImageUrl);
    setStudentSubmissionFileName(result.submittedFileName);
    setStudentSubmissionImages(result.submittedImages ?? imagePages([], result.submittedImageUrl, result.submittedFileName));
    return result;
  };



  return (
    <div className="panel p-6 w-full">
      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
        <span className="inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1 font-semibold text-brand-700">
          <CalendarDays className="h-4 w-4" />
          {exercise.assignmentDate}
        </span>
        <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-600">{availability.label}</span>
      </div>
      <h3 className="mt-4 text-2xl font-bold text-slate-950">{exercise.title}</h3>
      <p className="mt-2 text-sm font-semibold text-accent">{exercise.topic}</p>
      <p className="mt-3 text-sm text-slate-500">{exercise.sourceLabel}</p>
      <p className="mt-4 text-sm leading-7 text-slate-600">{exercise.instruction}</p>
      {showQuestionLinks && Array.isArray(exercise?.questionLinks) && exercise.questionLinks.length > 0 && (
        <div className="mt-4 rounded-2xl bg-slate-50 p-4">
          <p className="text-sm font-semibold text-slate-800">Question pages</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {exercise.questionLinks.map((link, index) => {
              const page = Math.max(1, Number(link.pageNumber ?? 1) || 1);
              const params = new URLSearchParams({ page: String(page) });
              if (link.questionReference) params.set('question', link.questionReference);
              return (
                <button
                  key={`${link.paperId}-${link.questionReference}-${index}`}
                  type="button"
                  onClick={() => navigate(`/${viewerRole}/papers/${link.paperId}?${params.toString()}`)}
                  className="btn-secondary px-3 py-2 text-sm"
                >
                  {link.questionReference || `Question ${index + 1}`} • page {page}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {exercise?.paperIds?.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => handleOpenPapers(exercise)}
            disabled={openingPapers}
            className="btn-secondary inline-flex items-center gap-2"
          >
            <FileText className="h-4 w-4" />
            {openingPapers ? 'Opening...' : 'View Question Papers'}
          </button>
        </div>
      )}
      {viewerRole === 'tutor' && studentSubmissionImages.length ? (
        <section className="mt-6 space-y-4 border-t border-slate-200 pt-5">
          <h4 className="font-semibold text-slate-900">Student work and marking</h4>
          {accessRole !== 'viewer' ? <div className="space-y-2">
            <p className="text-sm font-medium text-slate-600">Manual topic understanding scores</p>
            {[...new Set((Array.isArray(exercise.topicBreakdown) && exercise.topicBreakdown.length
              ? exercise.topicBreakdown.map((item) => item.topic)
              : String(exercise.topic || '').split('|')).map((topic) => String(topic || '').trim()).filter(Boolean))].map((topic) => (
              <TutorTopicScoreEditor
                key={topic}
                tutorId={tutorId}
                studentId={exercise.studentId || studentId}
                subject={exercise.subject}
                topic={topic}
                exerciseId={exercise.id}
                value={topicScores[topic]}
                onSaved={onTopicScoreSaved}
              />
            ))}
          </div> : null}
          <div className="grid gap-5 lg:grid-cols-2">
            <ImagePageViewer images={studentSubmissionImages} title="Student's original work" alt="Unmarked student exercise work" />
            <ImagePageViewer images={peerMarkingImages} title="Student's marking of another learner's work" alt="Peer marking submitted by this student" />
            <ImagePageViewer images={peerMarkedImages} title="Peer-marked version of this exercise" alt="Peer markings on this student's work" />
            <ImagePageViewer images={markedImages} title="Tutor-marked work" alt="Tutor annotations on the student's exercise work" />
          </div>
          {accessRole !== 'viewer' && !markedImages.length && !isTutorMarking ? (
            <button type="button" className="btn-secondary" onClick={() => setIsTutorMarking(true)} disabled={!tutorId}>Mark student work</button>
          ) : null}
          {accessRole !== 'viewer' && isTutorMarking ? (
            <div>
              <ImageEditor imageUrls={studentSubmissionImages} onSave={handleSaveTutorMark} onCancel={() => setIsTutorMarking(false)} saveLabel="Save marked work" />
            </div>
          ) : null}
          {markStatus ? <p role="status" className="text-sm text-slate-600">{markStatus}</p> : null}
        </section>
      ) : null}

      {viewerRole === 'student' && studentSubmissionUrl ? (
        <section className="mt-6 space-y-3 border-t border-slate-200 pt-5">
          <h4 className="font-semibold text-slate-900">Your submitted work</h4>
          <ImagePageViewer images={studentSubmissionImages} title="Your submitted work" />
          <ImagePageViewer images={peerMarkingImages} title="Your marking of another learner's work" alt="Peer marking you submitted" />
          <ImagePageViewer images={markedImages} title="Tutor-marked work" alt="Tutor-marked version of your exercise work" />
          <ImagePageViewer images={peerMarkedImages} title="Peer-marked work on your submission" alt="Peer-marked version of your exercise work" />
        </section>
      ) : null}

      {viewerRole === 'student' ? <div className="mt-6 flex flex-wrap gap-3">
        {availability.state === 'active' ? (
          studentSubmissionUrl && studentSubmissionFileName ? (
            <div className="panel flex items-center w-full mb-4 justify-center p-6 text-center text-sm text-slate-500">
              Work submitted ✅.
            </div>
          ) : !paymentLocked && exercise ? (
            <SubmissionUpload
              exerciseId={exercise.id}
              onSubmit={handleStudentSubmit}
              exercise={exercise}
            />
          ) : (
            <div className="panel flex min-h-56 items-center justify-center p-6 text-center text-sm text-slate-500">
              Uploads unlock only after payment is complete and an exercise has been assigned.
            </div>
          )
        ) : (
          <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-500">
            <Lock className="h-4 w-4" />
            Submission unavailable
          </span>
        )}
      </div> : null}

    </div>
  );
};

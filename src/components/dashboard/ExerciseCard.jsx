import { CalendarDays, Lock, FileText } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubmissionUpload } from './SubmissionUpload';
import { deleteExerciseSubmissionFiles, uploadSubmissionImage, uploadPeerReviewImage, uploadTutorMarkedWork } from '../../services/storageService';
import { getQuestionPapersByIds, saveTutorMarkedExercise } from '../../services/firestoreService';
import { collection, query, where, orderBy, onSnapshot, doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../../firebase/config';
import { MarkingCanvas as ImageEditor } from '../canvas/pictureEditorCanvas';
import { TutorTopicScoreEditor } from '../tutor/TutorTopicScoreEditor';

export const ExerciseCard = ({ exercise, availability, paymentLocked, studentId, tutorId, topicScores = {}, onTopicScoreSaved, showQuestionLinks = false, viewerRole = 'student', showPeerMarking = false }) => {
  const navigate = useNavigate();
  const [openingPapers, setOpeningPapers] = useState(false);
  const [unreviewedExercises, setUnreviewedExercises] = useState([]);
  const [reviewingItem, setReviewingItem] = useState(null);
  const [markedImageUrl, setMarkedImageUrl] = useState(exercise.tutorMarkedImageUrl ?? '');
  const [studentSubmissionUrl, setStudentSubmissionUrl] = useState(exercise.submittedImageUrl ?? '');
  const [studentSubmissionFileName, setStudentSubmissionFileName] = useState(exercise.submittedFileName ?? '');
  const [isTutorMarking, setIsTutorMarking] = useState(false);
  const [markStatus, setMarkStatus] = useState('');

  useEffect(() => {
    setMarkedImageUrl(exercise.tutorMarkedImageUrl ?? '');
    setStudentSubmissionUrl(exercise.submittedImageUrl ?? '');
    setStudentSubmissionFileName(exercise.submittedFileName ?? '');
  }, [exercise.id, exercise.submittedImageUrl, exercise.submittedFileName, exercise.tutorMarkedImageUrl]);
  
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

  const handleSaveReview = async (file) => {
    if (!reviewingItem) return;

    try {
      // Rename the file
      const originalName = reviewingItem.submittedFileName || 'submission.png';
      const reviewFileName = originalName.replace(/\.[^/.]+$/, '-review.png');
      const renamedFile = new File([file], reviewFileName, { type: file.type });

      // Upload reviewed image
      const upload = await uploadPeerReviewImage({ file: renamedFile, studentId: reviewingItem.studentId, exerciseId: reviewingItem.id });

      // Update the reviewed exercise document
      const exerciseRef = doc(db, "dailyExerciseAssignments", reviewingItem.id);
      await updateDoc(exerciseRef, {
        submittedReviewImageUrl: upload.url,
        submittedReviewFileName: upload.fileName,
        peerReviewed: "Yes",
        peerReviewStatus: "completed",
        peerReviewDate: serverTimestamp(),
      });

      setReviewingItem(null); // Close editor
    } catch (error) {
      console.error('Failed to save review:', error);
    }
  };

  const handleSaveTutorMark = async (file) => {
    let upload;
    setMarkStatus('Saving marked work...');
    try {
      upload = await uploadTutorMarkedWork({ file, studentId: exercise.studentId, exerciseId: exercise.id });
      await saveTutorMarkedExercise({
        tutorId,
        exerciseId: exercise.id,
        markedImageUrl: upload.url,
        markedFileName: upload.fileName,
      });
      setMarkedImageUrl(upload.url);
      setMarkStatus('Marked work saved and completed.');
      setIsTutorMarking(false);
    } catch (error) {
      if (upload?.url) await deleteExerciseSubmissionFiles([upload.url]);
      setMarkStatus(error.message || 'Could not save marked work.');
      throw error;
    }
  };

  const handleStudentSubmit = async ({ file, exerciseId }) => {
    const result = await uploadSubmissionImage({ file, exerciseId, studentId });
    setStudentSubmissionUrl(result.submittedImageUrl);
    setStudentSubmissionFileName(result.submittedFileName);
    return result;
  };

  useEffect(() => {
    if (!exercise.submittedImageUrl) {
      setUnreviewedExercises([]);
      return;
    }

    const now = new Date();
    const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const q = query(
      collection(db, "dailyExerciseAssignments"),
      where("assignmentDate", "==", todayLocal),
      where("subject", "==", exercise.subject),
      where("submittedImageUrl", "!=", ""),
      orderBy("assignmentDate", "asc"),
    );

    const unsubscribe = onSnapshot(q, (querySnapshot) => {
      const list = querySnapshot.docs
        .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
        .filter((item) =>
          item.studentId !== studentId &&
          item.peerReviewStatus === "pending"
        );
      setUnreviewedExercises(list);
    });

    return unsubscribe;
  }, [exercise.submittedImageUrl, exercise.subject, studentId]);

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
      {viewerRole === 'tutor' && exercise.submittedImageUrl ? (
        <section className="mt-6 space-y-4 border-t border-slate-200 pt-5">
          <h4 className="font-semibold text-slate-900">Student work and tutor marking</h4>
          <div className="space-y-2">
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
                value={topicScores[topic]}
                onSaved={onTopicScoreSaved}
              />
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-sm font-medium text-slate-600">Student submission</p>
              <a href={exercise.submittedImageUrl} target="_blank" rel="noreferrer" aria-label="Open original student submission">
                <img src={exercise.submittedImageUrl} alt="Original student exercise work" className="max-h-[620px] w-full rounded-md bg-slate-100 object-contain" />
              </a>
            </div>
            {markedImageUrl ? (
              <div>
                <p className="mb-2 text-sm font-medium text-slate-600">Tutor-marked work · Completed</p>
                <a href={markedImageUrl} target="_blank" rel="noreferrer" aria-label="Open tutor-marked work">
                  <img src={markedImageUrl} alt="Tutor annotations on the student's exercise work" className="max-h-[620px] w-full rounded-md bg-slate-100 object-contain" />
                </a>
              </div>
            ) : null}
          </div>
          {!markedImageUrl && !isTutorMarking ? (
            <button type="button" className="btn-secondary" onClick={() => setIsTutorMarking(true)} disabled={!tutorId}>Mark student work</button>
          ) : null}
          {isTutorMarking ? (
            <div>
              <ImageEditor imageUrl={exercise.submittedImageUrl} onSave={handleSaveTutorMark} saveLabel="Save marked work" />
              <button type="button" className="btn-secondary mt-2" onClick={() => setIsTutorMarking(false)}>Cancel marking</button>
            </div>
          ) : null}
          {markStatus ? <p role="status" className="text-sm text-slate-600">{markStatus}</p> : null}
        </section>
      ) : null}

      {viewerRole === 'student' && studentSubmissionUrl ? (
        <section className="mt-6 space-y-3 border-t border-slate-200 pt-5">
          <h4 className="font-semibold text-slate-900">Your submitted work</h4>
          <a href={studentSubmissionUrl} target="_blank" rel="noreferrer" aria-label="Open your submitted work">
            <img src={studentSubmissionUrl} alt="Your submitted exercise work" className="max-h-[620px] w-full rounded-md bg-slate-100 object-contain" />
          </a>
          {markedImageUrl ? <div><p className="mb-2 text-sm font-medium text-slate-600">Tutor-marked work · Completed</p><a href={markedImageUrl} target="_blank" rel="noreferrer"><img src={markedImageUrl} alt="Tutor-marked version of your exercise work" className="max-h-[620px] w-full rounded-md bg-slate-100 object-contain" /></a></div> : null}
          {exercise.submittedReviewImageUrl ? <div><p className="mb-2 text-sm font-medium text-slate-600">Peer-marked work · Completed</p><a href={exercise.submittedReviewImageUrl} target="_blank" rel="noreferrer"><img src={exercise.submittedReviewImageUrl} alt="Peer-marked version of your exercise work" className="max-h-[620px] w-full rounded-md bg-slate-100 object-contain" /></a></div> : null}
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
      {showPeerMarking ? <div className="panel space-y-4 p-6 w-full">
        <h3 className="text-xl font-semibold text-slate-950">Mark for Others</h3>
        {unreviewedExercises.length > 0 && (
          <div className="mt-4 space-y-3">
            <h4 className="font-semibold">Choose one To Review</h4>
            {unreviewedExercises.map((item) => (
              <div key={item.id} className="rounded-xl border p-3">
                <p className="text-sm font-medium">{item.exerciseTitle || item.title || "Note exercise"}</p>
                <p className="mt-2 text-sm font-semibold text-accent">Topic: {item.topic}</p>
                {item?.paperIds?.length > 0 && (
                  <div className="mt-4">
                    <button
                      type="button"
                      onClick={() => handleOpenPapers(item)}
                      disabled={openingPapers}
                      className="btn-secondary inline-flex items-center gap-2"
                    >
                      <FileText className="h-4 w-4" />
                      {openingPapers ? 'Opening...' : 'View Paper Used'}
                    </button>
                  </div>
                )}
                <button 
                  onClick={() => setReviewingItem(item)} 
                  className="btn-secondary text-sm mt-4"
                >
                  Mark ✅
                </button>
              </div>
            ))}
          </div>
        )}
        {reviewingItem && (
          <div className="mt-4">
            <h4 className="font-semibold mb-2">Reviewing: {reviewingItem.exerciseTitle || "Exercise"}</h4>
            <ImageEditor 
              imageUrl={reviewingItem.submittedImageUrl} 
              onSave={handleSaveReview} 
            />
            <button 
              onClick={() => setReviewingItem(null)} 
              className="btn-secondary mt-2"
            >
              Cancel Review
            </button>
          </div>
        )}
      </div> : null}
    </div>
  );
};

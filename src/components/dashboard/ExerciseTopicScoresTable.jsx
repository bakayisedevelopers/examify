import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TutorTopicScoreEditor } from '../tutor/TutorTopicScoreEditor';
import { getTopicQuestionLinks, getQuestionPaperPath } from '../../utils/exerciseTopicRows';

const normalized = (value) => String(value ?? '').trim().toLocaleLowerCase();
const questionMarks = (question) => Number(question?.marks ?? question?.totalMarks) || 0;
const scoreKey = (question) => `${String(question?.paperId ?? '').trim()}::${normalized(question?.questionReference)}`;

const latestScoreFor = (entries, row, question) => entries
  .filter((entry) => {
    const matchesSource = row.activity === 'Exercise'
      ? entry.sourceType === 'Exercise' && (entry.sourceId === row.sourceId || entry.exerciseId === row.sourceId)
      : entry.sourceType === 'Marking' && (entry.sourceId === row.sourceId || entry.peerAssignmentId === row.sourceId);
    const sameQuestion = normalized(entry.questionReference) === normalized(question.questionReference);
    const samePaper = !entry.paperId || !question.paperId || entry.paperId === question.paperId;
    return matchesSource && sameQuestion && samePaper
      && Number.isFinite(Number(entry.earnedMarks)) && Number.isFinite(Number(entry.totalMarks));
  })
  .sort((left, right) => {
    const timestamp = (value) => value?.toDate ? value.toDate().getTime() : new Date(value ?? 0).getTime();
    return timestamp(right.createdAt) - timestamp(left.createdAt);
  })[0] ?? null;

const questionRowsFor = (source = {}) => {
  const linkedQuestions = getTopicQuestionLinks(source.questionLinks, source.topicBreakdown);
  const storedQuestions = Array.isArray(source.questions) ? source.questions : [];
  const questionReferences = Array.isArray(source.questionReferences) ? source.questionReferences : [];
  const questions = storedQuestions.length
    ? storedQuestions.map((question, index) => {
      const normalizedQuestion = typeof question === 'object' && question !== null
        ? question
        : { questionReference: question };
      const reference = String(normalizedQuestion.questionReference || normalizedQuestion.reference || questionReferences[index] || '').trim().toLocaleLowerCase();
      const paperId = String(normalizedQuestion.paperId || '').trim();
      const matchingLink = linkedQuestions.find((link) =>
        String(link.questionReference || link.reference || '').trim().toLocaleLowerCase() === reference
        && (!paperId || !link.paperId || paperId === String(link.paperId).trim()));
      return {
        ...matchingLink,
        ...normalizedQuestion,
        questionReference: normalizedQuestion.questionReference || normalizedQuestion.reference || questionReferences[index],
        paperId: normalizedQuestion.paperId || matchingLink?.paperId || '',
        pageNumber: normalizedQuestion.pageNumber ?? normalizedQuestion.page ?? matchingLink?.pageNumber ?? 0,
        marks: normalizedQuestion.marks ?? normalizedQuestion.totalMarks ?? matchingLink?.marks ?? 0,
        topic: normalizedQuestion.topic || matchingLink?.topic || '',
        topicId: normalizedQuestion.topicId || normalizedQuestion.canonicalTopicKey || matchingLink?.topicId || '',
      };
    })
    : linkedQuestions.length
      ? linkedQuestions
      : questionReferences.map((questionReference) => ({ questionReference }));
  const fallbackTopic = (Array.isArray(source.topics) ? source.topics[0] : '') || source.topic || '';

  return questions.map((question, index) => {
    const paperIds = Array.isArray(source.paperIds) ? source.paperIds : [];
    const paperId = String(question.paperId || (paperIds.length === 1 ? paperIds[0] : '') || '');
    return {
      ...question,
      paperId,
      questionReference: String(question.questionReference || question.reference || `Question ${index + 1}`),
      topic: String(question.topic || fallbackTopic || '').trim(),
      topicId: String(question.topicId || question.canonicalTopicKey || ''),
      totalMarks: questionMarks(question),
      questionIndex: index,
    };
  });
};

const TutorQuestionScoreCells = ({ tutorId, studentId, exercise, row, topicScores, scoreEntries, onSaved }) => {
  const editorRef = useRef(null);
  const [actionState, setActionState] = useState({ disabled: true, saving: false });
  const updateActionState = useCallback((nextState) => setActionState(nextState), []);
  const saved = latestScoreFor(scoreEntries, row, row.question);

  return <>
    <td className="min-w-40 px-4 py-3 text-center">
      <TutorTopicScoreEditor
        ref={editorRef}
        compact
        hideQuestionLabel
        hideSaveButton
        onActionStateChange={updateActionState}
        tutorId={tutorId}
        studentId={studentId}
        subject={exercise.subject}
        topic={row.topic}
        topicId={row.question.topicId}
        exerciseId={row.activity === 'Exercise' ? row.sourceId : undefined}
        peerAssignmentId={row.activity === 'Marking' ? row.sourceId : undefined}
        questions={[row.question]}
        initialQuestionScores={saved ? [saved] : []}
        value={topicScores[row.topic]}
        onSaved={(topic, average, marks) => onSaved(row, topic, average, marks)}
      />
    </td>
    <td className="whitespace-nowrap px-3 py-3 text-center">
      {row.topic && row.topic !== '—' && row.question.totalMarks > 0 ? (
        <button type="button" className="btn-primary px-3 py-1.5 text-xs" onClick={() => editorRef.current?.save()} disabled={actionState.disabled}>
          {actionState.saving ? 'Saving…' : 'Save'}
        </button>
      ) : <span className="text-sm text-slate-400">—</span>}
    </td>
  </>;
};

const ReadOnlyQuestionScore = ({ row, scoreEntries }) => {
  const saved = latestScoreFor(scoreEntries, row, row.question);
  const total = row.question.totalMarks;
  return <span className="font-semibold text-slate-800">{saved ? saved.earnedMarks : '—'} / {total > 0 ? total : '—'}</span>;
};

export const ExerciseTopicScoresTable = ({
  exercise,
  viewerRole = 'student',
  tutorId,
  studentId,
  topicScores = {},
  scoreEntries = [],
  completedMarkingAssignments = [],
  canEditScores = false,
  canEditMarkingScores = false,
  onTopicScoreSaved,
}) => {
  const navigate = useNavigate();
  const [visibleScoreEntries, setVisibleScoreEntries] = useState(scoreEntries);
  useEffect(() => setVisibleScoreEntries(scoreEntries), [scoreEntries]);

  const rows = useMemo(() => {
    const exerciseRows = questionRowsFor(exercise).map((question) => ({
      key: `exercise:${exercise.id}:${scoreKey(question)}:${question.questionIndex}`,
      question,
      topic: question.topic || '—',
      activity: 'Exercise',
      sourceId: exercise.id,
    }));

    const markingRows = (completedMarkingAssignments ?? []).flatMap((assignment) => questionRowsFor(assignment).map((question) => ({
      key: `marking:${assignment.id}:${scoreKey(question)}:${question.questionIndex}`,
      question,
      topic: question.topic || '—',
      activity: 'Marking',
      sourceId: assignment.id,
      assignment,
    })));
    return [...exerciseRows, ...markingRows];
  }, [exercise, completedMarkingAssignments]);

  const handleQuestionScoreSaved = (row, topic, average, marks = []) => {
    const mark = marks[0];
    if (mark) {
      const savedEntry = {
        ...mark,
        topic,
        sourceType: row.activity,
        sourceId: row.sourceId,
        ...(row.activity === 'Exercise' ? { exerciseId: row.sourceId } : { peerAssignmentId: row.sourceId }),
        score: Number(mark.earnedMarks) / Number(mark.totalMarks),
        scoreScale: 'ratio-0-to-1',
        createdAt: new Date(),
      };
      setVisibleScoreEntries((current) => [
        ...current.filter((entry) => !(entry.sourceType === savedEntry.sourceType
          && entry.sourceId === savedEntry.sourceId
          && scoreKey(entry) === scoreKey(savedEntry))),
        savedEntry,
      ]);
    }
    onTopicScoreSaved?.(topic, average);
  };

  const canTutorEditExercise = viewerRole === 'tutor' && canEditScores;
  const canTutorEditMarking = viewerRole === 'tutor' && canEditMarkingScores;

  return (
    <section className="space-y-4">
      <div className="rounded-2xl bg-gradient-to-r from-lime-300 via-lime-400 to-emerald-400 p-5 text-slate-950 shadow-soft sm:p-6">
        <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-950/70">Understanding</p>
        <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Question Scores</h2>
        <p className="mt-2 max-w-2xl text-sm text-emerald-950/80">Each question is listed separately, including questions that share a topic.</p>
      </div>
      <div className="panel overflow-hidden p-0">
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="min-w-[720px] w-full border-collapse text-left text-sm">
            <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th scope="col" className="px-4 py-3 text-left font-semibold">Question</th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">Topic</th>
                <th scope="col" className="px-4 py-3 text-center font-semibold">Source</th>
                <th scope="col" className="px-4 py-3 text-center font-semibold">Score</th>
                <th scope="col" className="w-px whitespace-nowrap px-3 py-3 text-center font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {rows.map((row) => {
                const canEdit = row.activity === 'Exercise' ? canTutorEditExercise : canTutorEditMarking;
                const questionPath = getQuestionPaperPath(row.question, viewerRole);
                return (
                  <tr key={row.key} className="align-top">
                    <th scope="row" className="whitespace-nowrap px-4 py-4 text-left font-semibold text-slate-900">
                      {questionPath ? (
                        <button type="button" className="font-semibold text-lime-800 underline decoration-lime-500/50 underline-offset-2 hover:text-emerald-800" onClick={() => navigate(questionPath)}>
                          {row.question.questionReference}
                        </button>
                      ) : row.question.questionReference}
                    </th>
                    <td className="whitespace-normal px-4 py-4 text-left font-medium text-slate-800">{row.topic}</td>
                    <td className="px-4 py-4 text-center">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${row.activity === 'Exercise' ? 'bg-lime-100 text-lime-800' : 'bg-emerald-100 text-emerald-800'}`}>{row.activity}</span>
                    </td>
                    {canEdit ? (
                      <TutorQuestionScoreCells
                        tutorId={tutorId}
                        studentId={studentId}
                        exercise={exercise}
                        row={row}
                        topicScores={topicScores}
                        scoreEntries={visibleScoreEntries}
                        onSaved={handleQuestionScoreSaved}
                      />
                    ) : (
                      <>
                        <td className="px-4 py-4 text-center"><ReadOnlyQuestionScore row={row} scoreEntries={visibleScoreEntries} /></td>
                        <td className="px-3 py-4 text-center"><span className="text-sm text-slate-400">—</span></td>
                      </>
                    )}
                  </tr>
                );
              })}
              {!rows.length ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-500">Question details will appear here when exercise or marking questions are available.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};

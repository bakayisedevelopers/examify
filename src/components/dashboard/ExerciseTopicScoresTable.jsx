import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TutorPeerMarkingScoreEditor } from '../tutor/TutorPeerMarkingScoreEditor';
import { TutorTopicScoreEditor } from '../tutor/TutorTopicScoreEditor';
import { getExerciseTopicNames, getPeerMarkingTopicNames, getTopicQuestionLinks } from '../../utils/exerciseTopicRows';

const normalized = (value) => String(value ?? '').trim().toLocaleLowerCase();
const questionMarks = (question) => Number(question?.marks ?? question?.totalMarks) || 0;

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

const scoreQuestionsForTopic = (questionLinks = [], topic) => questionLinks
  .filter((question) => normalized(question.topic) === normalized(topic))
  .map((question, index) => ({
    ...question,
    questionReference: String(question.questionReference || `Question ${index + 1}`),
    totalMarks: questionMarks(question),
  }));

const ExerciseScore = ({ row, scoreEntries, questions }) => (
  <div className="space-y-1.5">
    {questions.length ? questions.map((question, index) => {
      const saved = latestScoreFor(scoreEntries, row, question);
      const total = question.totalMarks;
      return (
        <div key={`${question.questionReference}-${index}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
          {questions.length > 1 ? <span className="text-xs text-slate-500">{question.questionReference}</span> : null}
          <span className="font-semibold text-slate-800">{saved ? saved.earnedMarks : '—'} / {total > 0 ? total : '—'}</span>
        </div>
      );
    }) : <span className="text-sm font-semibold text-slate-800">— / —</span>}
  </div>
);

const TutorExerciseScoreCells = ({ tutorId, studentId, exercise, row, topicScores, scoreEntries, onTopicScoreSaved }) => {
  const editorRef = useRef(null);
  const [actionState, setActionState] = useState({ disabled: true, saving: false });
  const updateActionState = useCallback((nextState) => setActionState(nextState), []);
  const savedScores = row.questions.map((question) => latestScoreFor(scoreEntries, row, question)).filter(Boolean);

  return <>
    <td className="min-w-64 px-4 py-3">
      <TutorTopicScoreEditor
        ref={editorRef}
        compact
        hideSaveButton
        onActionStateChange={updateActionState}
        tutorId={tutorId}
        studentId={studentId}
        subject={exercise.subject}
        topic={row.topic}
        exerciseId={exercise.id}
        questions={row.questions}
        initialQuestionScores={savedScores}
        value={topicScores[row.topic]}
        onSaved={onTopicScoreSaved}
      />
    </td>
    <td className="min-w-24 px-4 py-3">
      <button type="button" className="btn-primary px-3 py-1.5 text-xs" onClick={() => editorRef.current?.save()} disabled={actionState.disabled}>
        {actionState.saving ? 'Saving...' : 'Save'}
      </button>
    </td>
  </>;
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
  const [visibleScoreEntries, setVisibleScoreEntries] = useState(scoreEntries);
  useEffect(() => setVisibleScoreEntries(scoreEntries), [scoreEntries]);

  const rows = useMemo(() => {
    const rawQuestionLinks = Array.isArray(exercise?.questionLinks) ? exercise.questionLinks : [];
    const topicBreakdown = Array.isArray(exercise?.topicBreakdown) ? exercise.topicBreakdown : [];
    const questionLinks = getTopicQuestionLinks(rawQuestionLinks, topicBreakdown);
    const ownTopics = getExerciseTopicNames(exercise);
    const exerciseRows = ownTopics.map((topic) => ({
      key: `exercise:${normalized(topic)}`,
      topic,
      activity: 'Exercise',
      sourceId: exercise.id,
      assignmentTopics: [topic],
      questions: scoreQuestionsForTopic(questionLinks, topic),
    }));

    const markingRows = (completedMarkingAssignments ?? []).flatMap((assignment) => {
      const links = Array.isArray(assignment.questionLinks) ? assignment.questionLinks : [];
      const assignmentBreakdown = Array.isArray(assignment.topicBreakdown) ? assignment.topicBreakdown : [];
      const topicLinks = getTopicQuestionLinks(links, assignmentBreakdown);
      const assignmentTopics = getPeerMarkingTopicNames(assignment);
      return assignmentTopics.map((topic) => ({
        key: `marking:${assignment.id}:${normalized(topic)}`,
        topic,
        activity: 'Marking',
        sourceId: assignment.id,
        assignment,
        assignmentTopics,
        questions: scoreQuestionsForTopic(topicLinks, topic),
      }));
    });
    return [...exerciseRows, ...markingRows];
  }, [exercise, completedMarkingAssignments]);

  const markingAssignmentActionShown = new Set();
  const canTutorEdit = viewerRole === 'tutor' && canEditScores;
  const canTutorEditMarking = viewerRole === 'tutor' && canEditMarkingScores;
  const handleMarkingScoresSaved = (assignment, result) => {
    const savedEntries = (result.topicScores ?? []).flatMap((topicResult) => (topicResult.questionScores ?? []).map((question) => ({
      ...question,
      topic: topicResult.topic,
      sourceType: 'Marking',
      sourceId: assignment.id,
      peerAssignmentId: assignment.id,
      createdAt: new Date(),
    })));
    setVisibleScoreEntries((current) => [...current.filter((entry) => !savedEntries.some((saved) =>
      saved.topic === entry.topic && saved.sourceId === entry.sourceId && saved.questionReference === entry.questionReference,
    )), ...savedEntries]);
  };

  return (
    <section className="space-y-4">
      <div className="rounded-2xl bg-gradient-to-r from-lime-300 via-lime-400 to-emerald-400 p-5 text-slate-950 shadow-soft sm:p-6">
        <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-950/70">Understanding</p>
        <h2 className="mt-1 text-2xl font-extrabold tracking-tight">Topic Scores</h2>
        <p className="mt-2 max-w-2xl text-sm text-emerald-950/80">Question marks are grouped by topic and show whether they came from exercise work or peer marking.</p>
      </div>
      <div className="panel overflow-hidden p-0">
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="min-w-[760px] w-full border-collapse text-left text-sm">
            <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">Topic</th>
                <th scope="col" className="px-4 py-3 font-semibold">Activity</th>
                <th scope="col" className="px-4 py-3 font-semibold">Score</th>
                <th scope="col" className="px-4 py-3 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {rows.map((row) => {
                const firstMarkingRowForAssignment = row.activity === 'Marking' && !markingAssignmentActionShown.has(row.sourceId);
                if (firstMarkingRowForAssignment) markingAssignmentActionShown.add(row.sourceId);
                return (
                  <tr key={row.key} className="align-top">
                    <th scope="row" className="whitespace-normal px-4 py-4 font-semibold text-slate-900">{row.topic}</th>
                    <td className="px-4 py-4">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${row.activity === 'Exercise' ? 'bg-lime-100 text-lime-800' : 'bg-emerald-100 text-emerald-800'}`}>{row.activity}</span>
                    </td>
                    {canTutorEdit && row.activity === 'Exercise' ? (
                      <TutorExerciseScoreCells
                        key={row.key}
                        tutorId={tutorId}
                        studentId={studentId}
                        exercise={exercise}
                        row={row}
                        topicScores={topicScores}
                        scoreEntries={visibleScoreEntries}
                        onTopicScoreSaved={onTopicScoreSaved}
                      />
                    ) : (
                      <>
                        <td className="min-w-64 px-4 py-3">
                        <ExerciseScore row={row} scoreEntries={visibleScoreEntries} questions={row.questions} />
                        </td>
                        <td className="min-w-56 px-4 py-3">
                          {canTutorEditMarking && row.activity === 'Marking' && firstMarkingRowForAssignment ? (
                            <details className="group">
                              <summary className="inline-flex cursor-pointer list-none rounded-full border border-lime-600/30 bg-lime-50 px-3 py-1.5 text-xs font-semibold text-lime-900">Enter marking scores</summary>
                              <div className="mt-3 min-w-64 rounded-xl border border-slate-200 bg-slate-50 p-3">
                                <TutorPeerMarkingScoreEditor compact tutorId={tutorId} studentId={studentId} assignment={row.assignment}
                                  onSaved={(result) => handleMarkingScoresSaved(row.assignment, result)} />
                              </div>
                            </details>
                          ) : <span className="text-sm text-slate-400">—</span>}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
              {!rows.length ? (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-500">Topic details will appear here when exercise questions are available.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};

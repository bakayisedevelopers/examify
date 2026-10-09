import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { Save, LoaderCircle } from 'lucide-react';
import { updateStudentTopicScoreForTutor } from '../../services/firestoreService';
import { OperationStatusOverlay } from '../common/OperationStatusOverlay';
import { useOperationStatus } from '../../hooks/useOperationStatus';

const asQuestion = (question, index) => ({
  questionReference: String(question?.questionReference || `Question ${index + 1}`),
  paperId: String(question?.paperId || ''),
  pageNumber: Number(question?.pageNumber) || 0,
  topicId: String(question?.topicId || question?.canonicalTopicKey || ''),
  totalMarks: Number(question?.marks ?? question?.totalMarks) || 0,
});

export const TutorTopicScoreEditor = forwardRef(({
  tutorId,
  studentId,
  subject,
  topic,
  topicId,
  exerciseId,
  peerAssignmentId,
  questions = [],
  value,
  initialQuestionScores = [],
  compact = false,
  hideQuestionLabel = false,
  hideSaveButton = false,
  onActionStateChange,
  onSaved,
}, ref) => {
  const questionShapeKey = JSON.stringify((questions.length ? questions : [{}]).map(asQuestion));
  const normalizedQuestions = useMemo(() => JSON.parse(questionShapeKey), [questionShapeKey]);
  const initialScoresKey = JSON.stringify(initialQuestionScores);
  const [marks, setMarks] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const { operationStatus, runOperation, closeOperationStatus } = useOperationStatus();

  useEffect(() => {
    const savedScores = JSON.parse(initialScoresKey || '[]');
    setMarks(Object.fromEntries(normalizedQuestions.map((question, index) => {
      const saved = savedScores.find((entry) => entry.questionReference === question.questionReference
        && (!entry.paperId || !question.paperId || entry.paperId === question.paperId));
      return [index, saved ? { earnedMarks: String(saved.earnedMarks) } : {}];
    })));
    setMessage('');
  }, [topic, exerciseId, peerAssignmentId, normalizedQuestions, initialScoresKey]);

  const questionMarks = normalizedQuestions.map((question, index) => ({
    questionReference: question.questionReference,
    paperId: question.paperId,
    pageNumber: question.pageNumber,
    earnedMarks: marks[index]?.earnedMarks === '' || marks[index]?.earnedMarks === undefined ? NaN : Number(marks[index].earnedMarks),
    totalMarks: question.totalMarks,
  }));
  const allMarksValid = questionMarks.every((item) => Number.isFinite(item.earnedMarks)
    && Number.isFinite(item.totalMarks) && item.totalMarks > 0 && item.earnedMarks >= 0 && item.earnedMarks <= item.totalMarks);
  const calculatedScore = allMarksValid
    ? Math.round((questionMarks.reduce((sum, item) => sum + item.earnedMarks / item.totalMarks, 0)
      / questionMarks.length) * 10000) / 10000
    : null;

  const updateMark = (index, patch) => setMarks((current) => ({
    ...current,
    [index]: { ...(current[index] || {}), ...patch },
  }));

  const save = useCallback(async () => {
    if (!allMarksValid) {
      setMessage('Enter marks earned for this question using its available mark allocation.');
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      const result = await runOperation({
        operationName: 'Saving topic understanding scores',
        successMessage: 'The topic scores were saved successfully.',
        failureMessage: 'Could not save topic marks.',
      }, () => updateStudentTopicScoreForTutor({
        tutorId,
        studentId,
        subject,
        topic,
        topicId: topicId || normalizedQuestions[0]?.topicId || '',
        exerciseId,
        peerAssignmentId,
        questionMarks,
      }));
      onSaved?.(result.topic, result.understandingLevel, questionMarks, result);
      const average = result.averageUnderstandingLevel ?? result.understandingLevel;
      setMessage(`Saved ${Math.round(calculatedScore * 100)}% from the question marks. 28-day topic average: ${Math.round(average * 100)}%.`);
    } catch (error) {
      setMessage(error.message || 'Could not save topic marks.');
    } finally {
      setSaving(false);
    }
  }, [allMarksValid, calculatedScore, exerciseId, normalizedQuestions, onSaved, peerAssignmentId, questionMarks, runOperation, studentId, subject, topic, topicId, tutorId]);

  const saveDisabled = saving || !tutorId || !allMarksValid;
  useImperativeHandle(ref, () => ({ save }), [save]);
  useEffect(() => {
    onActionStateChange?.({ disabled: saveDisabled, saving });
  }, [onActionStateChange, saveDisabled, saving]);

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3 rounded-md border border-slate-700/70 bg-slate-900/75 p-3 text-slate-200'}>
      {!compact ? (
        <div>
          <p className="text-sm font-semibold text-slate-700">{topic} · topic marks</p>
          <p className="mt-1 text-xs text-slate-500">Enter marks earned. Available marks come from the question allocation.</p>
        </div>
      ) : null}
      <div className={compact ? 'space-y-2' : 'space-y-2'}>
        {normalizedQuestions.map((question, index) => (
          <div key={`${question.questionReference}-${index}`} className={compact ? 'flex flex-wrap items-center gap-2' : 'grid gap-2 rounded-md border border-slate-700/70 bg-slate-950/60 p-3 sm:grid-cols-[1fr_10rem] sm:items-end'}>
            {!hideQuestionLabel ? <p className={compact ? 'min-w-16 text-xs font-medium text-slate-600' : 'text-sm font-medium text-slate-200'}>{question.questionReference}{question.pageNumber > 0 ? ` · page ${question.pageNumber}` : ''}</p> : null}
            <label className={compact ? 'flex items-center gap-2 text-xs font-semibold text-slate-600' : 'grid gap-1 text-xs font-semibold text-slate-300'}>
              {!compact ? 'Marks earned' : null}
              <span className="inline-flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  max={question.totalMarks || undefined}
                  step="0.5"
                  className={compact ? 'input w-20 py-1.5 text-sm' : 'input py-2'}
                  value={marks[index]?.earnedMarks ?? ''}
                  onChange={(event) => updateMark(index, { earnedMarks: event.target.value })}
                  disabled={question.totalMarks <= 0}
                  aria-label={`${topic}, ${question.questionReference}, marks earned`}
                />
                <span className="whitespace-nowrap text-slate-500">/ {question.totalMarks > 0 ? question.totalMarks : '—'}</span>
              </span>
            </label>
          </div>
        ))}
      </div>
      {!hideSaveButton ? <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={`btn-primary inline-flex items-center gap-1.5 ${compact ? 'px-3 py-1.5 text-xs' : ''}`} onClick={save} disabled={saveDisabled}>
          {saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Save className="h-3.5 w-3.5" aria-hidden="true" />}
          {saving ? 'Saving...' : 'Save'}
        </button>
        {!compact && calculatedScore !== null ? <p className="text-sm font-semibold text-slate-200">Calculated understanding: {Math.round(calculatedScore * 100)}%</p> : null}
        {!compact && value !== undefined && value !== null && Number(value) <= 1 ? <p className="text-xs text-slate-500">Current 28-day average: {Math.round(Number(value) * 100)}%</p> : null}
      </div> : null}
      {message ? <p role="status" className="text-xs text-slate-600">{message}</p> : null}
      <OperationStatusOverlay state={operationStatus?.state} operationName={operationStatus?.operationName} message={operationStatus?.message} onDone={closeOperationStatus} />
    </div>
  );
});

TutorTopicScoreEditor.displayName = 'TutorTopicScoreEditor';

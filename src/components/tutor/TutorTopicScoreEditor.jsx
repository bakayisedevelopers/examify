import { useEffect, useMemo, useState } from 'react';
import { Save, LoaderCircle } from 'lucide-react';
import { updateStudentTopicScoreForTutor } from '../../services/firestoreService';

const asQuestion = (question, index) => ({
  questionReference: String(question?.questionReference || `Question ${index + 1}`),
  paperId: String(question?.paperId || ''),
  pageNumber: Number(question?.pageNumber) || 0,
  totalMarks: Number(question?.marks ?? question?.totalMarks) || 0,
});

export const TutorTopicScoreEditor = ({
  tutorId,
  studentId,
  subject,
  topic,
  exerciseId,
  peerAssignmentId,
  questions = [],
  value,
  onSaved,
}) => {
  const normalizedQuestions = useMemo(() => (questions.length ? questions : [{}]).map(asQuestion), [questions]);
  const [marks, setMarks] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setMarks({});
    setMessage('');
  }, [topic, exerciseId, peerAssignmentId]);

  const questionMarks = normalizedQuestions.map((question, index) => ({
    questionReference: question.questionReference,
    paperId: question.paperId,
    pageNumber: question.pageNumber,
    earnedMarks: marks[index]?.earnedMarks === '' || marks[index]?.earnedMarks === undefined ? NaN : Number(marks[index].earnedMarks),
    totalMarks: marks[index]?.totalMarks === '' || marks[index]?.totalMarks === undefined
      ? question.totalMarks
      : Number(marks[index].totalMarks),
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

  const save = async () => {
    if (!allMarksValid) {
      setMessage('Enter marks earned and available marks for every question.');
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      const result = await updateStudentTopicScoreForTutor({
        tutorId,
        studentId,
        subject,
        topic,
        exerciseId,
        peerAssignmentId,
        questionMarks,
      });
      onSaved?.(result.topic, result.understandingLevel);
      const average = result.averageUnderstandingLevel ?? result.understandingLevel;
      setMessage(`Saved ${Math.round(calculatedScore * 100)}% from the question marks. 28-day topic average: ${Math.round(average * 100)}%.`);
    } catch (error) {
      setMessage(error.message || 'Could not save topic marks.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-slate-700/70 bg-slate-900/75 p-3 text-slate-200">
      <div>
        <p className="text-sm font-semibold text-slate-700">{topic} · topic marks</p>
        <p className="mt-1 text-xs text-slate-500">For each question, its score is marks earned ÷ that question’s available marks. Each question score is saved under this topic and linked to this exercise.</p>
      </div>
      <div className="space-y-2">
        {normalizedQuestions.map((question, index) => {
          const available = marks[index]?.totalMarks ?? (question.totalMarks > 0 ? String(question.totalMarks) : '');
          const hasPaperTotal = question.totalMarks > 0;
          return (
            <div key={`${question.questionReference}-${index}`} className="grid gap-2 rounded-md border border-slate-700/70 bg-slate-950/60 p-3 sm:grid-cols-[1fr_7rem_7rem] sm:items-end">
              <p className="text-sm font-medium text-slate-200">{question.questionReference}{question.pageNumber > 0 ? ` · page ${question.pageNumber}` : ''}</p>
              <label className="grid gap-1 text-xs font-semibold text-slate-300">
                Marks earned
                <input
                  type="number"
                  min="0"
                  max={available || undefined}
                  step="0.5"
                  className="input py-2"
                  value={marks[index]?.earnedMarks ?? ''}
                  onChange={(event) => updateMark(index, { earnedMarks: event.target.value })}
                  aria-label={`${topic}, ${question.questionReference}, marks earned`}
                />
              </label>
              <label className="grid gap-1 text-xs font-semibold text-slate-300">
                Available marks
                <input
                  type="number"
                  min="0.5"
                  step="0.5"
                  className="input py-2"
                  value={available}
                  readOnly={hasPaperTotal}
                  onChange={(event) => updateMark(index, { totalMarks: event.target.value })}
                  aria-label={`${topic}, ${question.questionReference}, available marks`}
                />
              </label>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={save} disabled={saving || !tutorId || !allMarksValid}>
          {saving ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
          {saving ? 'Saving...' : 'Save topic marks'}
        </button>
        {calculatedScore !== null ? <p className="text-sm font-semibold text-slate-200">Calculated understanding: {Math.round(calculatedScore * 100)}%</p> : null}
        {value !== undefined && value !== null && Number(value) <= 1 ? <p className="text-xs text-slate-500">Current 28-day average: {Math.round(Number(value) * 100)}%</p> : null}
      </div>
      {message ? <p role="status" className="text-xs text-slate-600">{message}</p> : null}
    </div>
  );
};

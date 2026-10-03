import { useEffect, useMemo, useState } from 'react';
import { LoaderCircle, Save } from 'lucide-react';
import { saveTutorPeerMarkingReview } from '../../services/firestoreService';

const normalizeKey = (value) => String(value || '').trim().toLocaleLowerCase();
const scorePercent = (value) => {
  const score = Number(value);
  return Number.isFinite(score) ? Math.round(score > 1 ? score : score * 100) : 0;
};

export const TutorPeerMarkingScoreEditor = ({ tutorId, studentId, assignment, onSaved }) => {
  const topics = useMemo(() => [...new Set((Array.isArray(assignment.topics) && assignment.topics.length
    ? assignment.topics
    : [assignment.topic]).map((topic) => String(topic || '').trim()).filter(Boolean))], [assignment.topics, assignment.topic]);
  const questionsByTopic = useMemo(() => Object.fromEntries(topics.map((topic) => {
    const matchedQuestions = (assignment.questionLinks ?? []).filter((link) => normalizeKey(link.topic) === normalizeKey(topic));
    return [topic, (matchedQuestions.length ? matchedQuestions : [{ questionReference: assignment.title || 'Marked question', marks: 0 }])
      .map((question, index) => ({
        questionReference: String(question.questionReference || `Question ${index + 1}`),
        paperId: String(question.paperId || ''),
        pageNumber: Number(question.pageNumber) || 0,
        totalMarks: Number(question.marks ?? question.totalMarks) || 0,
      }))];
  })), [assignment.questionLinks, assignment.title, topics]);
  const [marks, setMarks] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setMarks({});
    setMessage('');
  }, [assignment.id]);

  const topicMarks = topics.map((topic) => ({
    topic,
    questionMarks: questionsByTopic[topic].map((question, index) => {
      const item = marks[`${topic}:${index}`] ?? {};
      return {
        questionReference: question.questionReference,
        paperId: question.paperId,
        pageNumber: question.pageNumber,
        earnedMarks: item.earnedMarks === undefined || item.earnedMarks === '' ? NaN : Number(item.earnedMarks),
        totalMarks: item.totalMarks === undefined || item.totalMarks === '' ? question.totalMarks : Number(item.totalMarks),
      };
    }),
  }));
  const valid = topics.length > 0 && topicMarks.every((topic) => topic.questionMarks.every((item) =>
    Number.isFinite(item.earnedMarks) && Number.isFinite(item.totalMarks) && item.totalMarks > 0
    && item.earnedMarks >= 0 && item.earnedMarks <= item.totalMarks));

  const setQuestionMark = (topic, index, patch) => setMarks((current) => ({
    ...current,
    [`${topic}:${index}`]: { ...(current[`${topic}:${index}`] || {}), ...patch },
  }));

  const save = async () => {
    if (!valid) {
      setMessage('Enter marks earned and available marks for every question under every topic.');
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      const result = await saveTutorPeerMarkingReview({ tutorId, studentId, peerAssignmentId: assignment.id, topicMarks });
      const summary = (result.topicScores ?? []).map((entry) => `${entry.topic}: ${scorePercent(entry.averageUnderstandingLevel ?? entry.understandingLevel)}%`).join(' · ');
      setMessage(`Review scores saved. ${summary}`);
      onSaved?.(result);
    } catch (error) {
      setMessage(error.message || 'Could not save the review scores.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg bg-slate-50 p-4">
      <div>
        <p className="font-semibold text-slate-800">Score each topic from the question marks</p>
        <p className="mt-1 text-xs text-slate-500">Enter marks earned for each question. Each question score is saved as earned ÷ that question’s available marks, linked to the peer-marking assignment and topic.</p>
      </div>
      {topics.map((topic) => (
        <section key={topic} className="space-y-2 rounded-md border border-slate-200 bg-white p-3">
          <h4 className="text-sm font-semibold text-slate-800">{topic}</h4>
          {questionsByTopic[topic].map((question, index) => {
            const available = marks[`${topic}:${index}`]?.totalMarks ?? (question.totalMarks > 0 ? String(question.totalMarks) : '');
            const hasPaperTotal = question.totalMarks > 0;
            return (
              <div key={`${question.questionReference}-${index}`} className="grid gap-2 sm:grid-cols-[1fr_7rem_7rem] sm:items-end">
                <p className="text-sm text-slate-700">{question.questionReference}{question.pageNumber > 0 ? ` · page ${question.pageNumber}` : ''}</p>
                <label className="grid gap-1 text-xs font-semibold text-slate-600">Marks earned
                  <input type="number" min="0" max={available || undefined} step="0.5" className="input py-2"
                    value={marks[`${topic}:${index}`]?.earnedMarks ?? ''}
                    onChange={(event) => setQuestionMark(topic, index, { earnedMarks: event.target.value })} />
                </label>
                <label className="grid gap-1 text-xs font-semibold text-slate-600">Available marks
                  <input type="number" min="0.5" step="0.5" className="input py-2" value={available} readOnly={hasPaperTotal}
                    onChange={(event) => setQuestionMark(topic, index, { totalMarks: event.target.value })} />
                </label>
              </div>
            );
          })}
          {assignment.tutorTopicScores?.find((entry) => normalizeKey(entry.topic) === normalizeKey(topic)) ? (
            <p className="text-xs text-slate-500">Previous topic score: {scorePercent(assignment.tutorTopicScores.find((entry) => normalizeKey(entry.topic) === normalizeKey(topic)).understandingLevel)}%</p>
          ) : null}
        </section>
      ))}
      <button type="button" className="btn-primary inline-flex items-center gap-2" onClick={save} disabled={saving || !valid || !tutorId}>
        {saving ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
        {saving ? 'Saving...' : assignment.tutorReviewStatus === 'reviewed' ? 'Add review scores' : 'Save review scores'}
      </button>
      {message ? <p role="status" className="text-xs text-slate-600">{message}</p> : null}
    </div>
  );
};

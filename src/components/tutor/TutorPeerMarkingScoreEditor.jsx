import { useEffect, useMemo, useState } from 'react';
import { LoaderCircle, Save } from 'lucide-react';
import { saveTutorPeerMarkingReview } from '../../services/firestoreService';

const normalizeKey = (value) => String(value || '').trim().toLocaleLowerCase();
const scorePercent = (value) => {
  const score = Number(value);
  return Number.isFinite(score) ? Math.round(score > 1 ? score : score * 100) : 0;
};

export const TutorPeerMarkingScoreEditor = ({ tutorId, studentId, assignment, onSaved, compact = false }) => {
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
    const initialMarks = {};
    topics.forEach((topic) => {
      questionsByTopic[topic].forEach((question, index) => {
        const savedTopic = assignment.tutorTopicScores?.find((entry) => normalizeKey(entry.topic) === normalizeKey(topic));
        const saved = savedTopic?.questionScores?.find((entry) => normalizeKey(entry.questionReference) === normalizeKey(question.questionReference)
          && (!entry.paperId || !question.paperId || entry.paperId === question.paperId));
        if (saved) initialMarks[`${topic}:${index}`] = { earnedMarks: String(saved.earnedMarks) };
      });
    });
    setMarks(initialMarks);
    setMessage('');
  }, [assignment.id, assignment.tutorTopicScores, questionsByTopic, topics]);

  const topicMarks = topics.map((topic) => ({
    topic,
    questionMarks: questionsByTopic[topic].map((question, index) => {
      const item = marks[`${topic}:${index}`] ?? {};
      return {
        questionReference: question.questionReference,
        paperId: question.paperId,
        pageNumber: question.pageNumber,
        earnedMarks: item.earnedMarks === undefined || item.earnedMarks === '' ? NaN : Number(item.earnedMarks),
        totalMarks: question.totalMarks,
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
    <div className={compact ? 'space-y-3' : 'space-y-4 rounded-lg border border-slate-700/70 bg-slate-900/75 p-4 text-slate-200'}>
      {!compact ? <div>
        <p className="font-semibold text-slate-800">Score each topic from the question marks</p>
        <p className="mt-1 text-xs text-slate-500">Enter marks earned for each question. Available marks come from the question allocation.</p>
      </div> : <p className="text-xs text-slate-500">Available marks are fixed by each question’s allocation. Save applies to all topics in this marking assignment.</p>}
      {topics.map((topic) => (
        <section key={topic} className={compact ? 'space-y-2 border-b border-slate-200 pb-2 last:border-0' : 'space-y-2 rounded-md border border-slate-700/70 bg-slate-950/60 p-3'}>
          <h4 className="text-sm font-semibold text-slate-800">{topic}</h4>
          {questionsByTopic[topic].map((question, index) => {
            return (
              <div key={`${question.questionReference}-${index}`} className={compact ? 'flex flex-wrap items-center justify-between gap-2' : 'grid gap-2 sm:grid-cols-[1fr_10rem] sm:items-end'}>
                <p className="text-xs text-slate-600">{question.questionReference}{question.pageNumber > 0 ? ` · page ${question.pageNumber}` : ''}</p>
                <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600">{compact ? null : 'Marks earned'}
                  <span className="inline-flex items-center gap-2">
                  <input type="number" min="0" max={question.totalMarks || undefined} step="0.5" className={compact ? 'input w-20 py-1.5' : 'input py-2'}
                    value={marks[`${topic}:${index}`]?.earnedMarks ?? ''}
                    onChange={(event) => setQuestionMark(topic, index, { earnedMarks: event.target.value })}
                    disabled={question.totalMarks <= 0} />
                  <span className="whitespace-nowrap text-slate-500">/ {question.totalMarks > 0 ? question.totalMarks : '—'}</span>
                  </span>
                </label>
              </div>
            );
          })}
          {assignment.tutorTopicScores?.find((entry) => normalizeKey(entry.topic) === normalizeKey(topic)) ? (
            <p className="text-xs text-slate-500">Previous topic score: {scorePercent(assignment.tutorTopicScores.find((entry) => normalizeKey(entry.topic) === normalizeKey(topic)).understandingLevel)}%</p>
          ) : null}
        </section>
      ))}
      <button type="button" className={`btn-primary inline-flex items-center gap-2 ${compact ? 'px-3 py-1.5 text-xs' : ''}`} onClick={save} disabled={saving || !valid || !tutorId}>
        {saving ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
        {saving ? 'Saving...' : 'Save'}
      </button>
      {message ? <p role="status" className="text-xs text-slate-600">{message}</p> : null}
    </div>
  );
};

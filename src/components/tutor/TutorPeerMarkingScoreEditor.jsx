import { useMemo } from 'react';
import { TutorTopicScoreEditor } from './TutorTopicScoreEditor';
import { getPeerMarkingTopicNames, getTopicQuestionLinks } from '../../utils/exerciseTopicRows';

const normalizeKey = (value) => String(value || '').trim().toLocaleLowerCase();

export const TutorPeerMarkingScoreEditor = ({ tutorId, studentId, assignment, onSaved, compact = false }) => {
  const topics = useMemo(() => getPeerMarkingTopicNames(assignment), [assignment]);
  const questionLinks = useMemo(
    () => getTopicQuestionLinks(
      Array.isArray(assignment.questionLinks) && assignment.questionLinks.length
        ? assignment.questionLinks
        : assignment.questions,
      assignment.topicBreakdown,
    ),
    [assignment.questionLinks, assignment.questions, assignment.topicBreakdown],
  );
  const questionsByTopic = useMemo(() => Object.fromEntries(topics.map((topic) => {
    const matchedQuestions = questionLinks.filter((link) => normalizeKey(link.topic) === normalizeKey(topic));
    return [topic, (matchedQuestions.length ? matchedQuestions : [{ questionReference: assignment.title || 'Marked question', marks: 0 }])
      .map((question, index) => ({
        ...question,
        questionReference: String(question.questionReference || `Question ${index + 1}`),
        paperId: String(question.paperId || ''),
        pageNumber: Number(question.pageNumber) || 0,
        topicId: String(question.topicId || question.canonicalTopicKey || ''),
        totalMarks: Number(question.marks ?? question.totalMarks) || 0,
      }))];
  })), [assignment.title, questionLinks, topics]);

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4'}>
      <div>
        <p className="text-sm font-semibold text-slate-800">Score peer-marking questions individually</p>
        <p className="mt-1 text-xs text-slate-500">Each Save records or updates only that question’s score under its topic.</p>
      </div>
      {topics.map((topic) => (
        <section key={topic} className={compact ? 'space-y-2 border-b border-slate-200 pb-2 last:border-0' : 'space-y-2 rounded-md border border-slate-200 bg-white p-3'}>
          <h4 className="text-sm font-semibold text-slate-800">{topic}</h4>
          {questionsByTopic[topic].map((question, index) => {
            const savedTopic = assignment.tutorTopicScores?.find((entry) => normalizeKey(entry.topic) === normalizeKey(topic));
            const saved = savedTopic?.questionScores?.find((entry) => normalizeKey(entry.questionReference) === normalizeKey(question.questionReference)
              && (!entry.paperId || !question.paperId || entry.paperId === question.paperId));
            return (
              <div key={`${question.paperId}-${question.questionReference}-${index}`} className="rounded-lg border border-slate-200 bg-white p-3">
                <TutorTopicScoreEditor
                  tutorId={tutorId}
                  studentId={studentId}
                  subject={assignment.subject}
                  topic={topic}
                  topicId={question.topicId}
                  peerAssignmentId={assignment.id}
                  questions={[question]}
                  initialQuestionScores={saved ? [saved] : []}
                  compact
                  onSaved={(_savedTopic, _average, _marks, result) => onSaved?.(result)}
                />
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
};

import { useEffect, useState } from 'react';
import { Save, LoaderCircle } from 'lucide-react';
import { updateStudentTopicScoreForTutor } from '../../services/firestoreService';

export const TutorTopicScoreEditor = ({ tutorId, studentId, subject, topic, value, onSaved }) => {
  const [score, setScore] = useState(value == null ? '' : String(value));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setScore(value == null ? '' : String(value));
  }, [topic, value]);

  const save = async () => {
    if (score === '' || !Number.isFinite(Number(score)) || Number(score) < 0 || Number(score) > 10) {
      setMessage('Enter a score from 0 to 10.');
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
        understandingLevel: Number(score),
      });
      onSaved?.(result.topic, result.understandingLevel);
      setMessage('Topic score updated.');
    } catch (error) {
      setMessage(error.message || 'Could not update topic score.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md bg-slate-50 p-3">
      <label className="grid min-w-40 flex-1 gap-1 text-xs font-semibold text-slate-600">
        {topic} score (0-10)
        <input
          type="number"
          min="0"
          max="10"
          step="1"
          className="input py-2"
          value={score}
          onChange={(event) => setScore(event.target.value)}
          aria-label={`${topic} understanding score`}
        />
      </label>
      <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={save} disabled={saving || !tutorId}>
        {saving ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
        {saving ? 'Saving...' : 'Update score'}
      </button>
      {message ? <p role="status" className="w-full text-xs text-slate-600">{message}</p> : null}
    </div>
  );
};

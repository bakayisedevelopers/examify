import { useEffect, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { getActiveSubjectsForStudent, getExerciseHistory, getStudentAccessState, getTodayExercise } from '../../services/firestoreService';
import { getExerciseAvailability } from '../../utils/exerciseRules';
import { DEFAULT_SUBJECT } from '../../lib/constants';

export const StudentExercisesPage = () => {
  const { profile, logout } = useAuth();
  const [todayExercise, setTodayExercise] = useState(null);
  const [history, setHistory] = useState([]);
  const [paymentCompleted, setPaymentCompleted] = useState(false);
  const [availableSubjects, setAvailableSubjects] = useState([]);
  const [selectedSubject, setSelectedSubject] = useState(DEFAULT_SUBJECT);

  useEffect(() => {
    if (!profile?.uid) return undefined;
    let active = true;
    getActiveSubjectsForStudent(profile.uid).then((subjects) => {
      if (!active) return;
      setAvailableSubjects(subjects);
      if (subjects.length && !subjects.includes(selectedSubject)) setSelectedSubject(subjects[0]);
    });
    return () => { active = false; };
  }, [profile?.uid, selectedSubject]);

  useEffect(() => {
    if (availableSubjects.length && !availableSubjects.includes(selectedSubject)) {
      setSelectedSubject(availableSubjects[0]);
    }
  }, [availableSubjects, selectedSubject]);

  useEffect(() => {
    const load = async () => {
      const access = await getStudentAccessState(profile, selectedSubject);
      setPaymentCompleted(access.paymentCompleted);
      if (!access.paymentCompleted) return;
      getTodayExercise(profile?.uid, selectedSubject).then(setTodayExercise);
      getExerciseHistory(profile?.uid, selectedSubject).then(setHistory);
    };
    load();
  }, [profile, selectedSubject]);

  return (
    <AppShell title="Exercises" subtitle="Review today’s task and browse your subject assignment timeline." role="student" user={profile} onLogout={logout}>
      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-semibold text-slate-950">Subject</p>
          <p className="text-xs text-slate-500">Today’s task and history are scoped to this subject.</p>
        </div>
        <select className="input max-w-xs" value={selectedSubject} onChange={(event) => setSelectedSubject(event.target.value)} disabled={!availableSubjects.length}>
          {availableSubjects.map((subject) => <option key={subject}>{subject}</option>)}
        </select>
      </div>
      {!paymentCompleted ? <div className="panel p-5 text-sm text-amber-700">Payment is required before exercises unlock.</div> : null}
      <SectionHeader eyebrow="Today" title={todayExercise?.title ?? 'Waiting for today\'s assignment'} description={todayExercise?.instruction ?? 'Once payment and generation criteria are complete, today’s exercise will appear here.'} />
      <div className="grid gap-4">
        {history.map((exercise) => {
          const availability = getExerciseAvailability(exercise.assignmentDate, exercise.submitted);
          return (
            <div key={exercise.id} className="panel flex items-center justify-between p-5">
              <div>
                <p className="font-semibold text-slate-950">{exercise.title}</p>
                <p className="mt-1 text-sm text-slate-500">{exercise.assignmentDate}</p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-600">{availability.label}</span>
            </div>
          );
        })}
      </div>
    </AppShell>
  );
};

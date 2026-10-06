import { useEffect, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { ExerciseStatusBadges } from '../../components/dashboard/ExerciseStatusBadges';
import { useAuth } from '../../hooks/useAuth';
import { getActiveSubjectEpisodesForStudent, getExerciseHistory, getStudentEntitlementState, getTodayExercise } from '../../services/firestoreService';
import { DEFAULT_SUBJECT } from '../../lib/constants';

export const StudentExercisesPage = () => {
  const { profile, logout } = useAuth();
  const [todayExercise, setTodayExercise] = useState(null);
  const [history, setHistory] = useState([]);
  const [paymentCompleted, setPaymentCompleted] = useState(false);
  const [availableSubjects, setAvailableSubjects] = useState([]);
  const [availableSubjectEpisodes, setAvailableSubjectEpisodes] = useState([]);
  const [selectedSubject, setSelectedSubject] = useState(DEFAULT_SUBJECT);

  useEffect(() => {
    if (!profile?.uid) return undefined;
    let active = true;
    getActiveSubjectEpisodesForStudent(profile.uid).then((episodes) => {
      if (!active) return;
      const subjects = [...new Set(episodes.map((episode) => episode.subjectKey).filter(Boolean))].sort();
      setAvailableSubjectEpisodes(episodes);
      setAvailableSubjects(subjects);
      if (subjects.length && !subjects.includes(selectedSubject)) setSelectedSubject(subjects[0]);
    });
    return () => { active = false; };
  }, [profile?.uid]);

  useEffect(() => {
    if (availableSubjects.length && !availableSubjects.includes(selectedSubject)) {
      setSelectedSubject(availableSubjects[0]);
    }
  }, [availableSubjects, selectedSubject]);

  useEffect(() => {
    const load = async () => {
      const episode = availableSubjectEpisodes.find((item) => item.studentId === profile?.uid && item.subjectKey === selectedSubject) ?? null;
      const access = await getStudentEntitlementState(profile, selectedSubject, episode);
      setPaymentCompleted(access.paymentCompleted);
      if (!access.paymentCompleted) return;
      const [today, exercises] = await Promise.all([
        getTodayExercise(profile?.uid, selectedSubject, episode),
        getExerciseHistory(profile?.uid, selectedSubject, episode),
      ]);
      setTodayExercise(today);
      setHistory(exercises);
    };
    load();
  }, [profile, selectedSubject, availableSubjectEpisodes]);

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
      {todayExercise ? <div className="panel p-4"><ExerciseStatusBadges exercise={todayExercise} /></div> : null}
      <div className="grid gap-4">
        {history.map((exercise) => {
          return (
            <div key={exercise.id} className="panel flex items-center justify-between p-5">
              <div>
                <p className="font-semibold text-slate-950">{exercise.title}</p>
                <p className="mt-1 text-sm text-slate-500">{exercise.assignmentDate}</p>
              </div>
              <ExerciseStatusBadges exercise={exercise} className="justify-end" />
            </div>
          );
        })}
      </div>
    </AppShell>
  );
};

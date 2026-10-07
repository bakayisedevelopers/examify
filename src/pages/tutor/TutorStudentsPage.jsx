import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { LoadingState } from '../../components/common/LoadingState';
import { useAuth } from '../../hooks/useAuth';
import { subscribeToAssignedStudentsForTutor } from '../../services/firestoreService';
import { DEFAULT_SUBJECT } from '../../lib/constants';
import { getApprovedTutorSubjects } from '../../utils/tutorSubjects';

export const TutorStudentsPage = () => {
  const { profile, logout } = useAuth();
  const [students, setStudents] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const approvedSubjects = useMemo(() => getApprovedTutorSubjects(profile), [profile]);
  const [selectedSubject, setSelectedSubject] = useState(approvedSubjects[0] ?? DEFAULT_SUBJECT);

  useEffect(() => {
    if (approvedSubjects.length && !approvedSubjects.includes(selectedSubject)) {
      setSelectedSubject(approvedSubjects[0]);
    }
  }, [approvedSubjects, selectedSubject]);

  useEffect(() => {
    if (!profile?.uid || !approvedSubjects.length) {
      setStudents([]);
      setIsLoading(false);
      return undefined;
    }
    let active = true;
    setIsLoading(true);
    setLoadError('');
    const unsubscribe = subscribeToAssignedStudentsForTutor(profile.uid, (rows) => {
      if (!active) return;
      setStudents(rows);
      setIsLoading(false);
    }, selectedSubject, (error) => {
      if (!active) return;
      setLoadError(error.message || 'Could not load tutor students.');
      setIsLoading(false);
    });
    return () => { active = false; unsubscribe(); };
  }, [profile?.uid, selectedSubject, approvedSubjects]);

  return (
    <AppShell title="Students" subtitle="See assigned learner performance and tutor-owned context." role="tutor" user={profile} onLogout={logout}>
      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-semibold text-slate-950">Subject</p>
          <p className="text-xs text-slate-500">Assignments are limited to one active tutor per student per subject.</p>
        </div>
        <select className="input max-w-xs" value={selectedSubject} onChange={(event) => setSelectedSubject(event.target.value)} disabled={!approvedSubjects.length}>
          {approvedSubjects.map((subject) => <option key={subject}>{subject}</option>)}
        </select>
      </div>

      <SectionHeader 
        eyebrow="Roster" 
        title={`${selectedSubject} students`}
        description="Students stay scoped to the selected subject and assigned tutor. Admins manage assignment changes." 
      />

      {loadError ? <div className="panel p-4 text-sm text-rose-700" role="alert">{loadError}</div> : null}
      <div className="grid gap-4">
        {isLoading ? <LoadingState label="Loading assigned students…" /> : null}
        {students.map((student) => (
          <div key={student.uid || student.id} className="panel p-5">
            <p className="text-lg font-semibold text-slate-950">{student.displayName || student.name || 'Learner'}</p>
            <p className="mt-1 text-sm text-slate-500">{student.grade || 'Unknown grade'} • {student.province || 'Unknown province'}</p>
            <p className="mt-3 text-sm text-slate-600">Latest mark: {student.latestMark ?? student.previousYearMark ?? 0}%</p>
          </div>
        ))}
        {!approvedSubjects.length ? <div className="panel p-5 text-sm text-amber-700">Upload your marks document on the tutor dashboard before students can be assigned to you.</div> : null}
        {!isLoading && !loadError && approvedSubjects.length && !students.length ? <div className="panel p-5 text-sm text-slate-500">No tutor students have been assigned yet.</div> : null}
      </div>
    </AppShell>
  );
};

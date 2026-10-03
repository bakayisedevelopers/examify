import { useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { getQuestionPapers, getStudentSubscriptionState, getTutorAssignedStudentContexts, getTutorLessonsForAssignedStudents } from '../../services/firestoreService';
import { DEFAULT_SUBJECT } from '../../lib/constants';
import { getApprovedTutorSubjects, normalizeEligibleSubject } from '../../utils/tutorSubjects';
import { useEffectiveRole } from '../../utils/effectiveRole';


const TutorReadinessPanel = ({ rows }) => {
  if (!rows.length) return null;
  const labels = {
    paidSubscriptionActive: 'Paid subscription active',
    lessonReady: 'At least 1 completed lesson logged',
    papersReady: 'At least 2 analyzed papers available',
  };
  return (
    <div className="panel space-y-4 p-5">
      <div>
        <h2 className="text-xl font-bold text-slate-950">Subjects missing requirements</h2>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {rows.map((row) => (
          <details key={row.id} className="group rounded-2xl bg-slate-50 p-4">
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3">
              <span className="font-semibold text-slate-950">{row.studentName} • {row.subject}</span>
              <span className="flex items-center gap-2"><span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">{Object.values(row.checks).filter((passed) => !passed).length} missing</span><ChevronDown className="h-4 w-4 text-slate-500 transition-transform group-open:rotate-180" aria-hidden="true" /></span>
            </summary>
            <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
              {Object.entries(row.checks).map(([key, passed]) => (
                <div key={key} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-600">{labels[key]}</span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${passed ? 'bg-lime-400/15 text-lime-300 border border-lime-400/30' : 'bg-amber-400/15 text-amber-300 border border-amber-400/30'}`}>{passed ? 'Done' : 'Missing'}</span>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
};

export const TutorDashboardPage = () => {
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const { role, RoleName, basePath } = useEffectiveRole();
  const approvedSubjects = useMemo(() => getApprovedTutorSubjects(profile), [profile]);
  const [students, setStudents] = useState([]);
  const [lessons, setLessons] = useState([]);
  const [paperCounts, setPaperCounts] = useState({});
  const [paidSubjectAccess, setPaidSubjectAccess] = useState({});
  const [status, setStatus] = useState('');

  const load = async () => {
    if (!profile?.uid) return;
    const [studentRows, lessonRows] = await Promise.all([
      getTutorAssignedStudentContexts(profile.uid),
      getTutorLessonsForAssignedStudents(profile.uid),
    ]);
    const uniqueContexts = [...new Map(studentRows.map((student) => [`${student.subject ?? DEFAULT_SUBJECT}-${student.grade ?? ''}-${student.province ?? ''}`, student])).values()];
    const studentsById = new Map(studentRows.map((student) => [student.studentId, student]));
    const [paperPairs, subscriptionPairs] = await Promise.all([
      Promise.all(uniqueContexts.map(async (student) => {
        const subject = student.subject ?? DEFAULT_SUBJECT;
        const papers = await getQuestionPapers({ grade: student.grade, region: student.province, subject });
        return [`${subject}-${student.grade ?? ''}-${student.province ?? ''}`, papers.length];
      })),
      Promise.all([...studentsById.entries()]
        .map(async ([studentId, student]) => [studentId, await getStudentSubscriptionState({ ...student, uid: studentId })])),
    ]);
    const subscriptionsByStudent = Object.fromEntries(subscriptionPairs);
    const accessBySubject = Object.fromEntries(studentRows.map((student) => {
      const subject = student.subject ?? DEFAULT_SUBJECT;
      const subscription = subscriptionsByStudent[student.studentId];
      const normalizedSubject = normalizeEligibleSubject(subject) ?? subject;
      return [`${student.studentId}:${normalizedSubject}`, Boolean(subscription?.paidSubscriptionActive && student.subjectInstanceId)];
    }));
    setStudents(studentRows);
    setLessons(lessonRows);
    setPaperCounts(Object.fromEntries(paperPairs));
    setPaidSubjectAccess(accessBySubject);
  };

  useEffect(() => {
    load().catch((error) => setStatus(error.message || 'Could not load assigned students.'));
  }, [profile?.uid]);

  const readinessRows = useMemo(() => students.map((student) => {
    const subject = student.subject ?? DEFAULT_SUBJECT;
    const lessonReady = lessons.some((lesson) => lesson.studentId === student.studentId
      && (lesson.subject ?? DEFAULT_SUBJECT) === subject);
    const papersReady = (paperCounts[`${subject}-${student.grade ?? ''}-${student.province ?? ''}`] ?? 0) >= 2;
    const normalizedSubject = normalizeEligibleSubject(subject) ?? subject;
    const paymentReady = Boolean(paidSubjectAccess[`${student.studentId}:${normalizedSubject}`]);
    return {
      id: `${student.studentId}-${subject}`,
      studentName: student.displayName || student.name || student.email || 'Student',
      subject,
      checks: { paidSubscriptionActive: paymentReady, lessonReady, papersReady },
    };
  }).filter((row) => !Object.values(row.checks).every(Boolean)), [students, lessons, paperCounts, paidSubjectAccess]);
  const studentList = useMemo(() => {
    const grouped = new Map();
    students.forEach((context) => {
      const current = grouped.get(context.studentId) ?? { ...context, subjects: [] };
      if (context.subject && !current.subjects.includes(context.subject)) current.subjects.push(context.subject);
      grouped.set(context.studentId, current);
    });
    return [...grouped.values()];
  }, [students]);

  return (
    <AppShell
      title={`${RoleName} dashboard`}
      subtitle="Open an assigned student to manage subject reports, completed lessons, and exercises."
      role={role}
      user={profile}
      onLogout={logout}
    >
      {!approvedSubjects.length ? (
        <div className="panel flex flex-wrap items-center justify-between gap-4 p-5">
          <p className="text-sm text-amber-700">Add approved subjects from Profile → Subjects before students can be assigned to you.</p>
          <Link to={`${basePath}/profile/subjects`} className="btn-primary">Add approved subjects</Link>
        </div>
      ) : null}
      {status ? <div className="panel p-4 text-sm text-slate-700">{status}</div> : null}
      <SectionHeader eyebrow="Students" title="Assigned learners" description="Open a learner to switch between the subjects available to you." />
      <div className="space-y-4">
        {studentList.map((student) => {
          const firstSubject = student.subjects[0] ?? student.subject ?? DEFAULT_SUBJECT;
          return (
            <button
              key={student.studentId}
              type="button"
              onClick={() => navigate(`${basePath}/students/${student.studentId}?subject=${encodeURIComponent(firstSubject)}`)}
              className="panel block w-full p-5 text-left transition hover:shadow-lg"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-lg font-semibold text-slate-950">{student.displayName || student.name || student.email || 'Student'}</p>
                  <p className="mt-1 text-sm text-slate-500">{student.grade || '?'} • {student.province || '?'}</p>
                  <p className="mt-2 text-xs text-slate-500">Subjects: {student.subjects.join(', ')}</p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-300">{student.subjects.length} {student.subjects.length === 1 ? 'subject' : 'subjects'}</span>
                </div>
              </div>
            </button>
          );
        })}
        {approvedSubjects.length && !studentList.length ? <div className="panel p-5 text-sm text-slate-500">No students are assigned to you yet.</div> : null}
      </div>
      <TutorReadinessPanel rows={readinessRows} />
    </AppShell>
  );
};

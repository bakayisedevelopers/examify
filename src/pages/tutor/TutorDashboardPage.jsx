import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { getQuestionPapers, getTutorAssignedStudentContexts, getTutorLessonsForAssignedStudents, getTutorReportsForAssignedStudents } from '../../services/firestoreService';
import { DEFAULT_SUBJECT } from '../../lib/constants';
import { getApprovedTutorSubjects } from '../../utils/tutorSubjects';


const TutorReadinessPanel = ({ rows }) => {
  if (!rows.length) return null;
  const labels = {
    paymentReady: 'Student payment active',
    reportReady: 'Initial tutor report added',
    lessonReady: 'At least 1 completed lesson logged',
    papersReady: 'At least 2 analyzed papers available',
  };
  return (
    <div className="panel space-y-4 p-5">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-brand-700">AI readiness</p>
        <h2 className="mt-2 text-xl font-bold text-slate-950">What is missing before students can receive generated exercises</h2>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {rows.map((row) => (
          <div key={row.id} className="rounded-2xl bg-slate-50 p-4">
            <p className="font-semibold text-slate-950">{row.studentName} • {row.subject}</p>
            <div className="mt-3 space-y-2">
              {Object.entries(row.checks).map(([key, passed]) => (
                <div key={key} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-600">{labels[key]}</span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${passed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{passed ? 'Done' : 'Missing'}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">Analyzed papers available: {row.paperCount}.</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export const TutorDashboardPage = () => {
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const approvedSubjects = useMemo(() => getApprovedTutorSubjects(profile), [profile]);
  const [students, setStudents] = useState([]);
  const [reports, setReports] = useState([]);
  const [lessons, setLessons] = useState([]);
  const [paperCounts, setPaperCounts] = useState({});
  const [status, setStatus] = useState('');

  const load = async () => {
    if (!profile?.uid) return;
    const [studentRows, reportRows, lessonRows] = await Promise.all([
      getTutorAssignedStudentContexts(profile.uid),
      getTutorReportsForAssignedStudents(profile.uid),
      getTutorLessonsForAssignedStudents(profile.uid),
    ]);
    const uniqueContexts = [...new Map(studentRows.map((student) => [`${student.subject ?? DEFAULT_SUBJECT}-${student.grade ?? ''}-${student.province ?? ''}`, student])).values()];
    const paperPairs = await Promise.all(uniqueContexts.map(async (student) => {
      const subject = student.subject ?? DEFAULT_SUBJECT;
      const papers = await getQuestionPapers({ grade: student.grade, region: student.province, subject });
      return [`${subject}-${student.grade ?? ''}-${student.province ?? ''}`, papers.length];
    }));
    setStudents(studentRows);
    setReports(reportRows);
    setLessons(lessonRows);
    setPaperCounts(Object.fromEntries(paperPairs));
  };

  useEffect(() => {
    load().catch((error) => setStatus(error.message || 'Could not load assigned students.'));
  }, [profile?.uid]);

  const hasReportFor = (student) => {
    const subject = student.subject ?? DEFAULT_SUBJECT;
    return Boolean(
      student.latestReportsBySubject?.[subject] ||
      reports.some((report) => report.studentId === student.studentId && report.subject === subject && report.reportType === 'initial') ||
      (subject === DEFAULT_SUBJECT ? student.latestReport : '')
    );
  };


  const readinessRows = useMemo(() => students.map((student) => {
    const subject = student.subject ?? DEFAULT_SUBJECT;
    const reportReady = hasReportFor(student);
    const lessonReady = lessons.some((lesson) => lesson.studentId === student.studentId && (lesson.subject ?? DEFAULT_SUBJECT) === subject);
    const papersReady = (paperCounts[`${subject}-${student.grade ?? ''}-${student.province ?? ''}`] ?? 0) >= 2;
    const paymentReady = Boolean(student.paymentCompleted);
    return {
      id: `${student.studentId}-${subject}`,
      studentName: student.displayName || student.name || student.email || 'Student',
      subject,
      checks: { paymentReady, reportReady, lessonReady, papersReady },
      paperCount: paperCounts[`${subject}-${student.grade ?? ''}-${student.province ?? ''}`] ?? 0,
    };
  }).filter((row) => !Object.values(row.checks).every(Boolean)), [students, lessons, paperCounts, reports]);

  return (
    <AppShell
      title="Tutor dashboard"
      subtitle="Open an assigned student to manage subject reports, completed lessons, and exercises."
      role="tutor"
      user={profile}
      onLogout={logout}
    >
      {!approvedSubjects.length ? (
        <div className="panel p-5 text-sm text-amber-700">Add approved subjects from Profile → Subjects before students can be assigned to you.</div>
      ) : null}
      {status ? <div className="panel p-4 text-sm text-slate-700">{status}</div> : null}
      <TutorReadinessPanel rows={readinessRows} />

      <SectionHeader eyebrow="Students" title="Assigned learners" description="Each row is scoped to the subject you are assigned to tutor for that student." />
      <div className="space-y-4">
        {students.map((student) => {
          const subject = student.subject ?? DEFAULT_SUBJECT;
          const reportReady = hasReportFor(student);
          return (
            <button
              key={`${student.studentId}-${subject}`}
              type="button"
              onClick={() => navigate(`/tutor/students/${student.studentId}?subject=${encodeURIComponent(subject)}`)}
              className="panel block w-full p-5 text-left transition hover:shadow-lg"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-lg font-semibold text-slate-950">{student.displayName || student.name || student.email || 'Student'}</p>
                  <p className="mt-1 text-sm text-slate-500">{student.grade || '?'} • {student.province || '?'} • {subject}</p>
                  <p className="mt-2 text-xs text-slate-500">{reportReady ? 'Initial report exists. Click to manage lessons and exercises.' : 'No initial report yet. Click to create the first report.'}</p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.25em] ${student.paymentCompleted ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{student.paymentCompleted ? 'paid' : 'unpaid'}</span>
                  <span className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] ${reportReady ? 'bg-sky-100 text-sky-700' : 'bg-slate-200 text-slate-700'}`}>{reportReady ? 'report ready' : 'report needed'}</span>
                </div>
              </div>
            </button>
          );
        })}
        {approvedSubjects.length && !students.length ? <div className="panel p-5 text-sm text-slate-500">No students are assigned to you yet.</div> : null}
      </div>
    </AppShell>
  );
};

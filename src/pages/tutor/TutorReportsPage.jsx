import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { getTutorAssignedStudentContexts, getTutorReportsForAssignedStudents } from '../../services/firestoreService';

export const TutorReportsPage = () => {
  const { profile, logout } = useAuth();
  const [reports, setReports] = useState([]);
  const [students, setStudents] = useState([]);
  const [studentFilter, setStudentFilter] = useState('all');
  const [subjectFilter, setSubjectFilter] = useState('all');

  useEffect(() => {
    if (!profile?.uid) return;
    Promise.all([
      getTutorReportsForAssignedStudents(profile.uid),
      getTutorAssignedStudentContexts(profile.uid),
    ]).then(([reportRows, studentRows]) => {
      setReports(reportRows);
      setStudents(studentRows);
    });
  }, [profile?.uid]);

  const subjects = useMemo(() => [...new Set([...reports.map((item) => item.subject), ...students.map((item) => item.subject)].filter(Boolean))], [reports, students]);
  const studentOptions = useMemo(() => students.filter((item, index, list) => list.findIndex((row) => row.studentId === item.studentId) === index), [students]);
  const filteredReports = reports.filter((report) =>
    (studentFilter === 'all' || report.studentId === studentFilter) &&
    (subjectFilter === 'all' || report.subject === subjectFilter)
  );

  return (
    <AppShell title="Reports" subtitle="All reports you created for assigned students." role="tutor" user={profile} onLogout={logout}>
      <div className="panel grid gap-3 p-4 md:grid-cols-2">
        <select className="input" value={studentFilter} onChange={(event) => setStudentFilter(event.target.value)}>
          <option value="all">All students</option>
          {studentOptions.map((student) => <option key={student.studentId} value={student.studentId}>{student.displayName || student.name || student.email || student.studentId}</option>)}
        </select>
        <select className="input" value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)}>
          <option value="all">All subjects</option>
          {subjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
        </select>
      </div>
      <SectionHeader eyebrow="Guidance" title="Tutor report history" description="Filter reports by student or subject to review the guidance shared with each learner." />
      <div className="grid gap-4">
        {filteredReports.map((report) => (
          <div key={report.id} className="panel p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-semibold text-slate-950">{report.studentName || report.studentId}</p>
              <div className="flex gap-2">
                <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">{report.subject}</span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{report.reportType || 'report'}</span>
              </div>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm text-slate-600">{report.note}</p>
          </div>
        ))}
        {!filteredReports.length ? <div className="panel p-5 text-sm text-slate-500">No reports match this filter.</div> : null}
      </div>
    </AppShell>
  );
};

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import {
  assignStudentToTutor,
  getAdminSubjectAssignmentData,
  getGuideQuizResultsSummary,
} from '../../services/firestoreService';
import { DEFAULT_SUBJECT, SUBJECTS } from '../../lib/constants';

const ScoreList = ({ title, description, users = [] }) => (
  <section className="space-y-4">
    <SectionHeader eyebrow="Guide results" title={title} description={description} />
    <div className="space-y-3">
      {users.map((user) => (
        <div key={user.id} className="panel flex items-center justify-between gap-4 p-5">
          <div>
            <p className="text-lg font-semibold text-slate-950">{user.name}</p>
            <p className="mt-1 text-sm text-slate-500">Latest Examifying Guide mark</p>
          </div>
          <div className="rounded-2xl bg-slate-50 px-4 py-3 text-right">
            <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Mark</p>
            <p className="mt-1 text-2xl font-bold text-slate-950">{user.percentage ?? '—'}{user.percentage !== null ? '%' : ''}</p>
          </div>
        </div>
      ))}
      {!users.length ? <div className="panel p-5 text-sm text-slate-500">No users are available in this category yet.</div> : null}
    </div>
  </section>
);

export const AdminUsersPage = () => {
  const { profile, logout } = useAuth();
  const [summary, setSummary] = useState({ students: [], tutors: [] });
  const [selectedSubject, setSelectedSubject] = useState(DEFAULT_SUBJECT);
  const [assignmentData, setAssignmentData] = useState({ students: [], tutors: [], assignments: [], unassignedStudents: [] });
  const [studentId, setStudentId] = useState('');
  const [tutorId, setTutorId] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    getGuideQuizResultsSummary().then(setSummary).catch((error) => {
      console.error('[Examifying][AdminUsers] load:error', error);
      setSummary({ students: [], tutors: [] });
    });
  }, []);

  useEffect(() => {
    getAdminSubjectAssignmentData(selectedSubject).then((data) => {
      setAssignmentData(data);
      setStudentId(data.unassignedStudents[0]?.uid ?? '');
      setTutorId(data.tutors[0]?.uid ?? '');
    }).catch((error) => {
      console.error('[Examifying][AdminUsers] assignments:error', error);
      setAssignmentData({ students: [], tutors: [], assignments: [], unassignedStudents: [] });
      setStatus(error.message || 'Could not load subject assignments.');
    });
  }, [selectedSubject]);

  const handleAssign = async (event) => {
    event.preventDefault();
    if (!studentId || !tutorId) {
      setStatus('Choose a student and tutor before assigning.');
      return;
    }

    try {
      setStatus('Assigning student...');
      await assignStudentToTutor({ studentId, tutorId, subject: selectedSubject });
      const data = await getAdminSubjectAssignmentData(selectedSubject);
      setAssignmentData(data);
      setStudentId(data.unassignedStudents[0]?.uid ?? '');
      setTutorId(data.tutors[0]?.uid ?? '');
      setStatus('Student assigned successfully.');
    } catch (error) {
      setStatus(error.message || 'Could not assign student.');
    }
  };

  return (
    <AppShell
      title="User management"
      subtitle="Review tutor and student guide-test performance so you can confirm who understands the platform workflow."
      role="admin"
      user={profile}
      onLogout={logout}
    >
      <section className="panel space-y-5 p-6">
        <SectionHeader
          eyebrow="Assignments"
          title="Assign tutors by subject"
          description="Admins control which tutor is linked to each student for a subject. Tutors only see students assigned here."
        />

        <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
          <form onSubmit={handleAssign} className="space-y-4">
            <label>
              <span className="label">Subject</span>
              <select className="input" value={selectedSubject} onChange={(event) => setSelectedSubject(event.target.value)}>
                {SUBJECTS.map((subject) => <option key={subject}>{subject}</option>)}
              </select>
            </label>

            <label>
              <span className="label">Unassigned student</span>
              <select className="input" value={studentId} onChange={(event) => setStudentId(event.target.value)}>
                {assignmentData.unassignedStudents.map((student) => (
                  <option key={student.uid} value={student.uid}>
                    {student.displayName || student.email || student.uid}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="label">Tutor</span>
              <select className="input" value={tutorId} onChange={(event) => setTutorId(event.target.value)}>
                {assignmentData.tutors.map((tutor) => (
                  <option key={tutor.uid} value={tutor.uid}>
                    {tutor.displayName || tutor.email || tutor.uid}
                  </option>
                ))}
              </select>
            </label>

            <button type="submit" className="btn-primary w-full" disabled={!studentId || !tutorId}>
              Assign tutor
            </button>
            {status ? <p className="text-sm text-slate-600">{status}</p> : null}
          </form>

          <div className="space-y-3">
            <p className="text-sm font-semibold text-slate-950">Current {selectedSubject} assignments</p>
            {assignmentData.assignments.map((assignment) => (
              <div key={assignment.id} className="rounded-2xl bg-slate-50 p-4 text-sm">
                <p className="font-semibold text-slate-900">{assignment.studentName}</p>
                <p className="mt-1 text-slate-500">Tutor: {assignment.tutorName}</p>
              </div>
            ))}
            {!assignmentData.assignments.length ? (
              <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">
                No students are assigned for this subject yet.
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <ScoreList
          title="Students"
          description="Each learner appears with the latest percentage from the student Examifying Guide test."
          users={summary.students}
        />
        <ScoreList
          title="Tutors"
          description="Each tutor appears with the latest percentage from the tutor Examifying Guide test."
          users={summary.tutors}
        />
      </div>
    </AppShell>
  );
};

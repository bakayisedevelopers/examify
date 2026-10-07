import { useEffect, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import {
  assignStudentToTutor,
  getAdminUserManagementData,
  getAdminSubjectAssignmentData,
} from '../../services/firestoreService';

const UserList = ({ title, description, users = [], userType }) => (
  <section className="space-y-4">
    <SectionHeader eyebrow="Accounts" title={title} description={description} />
    <div className="space-y-3">
      {users.map((user) => (
        <div key={user.id} className="panel grid gap-4 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <p className="text-lg font-semibold text-slate-950">{user.name}</p>
            <p className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Subjects</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {user.subjects?.length ? user.subjects.map((subject) => (
                <span key={subject} className="rounded-full bg-lime-100 px-3 py-1 text-sm font-medium text-lime-900">{subject}</span>
              )) : <span className="text-sm text-slate-500">No subjects selected</span>}
            </div>
          </div>
          <div className="rounded-2xl bg-lime-50 px-4 py-3 sm:min-w-40 sm:text-right">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-lime-800">
              {userType === 'student' ? 'Subscription plan' : 'Assigned students'}
            </p>
            <p className="mt-1 text-lg font-bold text-slate-950">
              {userType === 'student' ? (user.subscriptionPlanName || 'Free') : (user.studentCount ?? 0)}
            </p>
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
  const [tutorOptions, setTutorOptions] = useState([]);
  const [tutorsLoaded, setTutorsLoaded] = useState(false);
  const [selectedSubject, setSelectedSubject] = useState('');
  const [assignmentData, setAssignmentData] = useState({ students: [], tutors: [], assignments: [], unassignedStudents: [] });
  const [studentId, setStudentId] = useState('');
  const [tutorId, setTutorId] = useState('');
  const [status, setStatus] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);
  const selectedTutor = tutorOptions.find((tutor) => tutor.uid === tutorId);

  useEffect(() => {
    getAdminUserManagementData().then((data) => {
      setSummary({ students: data.students ?? [], tutors: data.tutors ?? [] });
      setTutorOptions(data.tutorOptions ?? []);
      setTutorId(data.tutorOptions?.[0]?.uid ?? '');
      setSelectedSubject(data.tutorOptions?.[0]?.subjects?.[0] ?? '');
    }).catch((error) => {
      console.error('[Examifying][AdminUsers] load:error', error);
      setSummary({ students: [], tutors: [] });
      setTutorOptions([]);
      setStatus(error.message || 'Could not load users and their subjects.');
    }).finally(() => setTutorsLoaded(true));
  }, []);

  useEffect(() => {
    if (!tutorsLoaded || !selectedSubject) return;
    getAdminSubjectAssignmentData(selectedSubject).then((data) => {
      setAssignmentData(data);
      setStudentId(data.unassignedStudents[0]?.uid ?? '');
    }).catch((error) => {
      console.error('[Examifying][AdminUsers] assignments:error', error);
      setAssignmentData({ students: [], tutors: [], assignments: [], unassignedStudents: [] });
      setStatus(error.message || 'Could not load subject assignments.');
    });
  }, [selectedSubject, tutorsLoaded]);

  const handleTutorChange = (nextTutorId) => {
    const tutor = tutorOptions.find((item) => item.uid === nextTutorId);
    setTutorId(nextTutorId);
    setSelectedSubject(tutor?.subjects[0] ?? '');
    setStatus('');
  };

  const handleAssign = async (event) => {
    event.preventDefault();
    if (isAssigning) return;
    if (!studentId || !tutorId || !selectedTutor?.subjects.includes(selectedSubject)
      || !assignmentData.tutors.some((tutor) => tutor.uid === tutorId)) {
      setStatus('Choose a student and tutor before assigning.');
      return;
    }

    setIsAssigning(true);
    try {
      setStatus('Assigning student...');
      await assignStudentToTutor({ studentId, tutorId, subject: selectedSubject });
      const data = await getAdminSubjectAssignmentData(selectedSubject);
      setAssignmentData(data);
      setStudentId(data.unassignedStudents[0]?.uid ?? '');
      setStatus('Student assigned successfully.');
    } catch (error) {
      setStatus(error.message || 'Could not assign student.');
    } finally {
      setIsAssigning(false);
    }
  };

  return (
    <AppShell
      title="User management"
      subtitle="Manage student, tutor, and teacher accounts and subject assignments."
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
              <span className="label">Tutor / Teacher</span>
              <select className="input" value={tutorId} onChange={(event) => handleTutorChange(event.target.value)} disabled={!tutorsLoaded || !tutorOptions.length}>
                {tutorOptions.map((tutor) => (
                  <option key={tutor.uid} value={tutor.uid}>
                    {tutor.displayName || tutor.email || tutor.uid} {tutor.isTeacher || tutor.role === 'teacher' ? '(Teacher)' : '(Tutor)'}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="label">Subject taught by this tutor</span>
              <select className="input" value={selectedSubject} onChange={(event) => setSelectedSubject(event.target.value)} disabled={!selectedTutor?.subjects.length}>
                {(selectedTutor?.subjects ?? []).map((subject) => <option key={subject} value={subject}>{subject}</option>)}
              </select>
            </label>

            <label>
              <span className="label">Unassigned student for {selectedSubject || 'selected subject'}</span>
              <select className="input" value={studentId} onChange={(event) => setStudentId(event.target.value)}>
                {assignmentData.unassignedStudents.map((student) => (
                  <option key={student.uid} value={student.uid}>
                    {student.displayName || student.email || student.uid}
                  </option>
                ))}
              </select>
            </label>

            {!assignmentData.tutors.some((tutor) => tutor.uid === tutorId) && selectedSubject ? (
              <p className="text-sm text-amber-700">This tutor is not currently approved for {selectedSubject}.</p>
            ) : null}
            <button type="submit" className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-60" disabled={isAssigning || !studentId || !tutorId || !selectedSubject || !assignmentData.tutors.some((tutor) => tutor.uid === tutorId)}>
              {isAssigning ? 'Assigning...' : 'Assign tutor / teacher'}
            </button>
            {!tutorsLoaded ? <p className="text-sm text-slate-500">Loading tutors...</p> : null}
            {tutorsLoaded && !tutorOptions.length ? <p className="text-sm text-slate-500">No tutors or teachers have approved subjects yet.</p> : null}
            {status ? <p className="text-sm text-slate-600">{status}</p> : null}
          </form>

          <div className="space-y-3">
            <p className="text-sm font-semibold text-slate-950">Current {selectedSubject || 'subject'} assignments</p>
            {assignmentData.assignments.map((assignment) => (
              <div key={assignment.id} className="rounded-2xl bg-slate-50 p-4 text-sm">
                <p className="font-semibold text-slate-900">{assignment.studentName}</p>
                <p className="mt-1 text-slate-500">{assignment.tutorRoleLabel || 'Tutor'}: {assignment.tutorName}</p>
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
        <UserList
          title="Students"
          description="Review each learner’s selected subjects and current subscription plan."
          users={summary.students}
          userType="student"
        />
        <UserList
          title="Tutors & Teachers"
          description="Review the subjects each tutor or teacher supports and their assigned student count."
          users={summary.tutors}
          userType="tutor"
        />
      </div>
    </AppShell>
  );
};

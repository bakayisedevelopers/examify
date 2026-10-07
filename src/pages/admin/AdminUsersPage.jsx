import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, LoaderCircle, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { LoadingState } from '../../components/common/LoadingState';
import { useAuth } from '../../hooks/useAuth';
import { useScreenLoadMetrics } from '../../hooks/useScreenLoadMetrics';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import {
  assignStudentToTutor,
  getAdminUserManagementData,
  getAdminSubjectAssignmentData,
} from '../../services/firestoreService';

const roleLabel = (role = 'unknown') => String(role).replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const formatLastActive = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `Last active ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)}`;
};

export const AdminUsersPage = () => {
  const { profile, logout } = useAuth();
  const { runOperation } = useOperationStatus();
  const [summary, setSummary] = useState({ users: [] });
  const [tutorOptions, setTutorOptions] = useState([]);
  const [tutorsLoaded, setTutorsLoaded] = useState(false);
  const [usersError, setUsersError] = useState('');
  const [assignmentsOpen, setAssignmentsOpen] = useState(false);
  const [assignmentsLoaded, setAssignmentsLoaded] = useState(false);
  const [assignmentSubject, setAssignmentSubject] = useState('');
  const [selectedSubject, setSelectedSubject] = useState('');
  const [assignmentData, setAssignmentData] = useState({ students: [], tutors: [], assignments: [], unassignedStudents: [] });
  const [studentId, setStudentId] = useState('');
  const [tutorId, setTutorId] = useState('');
  const [status, setStatus] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const selectedTutor = tutorOptions.find((tutor) => tutor.uid === tutorId);
  const availableRoles = useMemo(() => [...new Set(summary.users.map((user) => user.role || 'unknown'))]
    .sort((left, right) => left.localeCompare(right)), [summary.users]);
  const visibleUsers = useMemo(() => {
    const search = searchTerm.trim().toLowerCase();
    return summary.users.filter((user) => {
      const matchesRole = roleFilter === 'all' || user.role === roleFilter;
      const matchesSearch = !search || `${user.name} ${user.email} ${user.role}`.toLowerCase().includes(search);
      return matchesRole && matchesSearch;
    });
  }, [roleFilter, searchTerm, summary.users]);

  useScreenLoadMetrics('Admin users', 'admin', tutorsLoaded);

  useEffect(() => {
    getAdminUserManagementData().then((data) => {
      setSummary({ users: data.users ?? [] });
      setTutorOptions(data.tutorOptions ?? []);
      setTutorId(data.tutorOptions?.[0]?.uid ?? '');
      const initialSubject = data.initialSubject || data.tutorOptions?.[0]?.subjects?.[0] || '';
      setSelectedSubject(initialSubject);
      setAssignmentSubject('');
    }).catch((error) => {
      console.error('[Examifying][AdminUsers] load:error', error);
      setSummary({ users: [] });
      setTutorOptions([]);
      setUsersError(error.message || 'Could not load users.');
    }).finally(() => setTutorsLoaded(true));
  }, []);

  useEffect(() => {
    if (!tutorsLoaded || !assignmentsOpen) return undefined;
    if (!selectedSubject) {
      setAssignmentData({ students: [], tutors: [], assignments: [], unassignedStudents: [] });
      setAssignmentSubject('');
      setAssignmentsLoaded(true);
      return undefined;
    }
    if (selectedSubject === assignmentSubject) {
      setAssignmentsLoaded(true);
      return undefined;
    }
    let active = true;
    setAssignmentsLoaded(false);
    getAdminSubjectAssignmentData(selectedSubject).then((data) => {
      if (!active) return;
      setAssignmentData(data);
      setStudentId(data.unassignedStudents[0]?.uid ?? '');
      setAssignmentSubject(selectedSubject);
    }).catch((error) => {
      if (!active) return;
      console.error('[Examifying][AdminUsers] assignments:error', error);
      setAssignmentData({ students: [], tutors: [], assignments: [], unassignedStudents: [] });
      setStatus(error.message || 'Could not load subject assignments.');
    }).finally(() => {
      if (active) setAssignmentsLoaded(true);
    });
    return () => { active = false; };
  }, [assignmentSubject, assignmentsOpen, selectedSubject, tutorsLoaded]);

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
      await runOperation({ operationName: 'Assigning student to tutor', successMessage: 'The student assignment was saved.' }, async () => {
        await assignStudentToTutor({ studentId, tutorId, subject: selectedSubject });
        const data = await getAdminSubjectAssignmentData(selectedSubject);
        setAssignmentData(data);
        setStudentId(data.unassignedStudents[0]?.uid ?? '');
      });
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
      subtitle="Browse all Examifying accounts and open a profile for its role-specific details."
      role="admin"
      user={profile}
      onLogout={logout}
    >
      <section className="panel space-y-5 p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <SectionHeader
            eyebrow="Assignments"
            title="Assign tutors by subject"
            description="Manage which tutor is linked to each student subject. The assignment data loads when this section is opened."
          />
          <button type="button" className="btn-secondary shrink-0" aria-expanded={assignmentsOpen} onClick={() => setAssignmentsOpen((open) => !open)}>
            {assignmentsOpen ? 'Hide assignments' : 'Manage assignments'}
            <ChevronDown className={`ml-2 inline h-4 w-4 transition-transform ${assignmentsOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
        </div>

        {assignmentsOpen ? <div className="grid gap-4 border-t border-slate-800 pt-5 lg:grid-cols-[0.8fr_1.2fr]">
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
              <p className="text-sm text-amber-200">This tutor is not currently approved for {selectedSubject}.</p>
            ) : null}
            <button type="submit" className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-60" disabled={isAssigning || !studentId || !tutorId || !selectedSubject || !assignmentData.tutors.some((tutor) => tutor.uid === tutorId)}>
              {isAssigning ? 'Assigning...' : 'Assign tutor / teacher'}
            </button>
            {!tutorsLoaded ? <p className="inline-flex items-center gap-2 text-sm text-slate-300" role="status"><LoaderCircle className="h-4 w-4 animate-spin text-lime-300" aria-hidden="true" />Loading tutors and teachers…</p> : null}
            {tutorsLoaded && !tutorOptions.length ? <p className="text-sm text-slate-500">No tutors or teachers have approved subjects yet.</p> : null}
            {status ? <p className="text-sm text-slate-600">{status}</p> : null}
          </form>

          <div className="space-y-3">
            <p className="text-sm font-semibold text-slate-950">Current {selectedSubject || 'subject'} assignments</p>
            {!assignmentsLoaded ? <LoadingState label="Loading subject assignments…" /> : null}
            {assignmentData.assignments.map((assignment) => (
              <div key={assignment.id} className="rounded-2xl bg-slate-50 p-4 text-sm">
                <p className="font-semibold text-slate-900">{assignment.studentName}</p>
                <p className="mt-1 text-slate-500">{assignment.tutorRoleLabel || 'Tutor'}: {assignment.tutorName}</p>
              </div>
            ))}
            {assignmentsLoaded && !status && !assignmentData.assignments.length ? (
              <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">
                No students are assigned for this subject yet.
              </div>
            ) : null}
          </div>
        </div> : null}
      </section>

      <section className="space-y-4">
        <SectionHeader eyebrow="Accounts" title="All users" description="Students, tutors, teachers, parents, admins, and other registered roles." />
        <div className="panel space-y-4 p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_13rem]">
            <label className="relative block">
              <span className="sr-only">Search users</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <input className="input pl-10" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search by name, email, or role" />
            </label>
            <label>
              <span className="sr-only">Filter by role</span>
              <select className="input" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
                <option value="all">All roles</option>
                {availableRoles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
              </select>
            </label>
          </div>
          {!tutorsLoaded ? <LoadingState label="Loading users…" /> : null}
          {tutorsLoaded && usersError ? <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm font-medium text-rose-200" role="alert">{usersError}</div> : null}
          {tutorsLoaded && !usersError && visibleUsers.length ? (
            <div className="space-y-2" aria-label="All users">
              {visibleUsers.map((user) => {
                const lastActive = user.lastLoginAt ? formatLastActive(user.lastLoginAt) : '';
                return (
                  <Link
                    key={user.id}
                    to={`/admin/users/${encodeURIComponent(user.id)}`}
                    className="group flex min-h-[4.5rem] items-center justify-between gap-3 rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-slate-100 transition hover:border-lime-400/50 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-300 sm:px-5"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-white sm:text-base">{user.name || 'Name unavailable'}</span>
                      <span className="mt-1 block truncate text-xs text-slate-400">{lastActive || user.email || 'Account profile'}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 sm:gap-3">
                      <span className="rounded-full border border-lime-300/70 bg-lime-100 px-2.5 py-1 text-xs font-semibold text-lime-950 sm:px-3">{roleLabel(user.role)}</span>
                      <ChevronRight className="h-5 w-5 text-lime-300 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                    </span>
                  </Link>
                );
              })}
            </div>
          ) : null}
          {tutorsLoaded && !usersError && !visibleUsers.length ? (
            <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5 text-sm text-slate-300">
              {summary.users.length ? 'No users match these filters.' : 'No user accounts are available yet.'}
            </div>
          ) : null}
        </div>
      </section>
    </AppShell>
  );
};

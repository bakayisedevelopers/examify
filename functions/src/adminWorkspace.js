import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { getDb } from './admin.js';
import { normalizeSupportedSubject } from './subjects.js';

const requireAdmin = async (request, db) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in as an admin to open this workspace.');
  const actor = await db.collection('users').doc(uid).get();
  if (!actor.exists || actor.data()?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only an admin can access this workspace data.');
  }
};

const getApprovedSubjects = (profile = {}) => [...new Set([
  ...(Array.isArray(profile.subjects) ? profile.subjects : []),
  ...(profile.subject ? [profile.subject] : []),
  ...(Array.isArray(profile.tutorSubjectMarks)
    ? profile.tutorSubjectMarks.filter((item) => Number(item.mark) >= 60).map((item) => item.subject)
    : []),
].map(normalizeSupportedSubject).filter(Boolean))];

const isTutor = (profile = {}) => profile.role === 'tutor' || profile.role === 'teacher'
  || profile.isTeacher === true || profile.isTeacher === 'true';
const userLabel = (profile = {}, fallback = 'User') => profile.displayName || profile.name || profile.email || fallback;
const toMillis = (value) => value?.toMillis?.() ?? (value instanceof Date ? value.getTime() : Number(value) || 0);
const dateLabel = (value) => {
  const millis = toMillis(value);
  return millis ? new Date(millis).toLocaleDateString('en-ZA') : '—';
};

const readUsersAndActiveEpisodes = async (db) => {
  const [usersSnapshot, episodesSnapshot] = await Promise.all([
    db.collection('users').get(),
    db.collectionGroup('subjects').get(),
  ]);
  const users = usersSnapshot.docs.map((document) => ({ uid: document.id, ...document.data() }));
  const userById = new Map(users.map((profile) => [profile.uid, profile]));
  const activeEpisodes = episodesSnapshot.docs
    .map((document) => ({ id: document.id, ...document.data() }))
    .filter((episode) => episode.status === 'active' && episode.studentId && userById.get(episode.studentId)?.role === 'student');
  return { users, userById, activeEpisodes };
};

const getTutorOptions = (users, subject = null) => users
  .filter((profile) => isTutor(profile))
  .map((profile) => ({
    uid: profile.uid,
    displayName: profile.displayName || profile.name || '',
    email: profile.email || '',
    role: profile.role,
    isTeacher: profile.isTeacher === true || profile.isTeacher === 'true' || profile.role === 'teacher',
    subjects: getApprovedSubjects(profile),
  }))
  .map((tutor) => ({ ...tutor, subjects: subject ? tutor.subjects.filter((item) => item === subject) : tutor.subjects }))
  .filter((tutor) => tutor.subjects.length)
  .sort((left, right) => userLabel(left).localeCompare(userLabel(right)));

const getAssignmentsForSubject = ({ subject, users, userById, activeEpisodes }) => {
  const subjectEpisodes = activeEpisodes.filter((episode) => normalizeSupportedSubject(episode.subjectKey) === subject);
  const students = [...new Map(subjectEpisodes.map((episode) => [episode.studentId, userById.get(episode.studentId)])).values()]
    .filter(Boolean)
    .map((student) => ({ uid: student.uid, displayName: student.displayName || student.name || '', email: student.email || '' }));
  const tutors = getTutorOptions(users, subject);
  const tutorById = new Map(tutors.map((tutor) => [tutor.uid, tutor]));
  const studentById = new Map(students.map((student) => [student.uid, student]));
  const assignments = subjectEpisodes.filter((episode) => Boolean(episode.primaryTutorId)).map((episode) => {
    const tutor = tutorById.get(episode.primaryTutorId);
    return {
      id: episode.id,
      studentId: episode.studentId,
      tutorId: episode.primaryTutorId,
      subject,
      studentName: userLabel(studentById.get(episode.studentId), 'Student'),
      tutorName: userLabel(tutor, 'Tutor'),
      tutorRoleLabel: tutor?.isTeacher ? 'Teacher' : 'Tutor',
    };
  });
  const assignedStudentIds = new Set(assignments.map((assignment) => assignment.studentId));
  return { students, tutors, assignments, unassignedStudents: students.filter((student) => !assignedStudentIds.has(student.uid)) };
};

const getGuideQuizSummary = async (db, users) => {
  const resultSnapshot = await db.collectionGroup('guideQuizResults').get();
  const latestByUser = new Map();
  resultSnapshot.docs
    .map((document) => ({ id: document.id, ...document.data(), userId: document.data().userId || document.ref.parent.parent?.id }))
    .sort((left, right) => toMillis(right.submittedAt) - toMillis(left.submittedAt))
    .forEach((result) => {
      if (result.userId && !latestByUser.has(result.userId)) latestByUser.set(result.userId, result);
    });
  const summaryRow = (profile) => ({
    id: profile.uid,
    name: userLabel(profile, profile.role === 'student' ? 'Student' : 'Tutor'),
    percentage: latestByUser.get(profile.uid)?.percentage ?? null,
  });
  return {
    students: users.filter((profile) => profile.role === 'student').map(summaryRow),
    tutors: users.filter((profile) => isTutor(profile)).map(summaryRow),
  };
};

const getUserManagementData = (users, activeEpisodes) => {
  const subjectsByStudent = new Map();
  const assignedStudentsByTutor = new Map();
  activeEpisodes.forEach((episode) => {
    if (episode.subjectKey) {
      const subjects = subjectsByStudent.get(episode.studentId) ?? new Set();
      subjects.add(normalizeSupportedSubject(episode.subjectKey) || episode.subjectKey);
      subjectsByStudent.set(episode.studentId, subjects);
    }
    if (episode.primaryTutorId) {
      const students = assignedStudentsByTutor.get(episode.primaryTutorId) ?? new Set();
      students.add(episode.studentId);
      assignedStudentsByTutor.set(episode.primaryTutorId, students);
    }
  });

  return {
    students: users.filter((profile) => profile.role === 'student').map((profile) => ({
      id: profile.uid,
      name: userLabel(profile, 'Student'),
      subjects: [...(subjectsByStudent.get(profile.uid) ?? [])].sort((left, right) => left.localeCompare(right)),
      subscriptionPlanName: profile.subscriptionPlanName || 'Free',
    })),
    tutors: users.filter((profile) => isTutor(profile)).map((profile) => ({
      id: profile.uid,
      name: userLabel(profile, 'Tutor'),
      subjects: getApprovedSubjects(profile),
      studentCount: assignedStudentsByTutor.get(profile.uid)?.size ?? 0,
    })),
    tutorOptions: getTutorOptions(users),
  };
};

const getDashboard = async (db, users, userById, activeEpisodes) => {
  const paymentsSnapshot = await db.collectionGroup('payments').get();
  const payments = paymentsSnapshot.docs
    .map((document) => ({ id: document.id, ...document.data() }))
    .sort((left, right) => toMillis(right.createdAt || right.updatedAt) - toMillis(left.createdAt || left.updatedAt))
    .slice(0, 8)
    .map((payment) => ({
      id: payment.id,
      studentName: payment.studentName || userLabel(userById.get(payment.studentId), 'Student'),
      amount: payment.currency && payment.amount !== undefined ? `${payment.currency} ${payment.amount}` : payment.amount ?? '—',
      status: payment.status || 'unknown',
      month: dateLabel(payment.createdAt || payment.updatedAt),
    }));
  const tutors = getTutorOptions(users).map((tutor) => ({
    id: tutor.uid,
    name: userLabel(tutor, 'Tutor'),
    students: activeEpisodes.filter((episode) => episode.primaryTutorId === tutor.uid).length,
    province: userById.get(tutor.uid)?.province || '—',
  }));
  const students = users.filter((profile) => profile.role === 'student').length;
  return {
    stats: [
      { label: 'Students', value: students, detail: 'Registered student accounts' },
      { label: 'Tutors and teachers', value: tutors.length, detail: 'With at least one approved subject' },
      { label: 'Active subject assignments', value: activeEpisodes.length, detail: 'Across all student subjects' },
      { label: 'Verified payment records', value: paymentsSnapshot.size, detail: 'Payments stored in student accounts' },
    ],
    payments,
    tutors,
  };
};

export const getAdminWorkspaceData = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const db = getDb();
  await requireAdmin(request, db);
  const scope = String(request.data?.scope || '');
  if (!['dashboard', 'tutors', 'assignments', 'guide-results', 'user-management'].includes(scope)) {
    throw new HttpsError('invalid-argument', 'Choose valid admin workspace data.');
  }
  if (scope === 'guide-results') {
    const usersSnapshot = await db.collection('users').get();
    const users = usersSnapshot.docs.map((document) => ({ uid: document.id, ...document.data() }));
    return getGuideQuizSummary(db, users);
  }

  const { users, userById, activeEpisodes } = await readUsersAndActiveEpisodes(db);
  if (scope === 'user-management') return getUserManagementData(users, activeEpisodes);
  if (scope === 'dashboard') return getDashboard(db, users, userById, activeEpisodes);
  if (scope === 'tutors') return getTutorOptions(users);

  const subject = normalizeSupportedSubject(request.data?.subject);
  if (!subject) throw new HttpsError('invalid-argument', 'Choose a supported subject.');
  return getAssignmentsForSubject({ subject, users, userById, activeEpisodes });
});

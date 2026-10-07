import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getDb } from './admin.js';
import { normalizeSupportedSubject } from './subjects.js';

const recordRead = async (metrics, read) => {
  metrics.firestoreReadOperations += 1;
  const result = await read();
  metrics.firestoreDocumentsReturned += Number(result?.size ?? (result?.exists ? 1 : 0));
  return result;
};

const requireAdmin = async (request, db, metrics) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in as an admin to open this workspace.');
  const actor = await recordRead(metrics, () => db.collection('users').doc(uid).get());
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
const safeDateMillis = (value) => {
  if (!value) return null;
  const timestamp = toMillis(value) || new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
};
const dateLabel = (value) => {
  const millis = toMillis(value);
  return millis ? new Date(millis).toLocaleDateString('en-ZA') : '—';
};

const readUsersAndActiveEpisodes = async (db, metrics) => {
  const [usersSnapshot, episodesSnapshot] = await Promise.all([
    recordRead(metrics, () => db.collection('users').get()),
    recordRead(metrics, async () => {
      try {
        return await db.collectionGroup('subjects').where('status', '==', 'active').get();
      } catch (error) {
        if (error?.code !== 9 && error?.code !== 'failed-precondition') throw error;
        logger.warn('Admin workspace is using an unfiltered subject read while the collection-group status index builds.');
        metrics.firestoreReadOperations += 1;
        return db.collectionGroup('subjects').get();
      }
    }),
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

const getGuideQuizSummary = async (db, users, metrics) => {
  const resultSnapshot = await recordRead(metrics, () => db.collectionGroup('guideQuizResults').get());
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

const getUserManagementData = (users) => {
  const tutorOptions = getTutorOptions(users);
  const initialSubject = tutorOptions[0]?.subjects?.[0] ?? '';
  return {
    users: users.map((profile) => ({
      id: profile.uid,
      name: userLabel(profile, 'Name unavailable'),
      email: profile.email || '',
      role: isTutor(profile) && (profile.isTeacher === true || profile.isTeacher === 'true' || profile.role === 'teacher')
        ? 'teacher'
        : (String(profile.role || 'unknown').toLowerCase()),
      lastLoginAt: safeDateMillis(profile.lastLoginAt),
    })).sort((left, right) => left.name.localeCompare(right.name)),
    tutorOptions,
    initialSubject,
  };
};

const safeProfileDetails = (profile, uid) => ({
  uid,
  name: profile.displayName || profile.name || profile.fullName || profile.email || 'Name unavailable',
  email: profile.email || '',
  role: isTutor(profile) && (profile.isTeacher === true || profile.isTeacher === 'true' || profile.role === 'teacher')
    ? 'teacher'
    : String(profile.role || 'unknown').toLowerCase(),
  phone: profile.whatsappNumber || profile.phoneNumber || profile.phone || '',
  grade: profile.grade || '',
  educationLevel: profile.educationLevel || '',
  school: profile.school || profile.schoolName || '',
  province: profile.province || '',
  accountStatus: profile.accountStatus || profile.status || '',
  lastLoginAt: safeDateMillis(profile.lastLoginAt),
  createdAt: safeDateMillis(profile.createdAt),
  updatedAt: safeDateMillis(profile.updatedAt),
});

const getStudentAdminDetails = async (db, userId, metrics) => {
  const subjectsSnapshot = await recordRead(metrics, () => db.collection('users').doc(userId).collection('subjects').get());
  const subjects = subjectsSnapshot.docs.map((document) => {
    const subject = document.data();
    return {
      id: document.id,
      subject: normalizeSupportedSubject(subject.subjectKey || subject.subjectName || subject.subject) || subject.subjectKey || subject.subjectName || subject.subject || 'Subject',
      status: String(subject.status || 'historical').toLowerCase(),
      grade: subject.grade || '',
      createdAt: safeDateMillis(subject.createdAt),
      cancelledAt: safeDateMillis(subject.cancelledAt),
    };
  }).sort((left, right) => left.subject.localeCompare(right.subject));
  return { subjects };
};

const getTutorAdminDetails = async (db, userId, profile, metrics) => {
  const collectionGroup = db.collectionGroup('subjects');
  const [primarySnapshot, activeStaffSnapshot, historicalStaffSnapshot] = await Promise.all([
    recordRead(metrics, () => collectionGroup.where('primaryTutorId', '==', userId).get()),
    recordRead(metrics, () => collectionGroup.where('activeStaffIds', 'array-contains', userId).get()),
    recordRead(metrics, () => collectionGroup.where('historicalStaffIds', 'array-contains', userId).get()),
  ]);
  const documents = new Map();
  [...primarySnapshot.docs, ...activeStaffSnapshot.docs, ...historicalStaffSnapshot.docs]
    .forEach((document) => documents.set(document.ref.path, document));
  const assignments = [...documents.values()].map((document) => {
    const episode = document.data();
    const isPrimaryTutor = episode.primaryTutorId === userId;
    return {
      id: document.id,
      studentId: document.ref.parent.parent?.id || episode.studentId || '',
      studentName: episode.studentName || 'Student',
      subject: normalizeSupportedSubject(episode.subjectKey || episode.subjectName || episode.subject) || episode.subjectKey || episode.subjectName || episode.subject || 'Subject',
      grade: episode.grade || '',
      status: String(episode.status || 'historical').toLowerCase(),
      accessRole: isPrimaryTutor ? 'primary tutor' : (episode.staffByUid?.[userId] || 'historical access'),
    };
  }).filter((assignment) => assignment.studentId)
    .sort((left, right) => left.studentName.localeCompare(right.studentName) || left.subject.localeCompare(right.subject));
  const uniqueActivePrimaryStudents = new Set(assignments
    .filter((assignment) => assignment.status === 'active' && assignment.accessRole === 'primary tutor')
    .map((assignment) => assignment.studentId));
  const uniqueActiveSharedStudents = new Set(assignments
    .filter((assignment) => assignment.status === 'active' && assignment.accessRole !== 'primary tutor')
    .map((assignment) => assignment.studentId));
  const marksBySubject = new Map((Array.isArray(profile.tutorSubjectMarks) ? profile.tutorSubjectMarks : [])
    .filter((item) => item && normalizeSupportedSubject(item.subject || item.rawSubject))
    .map((item) => [normalizeSupportedSubject(item.subject || item.rawSubject), Number.isFinite(Number(item.mark)) ? Number(item.mark) : null]));
  const subjects = [...new Set([
    ...(Array.isArray(profile.subjects) ? profile.subjects : []),
    ...(profile.subject ? [profile.subject] : []),
    ...marksBySubject.keys(),
  ].map(normalizeSupportedSubject).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .map((subject) => ({ subject, mark: marksBySubject.get(subject) ?? null, approved: getApprovedSubjects(profile).includes(subject) }));
  return {
    subjects,
    assignments,
    activePrimaryStudentCount: uniqueActivePrimaryStudents.size,
    activeSharedStudentCount: uniqueActiveSharedStudents.size,
  };
};

const getParentAdminDetails = async (db, userId, metrics) => {
  const studentsSnapshot = await recordRead(metrics, () => db.collection('users')
    .where('parentId', '==', userId)
    .where('role', '==', 'student')
    .get());
  const students = studentsSnapshot.docs.map((document) => {
    const student = document.data();
    return {
      id: document.id,
      name: userLabel(student, 'Student'),
      email: student.email || '',
      grade: student.grade || '',
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  return { students };
};

const getUserDetails = async (db, userId, metrics) => {
  if (!userId || typeof userId !== 'string') throw new HttpsError('invalid-argument', 'Choose a user to view.');
  const userSnapshot = await recordRead(metrics, () => db.collection('users').doc(userId).get());
  if (!userSnapshot.exists) throw new HttpsError('not-found', 'This user account could not be found.');
  const profile = userSnapshot.data();
  const details = { profile: safeProfileDetails(profile, userId) };
  if (profile.role === 'student') details.student = await getStudentAdminDetails(db, userId, metrics);
  else if (isTutor(profile)) details.tutor = await getTutorAdminDetails(db, userId, profile, metrics);
  else if (profile.role === 'parent') details.parent = await getParentAdminDetails(db, userId, metrics);
  return details;
};

const getDashboard = async (db, users, userById, activeEpisodes, metrics) => {
  const paymentsQuery = db.collectionGroup('payments');
  const [paymentCountSnapshot, createdAtSnapshot, updatedAtSnapshot] = await Promise.all([
    recordRead(metrics, () => paymentsQuery.count().get()),
    recordRead(metrics, () => paymentsQuery.orderBy('createdAt', 'desc').limit(8).get()).catch((error) => {
      if (error?.code !== 9 && error?.code !== 'failed-precondition') throw error;
      logger.warn('Admin dashboard is using a full payment read while the createdAt collection-group index builds.');
      return null;
    }),
    recordRead(metrics, () => paymentsQuery.orderBy('updatedAt', 'desc').limit(8).get()).catch((error) => {
      if (error?.code !== 9 && error?.code !== 'failed-precondition') throw error;
      logger.warn('Admin dashboard is using a full payment read while the updatedAt collection-group index builds.');
      return null;
    }),
  ]);
  const paymentCount = paymentCountSnapshot.data().count;
  const paymentDocuments = new Map();
  [...(createdAtSnapshot?.docs ?? []), ...(updatedAtSnapshot?.docs ?? [])].forEach((document) => paymentDocuments.set(document.ref.path, document));
  let recentPaymentDocuments = [...paymentDocuments.values()];
  if (!createdAtSnapshot || !updatedAtSnapshot || recentPaymentDocuments.length < Math.min(8, paymentCount)) {
    const allPaymentsSnapshot = await recordRead(metrics, () => paymentsQuery.get());
    recentPaymentDocuments = allPaymentsSnapshot.docs;
  }
  const payments = recentPaymentDocuments
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
      { label: 'Verified payment records', value: paymentCount, detail: 'Payments stored in student accounts' },
    ],
    payments,
    tutors,
  };
};

export const getAdminWorkspaceData = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const db = getDb();
  const scope = String(request.data?.scope || '');
  const startedAt = Date.now();
  const metrics = { firestoreReadOperations: 0, firestoreDocumentsReturned: 0 };
  try {
    await requireAdmin(request, db, metrics);
    if (!['dashboard', 'tutors', 'assignments', 'guide-results', 'user-management', 'user-details'].includes(scope)) {
      throw new HttpsError('invalid-argument', 'Choose valid admin workspace data.');
    }
    let result;
    if (scope === 'user-details') {
      result = await getUserDetails(db, String(request.data?.userId || '').trim(), metrics);
    } else if (scope === 'user-management') {
      const usersSnapshot = await recordRead(metrics, () => db.collection('users').get());
      const users = usersSnapshot.docs.map((document) => ({ uid: document.id, ...document.data() }));
      result = getUserManagementData(users);
    } else if (scope === 'guide-results') {
      const usersSnapshot = await recordRead(metrics, () => db.collection('users').get());
      const users = usersSnapshot.docs.map((document) => ({ uid: document.id, ...document.data() }));
      result = await getGuideQuizSummary(db, users, metrics);
    } else {
      const { users, userById, activeEpisodes } = await readUsersAndActiveEpisodes(db, metrics);
      if (scope === 'dashboard') result = await getDashboard(db, users, userById, activeEpisodes, metrics);
      else if (scope === 'tutors') result = getTutorOptions(users);
      else {
        const subject = normalizeSupportedSubject(request.data?.subject);
        if (!subject) throw new HttpsError('invalid-argument', 'Choose a supported subject.');
        result = getAssignmentsForSubject({ subject, users, userById, activeEpisodes });
      }
    }

    logger.info('Admin workspace loaded', {
      scope,
      durationMs: Date.now() - startedAt,
      ...metrics,
    });
    return result;
  } catch (error) {
    logger.error('Admin workspace load failed', {
      scope,
      durationMs: Date.now() - startedAt,
      ...metrics,
      code: error?.code ?? null,
      message: error?.message ?? String(error),
    });
    throw error;
  }
});

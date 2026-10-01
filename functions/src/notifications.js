import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { admin, getDb } from './admin.js';

const unique = (values = []) => [...new Set(values.filter(Boolean))];

const getTokenRows = async (db, userId) => {
  const snapshot = await db.collection('users')
    .doc(userId)
    .collection('notificationTokens')
    .where('active', '==', true)
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() })).filter((row) => row.token);
};

export const getAdminIds = async (db) => {
  const snapshot = await db.collection('users').where('role', '==', 'admin').get();
  return snapshot.docs.map((doc) => doc.id);
};

export const getParentIdsForStudent = async (db, studentId) => {
  if (!studentId) return [];
  const studentSnap = await db.collection('users').doc(studentId).get();
  const student = studentSnap.exists ? studentSnap.data() : {};
  return unique([student.parentId]);
};

export const getTutorIdsForStudentSubject = async (db, studentId, subject) => {
  if (!studentId || !subject) return [];
  const snapshot = await db.collection('tutorStudentAssignments')
    .where('studentId', '==', studentId)
    .where('subject', '==', subject)
    .where('active', '==', true)
    .get();
  return unique(snapshot.docs.map((doc) => doc.data().tutorId));
};

export const sendNotificationToUsers = async ({
  userIds,
  title,
  body,
  type,
  url = '/',
  data = {},
  tag,
}) => {
  const db = getDb();
  const targetUserIds = unique(userIds);
  if (!targetUserIds.length) return { userCount: 0, successCount: 0, failureCount: 0 };

  const results = await Promise.all(targetUserIds.map(async (userId) => {
    const tokens = await getTokenRows(db, userId);
    const notificationRef = db.collection('users').doc(userId).collection('notifications').doc();
    await notificationRef.set({
      title,
      body,
      type,
      url,
      tag: tag ?? type,
      read: false,
      data,
      createdAt: new Date(),
    });

    if (!tokens.length) {
      return { userId, successCount: 0, failureCount: 0, tokenCount: 0 };
    }

    const response = await admin.messaging().sendEachForMulticast({
      tokens: tokens.map((row) => row.token),
      notification: { title, body },
      webpush: {
        fcmOptions: { link: url },
        notification: {
          icon: '/logo.png',
          badge: '/logo.png',
          tag: tag ?? `${type}-${notificationRef.id}`,
          requireInteraction: true,
        },
      },
      data: Object.fromEntries(Object.entries({
        ...data,
        type,
        notificationId: notificationRef.id,
        url,
        tag: tag ?? type,
      }).map(([key, value]) => [key, String(value ?? '')])),
    });

    const cleanupBatch = db.batch();
    response.responses.forEach((result, index) => {
      const code = result.error?.code ?? '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
        cleanupBatch.set(tokens[index].ref, { active: false, invalidatedAt: new Date(), invalidationReason: code }, { merge: true });
      }
    });
    cleanupBatch.set(db.collection('notificationLogs').doc(), {
      type,
      userId,
      title,
      body,
      url,
      tokenCount: tokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
      createdAt: new Date(),
    });
    await cleanupBatch.commit();
    return { userId, successCount: response.successCount, failureCount: response.failureCount, tokenCount: tokens.length };
  }));

  return results.reduce((summary, result) => ({
    userCount: summary.userCount + 1,
    successCount: summary.successCount + result.successCount,
    failureCount: summary.failureCount + result.failureCount,
  }), { userCount: 0, successCount: 0, failureCount: 0 });
};

const hasNewSubmission = (before, after) => Boolean(
  after?.submittedImageUrl && after?.submittedFileName &&
  (!before?.submittedImageUrl || before.submittedImageUrl !== after.submittedImageUrl)
);

const statusChanged = (before, after) => before?.status !== after?.status;

export const notifyNewUser = onDocumentCreated(
  { document: 'users/{userId}', timeoutSeconds: 60, memory: '256MiB', cpu: 'gcf_gen1' },
  async (event) => {
    const db = getDb();
    const user = event.data?.data();
    if (!user) return;
    const adminIds = await getAdminIds(db);
    await sendNotificationToUsers({
      userIds: adminIds,
      title: 'New Examifying user',
      body: `${user.displayName || user.email || 'A user'} registered as ${user.role || 'a user'}.`,
      type: 'user.created',
      url: '/admin/users',
      data: { userId: event.params.userId, role: user.role ?? '' },
      tag: `user-created-${event.params.userId}`,
    });
  }
);

export const notifyExerciseSubmission = onDocumentWritten(
  { document: 'dailyExerciseAssignments/{exerciseId}', timeoutSeconds: 90, memory: '256MiB', cpu: 'gcf_gen1' },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after || !hasNewSubmission(before, after)) return;

    const db = getDb();
    const [adminIds, parentIds, tutorIds] = await Promise.all([
      getAdminIds(db),
      getParentIdsForStudent(db, after.studentId),
      getTutorIdsForStudentSubject(db, after.studentId, after.subject),
    ]);
    const studentName = after.studentName || 'A student';
    await sendNotificationToUsers({
      userIds: unique([...adminIds, ...parentIds, ...tutorIds]),
      title: 'Exercise submitted',
      body: `${studentName} submitted ${after.subject || 'an'} exercise for marking.`,
      type: 'exercise.submitted',
      url: `/tutor/exercises/${event.params.exerciseId}`,
      data: { exerciseId: event.params.exerciseId, studentId: after.studentId ?? '', subject: after.subject ?? '' },
      tag: `exercise-submitted-${event.params.exerciseId}`,
    });
  }
);

export const notifyPeerMarkingCompleted = onDocumentWritten(
  { document: 'peerMarkingAssignments/{assignmentId}', timeoutSeconds: 90, memory: '256MiB', cpu: 'gcf_gen1' },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after || after.status !== 'completed' || before?.status === 'completed') return;

    const db = getDb();
    const [parentIds, tutorIds] = await Promise.all([
      getParentIdsForStudent(db, after.revieweeId),
      getTutorIdsForStudentSubject(db, after.revieweeId, after.subject),
    ]);
    await sendNotificationToUsers({
      userIds: unique([after.revieweeId, ...parentIds, ...tutorIds]),
      title: 'Peer marking completed',
      body: `${after.subject || 'Your'} exercise has been peer marked.`,
      type: 'peer-marking.completed',
      url: `/student/exercises/${after.exerciseId}`,
      data: { assignmentId: event.params.assignmentId, exerciseId: after.exerciseId ?? '', subject: after.subject ?? '' },
      tag: `peer-marking-completed-${event.params.assignmentId}`,
    });
  }
);

export const notifyPaymentStatus = onDocumentWritten(
  { document: 'payments/{paymentId}', timeoutSeconds: 90, memory: '256MiB', cpu: 'gcf_gen1' },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after || !after.status || !statusChanged(before, after) || after.status === 'initialized') return;

    const db = getDb();
    const studentIds = unique([
      after.studentId,
      ...(Array.isArray(after.studentIds) ? after.studentIds : []),
    ]);
    const parents = (await Promise.all(studentIds.map((studentId) => getParentIdsForStudent(db, studentId)))).flat();
    const adminIds = await getAdminIds(db);
    const succeeded = after.status === 'success';
    await sendNotificationToUsers({
      userIds: unique([...studentIds, ...parents, ...adminIds]),
      title: succeeded ? 'Payment successful' : 'Payment update',
      body: succeeded ? 'Payment was successful and access is active.' : `Payment status changed to ${after.status}.`,
      type: succeeded ? 'payment.success' : 'payment.failed',
      url: '/student/billing',
      data: { paymentId: event.params.paymentId, status: after.status, reference: after.reference ?? event.params.paymentId },
      tag: `payment-${event.params.paymentId}-${after.status}`,
    });
  }
);

export const notifyTutorAssignment = onDocumentWritten(
  { document: 'tutorStudentAssignments/{assignmentId}', timeoutSeconds: 90, memory: '256MiB', cpu: 'gcf_gen1' },
  async (event) => {
    const db = getDb();
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const assignment = event.data?.after?.exists ? event.data.after.data() : null;
    if (!assignment?.studentId || !assignment?.tutorId || assignment.active !== true || before?.active === true) return;
    const parentIds = await getParentIdsForStudent(db, assignment.studentId);
    await sendNotificationToUsers({
      userIds: unique([assignment.studentId, assignment.tutorId, ...parentIds]),
      title: 'Tutor assignment updated',
      body: `A tutor has been assigned for ${assignment.subject || 'your subject'}.`,
      type: 'tutor-assignment.created',
      url: assignment.tutorId ? '/student/profile/subjects' : '/',
      data: { assignmentId: event.params.assignmentId, studentId: assignment.studentId, tutorId: assignment.tutorId, subject: assignment.subject ?? '' },
      tag: `tutor-assignment-${event.params.assignmentId}`,
    });
  }
);

export const notifyTutorReport = onDocumentCreated(
  { document: 'tutorReports/{reportId}', timeoutSeconds: 90, memory: '256MiB', cpu: 'gcf_gen1' },
  async (event) => {
    const db = getDb();
    const report = event.data?.data();
    if (!report?.studentId) return;
    const parentIds = await getParentIdsForStudent(db, report.studentId);
    await sendNotificationToUsers({
      userIds: unique([report.studentId, ...parentIds]),
      title: 'New tutor report',
      body: `A tutor report was added for ${report.subject || 'your subject'}.`,
      type: 'tutor-report.created',
      url: '/student/lessons',
      data: { reportId: event.params.reportId, studentId: report.studentId, subject: report.subject ?? '' },
      tag: `tutor-report-${event.params.reportId}`,
    });
  }
);

export const notifyCompletedLesson = onDocumentCreated(
  { document: 'coveredTopics/{lessonId}', timeoutSeconds: 90, memory: '256MiB', cpu: 'gcf_gen1' },
  async (event) => {
    const db = getDb();
    const lesson = event.data?.data();
    if (!lesson?.studentId) return;
    const parentIds = await getParentIdsForStudent(db, lesson.studentId);
    await sendNotificationToUsers({
      userIds: unique([lesson.studentId, ...parentIds]),
      title: 'Lesson completed',
      body: `${lesson.subject || 'A'} lesson was completed and will guide future exercises.`,
      type: 'lesson.completed',
      url: '/student/lessons',
      data: { lessonId: event.params.lessonId, studentId: lesson.studentId, subject: lesson.subject ?? '' },
      tag: `lesson-completed-${event.params.lessonId}`,
    });
  }
);

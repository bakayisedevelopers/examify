import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';
import { admin, getDb } from './admin.js';
import { queueBrandedEmail } from './resendEmail.js';
import { isNotificationChannelEnabled } from './notificationPreferences.js';

const unique = (values = []) => [...new Set(values.filter(Boolean))];

const safelyQueueEmail = async (message) => {
  try {
    return await queueBrandedEmail(message);
  } catch (error) {
    logger.error('Could not queue a notification email', {
      type: message.type,
      eventId: message.eventId,
      error: error?.message || String(error),
    });
    return null;
  }
};

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
  const snapshot = await db.collection('users').doc(studentId).collection('subjects')
    .where('subjectKey', '==', subject).where('status', '==', 'active').limit(1).get();
  return snapshot.empty ? [] : unique(snapshot.docs[0].data().activeStaffIds ?? []);
};

const getProfiles = async (db, userIds = []) => {
  const ids = unique(userIds);
  const snapshots = await Promise.all(ids.map((id) => db.collection('users').doc(id).get()));
  return snapshots.flatMap((snapshot, index) => snapshot.exists
    ? [{ uid: ids[index], ...snapshot.data() }]
    : []);
};

const enqueueEmailForProfiles = async ({ profiles, type, eventId, contentFor }) => {
  await Promise.all(profiles.map(async (profile) => {
    const content = contentFor(profile);
    await safelyQueueEmail({
      type,
      eventId,
      to: profile.email,
      name: profile.displayName || profile.name || '',
      ...content,
    });
  }));
};

const paymentEmail = (payment = {}) => {
  const status = String(payment.status || '').toLowerCase();
  const labels = {
    initialized: { label: 'pending', heading: 'Payment started', text: 'Your checkout is open and waiting for Paystack to confirm the transaction.' },
    pending: { label: 'pending', heading: 'Payment pending', text: 'Paystack is still processing your payment.' },
    processing: { label: 'pending', heading: 'Payment being verified', text: 'Your payment is being verified. You do not need to pay again while verification is in progress.' },
    verification_pending: { label: 'pending', heading: 'Payment being verified', text: 'Your payment is being verified. You do not need to pay again while verification is in progress.' },
    success: { label: 'successful', heading: payment.authorizationOnly ? 'Card authorization verified' : 'Payment successful', text: 'Your payment was verified by Paystack.' },
    failed: { label: 'failed', heading: 'Payment failed', text: 'Paystack could not complete this payment. You can review your subscription and try again.' },
    abandoned: { label: 'not completed', heading: 'Checkout not completed', text: 'This checkout was not completed, so no subscription payment was confirmed.' },
    cancelled: { label: 'cancelled', heading: 'Checkout cancelled', text: 'This checkout was cancelled before the payment was confirmed.' },
    reversed: { label: 'reversed', heading: 'Payment reversed', text: 'Paystack reported that this payment was reversed.' },
    past_due: { label: 'unsuccessful', heading: 'Subscription renewal needs attention', text: 'A subscription renewal did not complete. Please review the billing page to keep access active.' },
    amount_mismatch: { label: 'under review', heading: 'Payment needs review', text: 'The verified payment amount did not match the checkout. The payment has been held for review.' },
    refunded: { label: 'refunded', heading: 'Payment refunded', text: 'A refund was recorded for this payment.' },
  };
  return labels[status] || null;
};

const authorizationRefundEmail = (status) => {
  const labels = {
    pending: { label: 'pending', heading: 'Temporary authorization refund pending', text: 'Paystack accepted the refund request. The refund is still being processed.' },
    processing: { label: 'processing', heading: 'Temporary authorization refund processing', text: 'Paystack is processing the refund for your temporary card authorization.' },
    processed: { label: 'processed', heading: 'Temporary authorization refunded', text: 'Paystack reports that the temporary card authorization refund has been processed.' },
    success: { label: 'processed', heading: 'Temporary authorization refunded', text: 'Paystack reports that the temporary card authorization refund has been processed.' },
    failed: { label: 'failed', heading: 'Temporary authorization refund needs attention', text: 'The automatic refund request did not complete. Examifying has recorded it for follow-up.' },
    'needs-attention': { label: 'under review', heading: 'Temporary authorization refund under review', text: 'The refund needs manual reconciliation. Your subscription remains active while the refund is reviewed.' },
  };
  return labels[String(status || '').toLowerCase()] || null;
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

  const profiles = new Map((await getProfiles(db, targetUserIds)).map((profile) => [profile.uid, profile]));
  const enabledUserIds = targetUserIds.filter((userId) => (
    isNotificationChannelEnabled(profiles.get(userId), type, 'inApp')
  ));
  if (!enabledUserIds.length) return { userCount: 0, successCount: 0, failureCount: 0 };

  const results = await Promise.all(enabledUserIds.map(async (userId) => {
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
    cleanupBatch.set(db.collection('users').doc(userId).collection('notificationLogs').doc(), {
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
    await enqueueEmailForProfiles({
      profiles: [{ uid: event.params.userId, ...user }],
      type: 'account.created',
      eventId: event.id || event.params.userId,
      contentFor: () => ({
        subject: 'Welcome to Examifying',
        heading: 'Your account is ready',
        paragraphs: [
          'Your Examifying account has been created. You can now continue setting up your learning or teaching profile.',
        ],
        actionLabel: 'Open Examifying',
        actionUrl: user.role === 'student'
          ? '/student'
          : user.role === 'parent'
            ? '/parent'
            : user.role === 'admin'
              ? '/admin'
              : user.isTeacher === true || user.role === 'teacher' ? '/teacher' : '/tutor',
      }),
    });
  }
);

export const notifyExerciseSubmission = onDocumentWritten(
  { document: 'users/{studentId}/subjects/{subjectInstanceId}/exercises/{exerciseId}', timeoutSeconds: 90, memory: '256MiB', cpu: 'gcf_gen1' },
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
  { document: 'users/{studentId}/subjects/{subjectInstanceId}/exercises/{exerciseId}/peerMarkingAssignments/{assignmentId}', timeoutSeconds: 90, memory: '256MiB', cpu: 'gcf_gen1' },
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
  { document: 'users/{studentId}/payments/{paymentId}', timeoutSeconds: 90, memory: '256MiB', cpu: 'gcf_gen1' },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after || !after.status) return;

    const paymentStatusDidChange = statusChanged(before, after);
    const refundStatusDidChange = before?.authorizationRefundStatus !== after.authorizationRefundStatus;
    if (!paymentStatusDidChange && !refundStatusDidChange) return;

    const presentation = paymentStatusDidChange
      ? paymentEmail(after)
      : after.authorizationOnly === true ? authorizationRefundEmail(after.authorizationRefundStatus) : null;
    if (!presentation) return;

    const db = getDb();
    const studentIds = unique([
      after.studentId,
      ...(Array.isArray(after.studentIds) ? after.studentIds : []),
    ]);
    const parents = (await Promise.all(studentIds.map((studentId) => getParentIdsForStudent(db, studentId)))).flat();
    const recipientIds = unique([...studentIds, ...parents, after.payerId]);
    const profiles = await getProfiles(db, recipientIds);
    const succeeded = after.status === 'success';
    if (paymentStatusDidChange && after.status !== 'initialized') {
      await sendNotificationToUsers({
        userIds: recipientIds,
        title: succeeded ? 'Payment successful' : 'Payment update',
        body: succeeded ? 'Payment was successful and access is active.' : `Payment status changed to ${after.status}.`,
        type: succeeded ? 'payment.success' : 'payment.failed',
        url: '/student/billing',
        data: { paymentId: event.params.paymentId, status: after.status, reference: after.reference ?? event.params.paymentId },
        tag: `payment-${event.params.paymentId}-${after.status}`,
      });
    }
    await enqueueEmailForProfiles({
      profiles,
      type: paymentStatusDidChange ? `payment.${after.status}` : 'payment.authorization_refund',
      eventId: event.id || `${event.params.studentId}-${event.params.paymentId}-${after.status}`,
      contentFor: () => ({
        subject: presentation.heading,
        heading: presentation.heading,
        paragraphs: [presentation.text, ...(paymentStatusDidChange && after.authorizationOnly === true && succeeded ? [
          `The subscription charge today was R${Number(after.subscriptionAmountDue || 0).toFixed(2)}. The R${Number(after.authorizationChargeAmount || after.amount || 1).toFixed(2)} card authorization is temporary; its refund status is ${after.authorizationRefundStatus || 'being processed'}.`,
        ] : [])],
        details: [
          ...(after.planName || after.planId ? [{ label: 'Plan', value: after.planName || after.planId }] : []),
          ...(after.authorizationOnly === true
            ? [{ label: 'Temporary authorization', value: `${after.authorizationRefundCurrency || after.currency || 'ZAR'} ${Number(after.authorizationRefundAmount || after.authorizationChargeAmount || after.amount || 1).toFixed(2)}` }]
            : Number.isFinite(Number(after.amount))
              ? [{ label: 'Amount', value: `${after.currency || 'ZAR'} ${Number(after.amount).toFixed(2)}` }]
              : []),
          { label: 'Status', value: presentation.label },
          { label: 'Reference', value: after.reference || event.params.paymentId },
        ],
        actionLabel: 'View billing',
        actionUrl: '/student/billing',
      }),
    });
  }
);

export const notifyTutorAssignment = onDocumentWritten(
  { document: 'users/{studentId}/subjects/{subjectInstanceId}', timeoutSeconds: 90, memory: '256MiB', cpu: 'gcf_gen1' },
  async (event) => {
    const db = getDb();
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const assignment = event.data?.after?.exists ? event.data.after.data() : null;
    if (!assignment?.studentId || !assignment?.primaryTutorId || assignment.primaryTutorId === before?.primaryTutorId) return;
    const parentIds = await getParentIdsForStudent(db, assignment.studentId);
    await sendNotificationToUsers({
      userIds: unique([assignment.studentId, assignment.primaryTutorId, ...parentIds]),
      title: 'Tutor assignment updated',
      body: `A tutor has been assigned for ${assignment.subject || 'your subject'}.`,
      type: 'tutor-assignment.created',
      url: assignment.tutorId ? '/student/profile/subjects' : '/',
      data: { subjectInstanceId: event.params.subjectInstanceId, studentId: assignment.studentId, tutorId: assignment.primaryTutorId, subject: assignment.subjectKey ?? '' },
      tag: `tutor-assignment-${event.params.subjectInstanceId}`,
    });
    const assignmentProfiles = new Map((await getProfiles(db, [assignment.studentId, assignment.primaryTutorId]))
      .map((profile) => [profile.uid, profile]));
    const studentProfile = assignmentProfiles.get(assignment.studentId);
    const tutorProfile = assignmentProfiles.get(assignment.primaryTutorId);
    const studentName = studentProfile?.displayName || studentProfile?.name || studentProfile?.email || 'Student';
    const tutorName = tutorProfile?.displayName || tutorProfile?.name || tutorProfile?.email || 'Tutor';
    await Promise.all([
      safelyQueueEmail({
        type: 'tutor-assignment.student',
        eventId: event.id || event.params.subjectInstanceId,
        to: studentProfile?.email,
        name: studentProfile?.displayName || studentProfile?.name || '',
        subject: 'A tutor has been assigned to your subject',
        heading: 'Your tutor assignment is ready',
        paragraphs: [`${tutorName} has been assigned as your tutor for ${assignment.subject || assignment.subjectKey || 'your subject'}.`],
        details: [{ label: 'Subject', value: assignment.subject || assignment.subjectKey || 'Mathematics' }],
        actionLabel: 'View your subjects',
        actionUrl: '/student/profile/subjects',
      }),
      safelyQueueEmail({
        type: 'tutor-assignment.tutor',
        eventId: event.id || event.params.subjectInstanceId,
        to: tutorProfile?.email,
        name: tutorProfile?.displayName || tutorProfile?.name || '',
        subject: 'A student has been assigned to you',
        heading: 'New student assignment',
        paragraphs: [`You have been assigned to ${studentName} for ${assignment.subject || assignment.subjectKey || 'a subject'}.`],
        details: [{ label: 'Subject', value: assignment.subject || assignment.subjectKey || 'Mathematics' }],
        actionLabel: 'Open tutor dashboard',
        actionUrl: '/tutor',
      }),
    ]);
  }
);

export const notifyExerciseGenerationCompleted = onDocumentWritten(
  { document: 'users/{studentId}/subjects/{subjectInstanceId}/generationRuns/{runId}', timeoutSeconds: 90, memory: '256MiB', cpu: 'gcf_gen1' },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    const exerciseIds = unique(Array.isArray(after?.generatedExerciseIds) ? after.generatedExerciseIds : []);
    if (!after || after.status !== 'completed' || !after.lastTrigger || !after.generationRunId
      || before?.generationRunId === after.generationRunId || !exerciseIds.length) return;

    const db = getDb();
    const studentId = event.params.studentId;
    const subjectInstanceId = event.params.subjectInstanceId;
    const [studentSnapshot, episodeSnapshot, ...exerciseSnapshots] = await Promise.all([
      db.collection('users').doc(studentId).get(),
      db.collection('users').doc(studentId).collection('subjects').doc(subjectInstanceId).get(),
      ...exerciseIds.map((id) => db.collection('users').doc(studentId).collection('subjects').doc(subjectInstanceId).collection('exercises').doc(id).get()),
    ]);
    if (!studentSnapshot.exists || !episodeSnapshot.exists) return;
    const validExercises = exerciseSnapshots.filter((snapshot) => snapshot.exists
      && snapshot.data().studentId === studentId
      && snapshot.data().subjectInstanceId === subjectInstanceId);
    if (!validExercises.length) return;

    const student = studentSnapshot.data();
    const episode = episodeSnapshot.data();
    const recipientIds = unique([
      studentId,
      student.parentId,
      episode.primaryTutorId,
      ...(Array.isArray(episode.activeStaffIds) ? episode.activeStaffIds : []),
    ]);
    const profiles = await getProfiles(db, recipientIds);
    const studentName = student.displayName || student.name || student.email || 'Student';
    const subject = after.subject || episode.subjectKey || 'Mathematics';
    await sendNotificationToUsers({
      userIds: recipientIds,
      title: 'New exercises are ready',
      body: `Exercise generation completed for ${studentName} in ${subject}.`,
      type: 'exercise-generation.completed',
      url: '/student/exercises',
      data: { studentId, subjectInstanceId, subject, generationRunId: after.generationRunId },
      tag: `exercise-generation-${after.generationRunId}`,
    });
    await enqueueEmailForProfiles({
      profiles,
      type: 'exercise-generation.completed',
      eventId: after.generationRunId || event.id || `${studentId}-${subjectInstanceId}-${event.params.runId}`,
      contentFor: (profile) => {
        const isStudent = profile.uid === studentId;
        const isParent = profile.uid === student.parentId;
        return {
          subject: isStudent ? 'Your new exercises are ready' : `Exercises generated for ${studentName}`,
          heading: isStudent ? 'Your exercises are ready' : 'Exercise generation completed',
          paragraphs: [isStudent
            ? `New ${subject} exercises have been generated for you.`
            : `${studentName} has new ${subject} exercises ready.`,
          ],
          details: [
            { label: 'Subject', value: subject },
            { label: 'Exercise count', value: String(validExercises.length) },
            { label: 'Generation', value: after.mode || after.lastTrigger || 'completed' },
          ],
          actionLabel: isStudent ? 'View exercises' : isParent ? 'View student dashboard' : 'Open tutor dashboard',
          actionUrl: isStudent ? '/student/exercises' : isParent ? '/parent' : '/tutor',
        };
      },
    });
  }
);

export const notifyTutorReport = onDocumentCreated(
  { document: 'users/{studentId}/subjects/{subjectInstanceId}/reports/{reportId}', timeoutSeconds: 90, memory: '256MiB', cpu: 'gcf_gen1' },
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
  { document: 'users/{studentId}/subjects/{subjectInstanceId}/lessons/{lessonId}', timeoutSeconds: 90, memory: '256MiB', cpu: 'gcf_gen1' },
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

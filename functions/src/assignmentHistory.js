import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { admin, getDb } from './admin.js';
import { calculateSubscriptionQuote } from './subscriptionPricing.js';

const PRIMARY = 'tutorStudentAssignments';
const SHARED = 'staffStudentAccess';
const PRIMARY_PERIODS = 'tutorStudentAssignmentPeriods';
const SHARED_PERIODS = 'staffStudentAccessPeriods';
const ACCESS_ROLES = ['co-owner', 'marker', 'viewer'];

const requireUid = (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before changing assignments.');
  return uid;
};

const assignmentId = ({ studentId, tutorId, subject }) => `${studentId}_${tutorId}_${subject}`;
const isTutor = (profile = {}) => profile.role === 'tutor'
  || profile.role === 'teacher'
  || profile.isTeacher === true
  || profile.isTeacher === 'true';
const normalizeSubject = (value) => {
  const normalized = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (['math', 'maths'].includes(normalized)) return 'Mathematics';
  if (['math lit', 'maths literacy', 'mathematics literacy'].includes(normalized)) return 'Mathematical Literacy';
  return value;
};
const approvedSubjects = (profile = {}) => [...new Set([
  ...(Array.isArray(profile.subjects) ? profile.subjects : []),
  ...(profile.subject ? [profile.subject] : []),
  ...(Array.isArray(profile.tutorSubjectMarks)
    ? profile.tutorSubjectMarks.filter((item) => Number(item.mark) >= 60).map((item) => item.subject)
    : []),
].filter(Boolean).map(normalizeSubject))];
const ensureTutorForSubject = (profile, subject) => {
  if (!profile || !isTutor(profile) || !approvedSubjects(profile).includes(subject)) {
    throw new HttpsError('failed-precondition', 'Choose an approved tutor or teacher for this subject.');
  }
};
const toMillis = (value) => value?.toMillis?.() ?? (value ? new Date(value).getTime() : 0);
const timestampOrNow = (value, now) => value?.toDate ? value : admin.firestore.Timestamp.fromDate(value ? new Date(value) : now);

const authorizeStudentChange = async ({ transaction, db, uid, studentId, student }) => {
  const actorSnapshot = await transaction.get(db.collection('users').doc(uid));
  if (!actorSnapshot.exists) throw new HttpsError('permission-denied', 'The signed-in account was not found.');
  const actor = actorSnapshot.data();
  if ((uid === studentId && actor.role === 'student')
    || (actor.role === 'parent' && student.parentId === uid)
    || actor.role === 'admin') return;
  throw new HttpsError('permission-denied', 'Only the student, their linked parent, or an admin can change these subjects.');
};

const assertPaidSubjectCapacity = ({ subscription, payment, studentId, existingCount, additions }) => {
  const now = new Date();
  const renewalDate = subscription?.renewalDate?.toDate?.() ?? null;
  const graceEndsAt = subscription?.graceEndsAt?.toDate?.() ?? null;
  const withinPeriod = subscription?.status === 'active' && renewalDate instanceof Date && renewalDate > now;
  const withinGrace = subscription?.status === 'past_due'
    && renewalDate instanceof Date && renewalDate <= now
    && graceEndsAt instanceof Date && graceEndsAt > now;
  if (!['circle', 'personalized'].includes(subscription?.planId) || (!withinPeriod && !withinGrace)) {
    throw new HttpsError('failed-precondition', 'An active paid subscription is required to manage subjects.');
  }

  let quote;
  try {
    quote = calculateSubscriptionQuote({
      planId: subscription.planId,
      billingPeriod: subscription.billingPeriod,
      subjectCount: subscription.subjectCount,
    });
  } catch {
    throw new HttpsError('failed-precondition', 'The active subscription details are invalid.');
  }
  const matches = payment?.status === 'success'
    && payment.reference === subscription.latestReference
    && payment.studentId === studentId
    && payment.planId === subscription.planId
    && payment.billingPeriod === subscription.billingPeriod
    && Number(payment.subjectCount) === quote.subjectCount
    && Number(payment.amount) === quote.amount
    && payment.currency === quote.currency;
  if (!subscription.latestReference || !matches) {
    throw new HttpsError('failed-precondition', 'A confirmed payment for the active subscription is required.');
  }
  if (existingCount + additions > quote.subjectCount) {
    throw new HttpsError('failed-precondition', `Your subscription includes up to ${quote.subjectCount} subjects.`);
  }
};

const closePeriod = ({ transaction, periodRef, pointerRef, pointer, period, actorId, reason, now }) => {
  const periodId = pointer.currentPeriodId || periodRef.id;
  const legacyStart = pointer.assignedAt || pointer.createdAt || period?.startedAt;
  transaction.set(periodRef, {
    periodId,
    assignmentType: period?.assignmentType || (pointer.accessRole ? 'shared' : 'primary'),
    studentId: pointer.studentId,
    tutorId: pointer.tutorId,
    subject: pointer.subject,
    accessRole: pointer.accessRole || 'co-owner',
    startedAt: timestampOrNow(period?.startedAt || legacyStart, now),
    endedAt: admin.firestore.Timestamp.fromDate(now),
    active: false,
    endedBy: actorId,
    endReason: reason,
    pointerId: pointerRef.id,
    migratedFromLegacy: !pointer.currentPeriodId,
    createdAt: period?.createdAt || admin.firestore.Timestamp.fromDate(now),
  }, { merge: true });
  transaction.set(pointerRef, {
    active: false,
    endedAt: admin.firestore.Timestamp.fromDate(now),
    endedBy: actorId,
    endReason: reason,
    updatedAt: admin.firestore.Timestamp.fromDate(now),
  }, { merge: true });
};

const startPeriod = ({ transaction, db, collectionName, pointerRef, studentId, tutorId, subject, accessRole, actorId, now }) => {
  const periodRef = db.collection(collectionName).doc();
  const timestamp = admin.firestore.Timestamp.fromDate(now);
  transaction.set(periodRef, {
    periodId: periodRef.id,
    assignmentType: collectionName === PRIMARY_PERIODS ? 'primary' : 'shared',
    studentId,
    tutorId,
    subject,
    accessRole,
    startedAt: timestamp,
    endedAt: null,
    active: true,
    startedBy: actorId,
    pointerId: pointerRef.id,
    createdAt: timestamp,
  });
  transaction.set(pointerRef, {
    studentId,
    tutorId,
    subject,
    accessRole,
    active: true,
    currentPeriodId: periodRef.id,
    assignedAt: timestamp,
    createdBy: actorId,
    updatedAt: timestamp,
    endedAt: admin.firestore.FieldValue.delete(),
    endedBy: admin.firestore.FieldValue.delete(),
    endReason: admin.firestore.FieldValue.delete(),
  }, { merge: true });
  return periodRef.id;
};

export const updateStudentSubjects = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = requireUid(request);
  const { studentId, action } = request.data ?? {};
  if (!studentId || !['add', 'remove'].includes(action)) {
    throw new HttpsError('invalid-argument', 'A student and subject change action are required.');
  }
  const subjects = action === 'add'
    ? [...new Set((Array.isArray(request.data?.subjects) ? request.data.subjects : []).filter((item) => typeof item === 'string' && item.trim()))]
    : [request.data?.subject].filter((item) => typeof item === 'string' && item.trim());
  if (!subjects.length) throw new HttpsError('invalid-argument', 'Choose at least one valid subject.');

  const db = getDb();
  const studentRef = db.collection('users').doc(studentId);
  return db.runTransaction(async (transaction) => {
    const studentSnapshot = await transaction.get(studentRef);
    if (!studentSnapshot.exists || studentSnapshot.data().role !== 'student') {
      throw new HttpsError('not-found', 'Student profile not found.');
    }
    const student = studentSnapshot.data();
    await authorizeStudentChange({ transaction, db, uid, studentId, student });
    const currentSubjects = [...new Set([student.subject, ...(Array.isArray(student.subjects) ? student.subjects : [])].filter(Boolean))];
    const now = new Date();

    const [primarySnapshot, sharedSnapshot, periodsSnapshot] = await Promise.all([
      transaction.get(db.collection(PRIMARY).where('studentId', '==', studentId)),
      transaction.get(db.collection(SHARED).where('studentId', '==', studentId)),
      transaction.get(db.collection(PRIMARY_PERIODS).where('studentId', '==', studentId)),
    ]);
    const primaryRows = primarySnapshot.docs.map((item) => ({ ref: item.ref, id: item.id, ...item.data() }));
    const historyRows = periodsSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));

    if (action === 'remove') {
      const subject = subjects[0];
      const closePrimary = primarySnapshot.docs.filter((item) => item.data().subject === subject && item.data().active === true);
      const closeShared = sharedSnapshot.docs.filter((item) => item.data().subject === subject && item.data().active === true);
      const closePeriods = async (rows, periodsCollection) => Promise.all(rows.map((item) => {
        const periodId = item.data().currentPeriodId;
        return periodId ? transaction.get(db.collection(periodsCollection).doc(periodId)) : Promise.resolve(null);
      }));
      const [primaryPeriodSnapshots, sharedPeriodSnapshots] = await Promise.all([
        closePeriods(closePrimary, PRIMARY_PERIODS),
        closePeriods(closeShared, SHARED_PERIODS),
      ]);
      closePrimary.forEach((item, index) => closePeriod({
        transaction,
        periodRef: db.collection(PRIMARY_PERIODS).doc(item.data().currentPeriodId || item.id),
        pointerRef: item.ref,
        pointer: item.data(),
        period: primaryPeriodSnapshots[index]?.exists ? primaryPeriodSnapshots[index].data() : null,
        actorId: uid,
        reason: 'subject_removed',
        now,
      }));
      closeShared.forEach((item, index) => closePeriod({
        transaction,
        periodRef: db.collection(SHARED_PERIODS).doc(item.data().currentPeriodId || item.id),
        pointerRef: item.ref,
        pointer: item.data(),
        period: sharedPeriodSnapshots[index]?.exists ? sharedPeriodSnapshots[index].data() : null,
        actorId: uid,
        reason: 'subject_removed',
        now,
      }));

      // Find and cancel active subject episode
      const activeEpSnap = await db.collection('users').doc(studentId).collection('subjects')
        .where('subjectKey', '==', subject)
        .where('status', '==', 'active')
        .get();
      activeEpSnap.docs.forEach((ep) => {
        transaction.update(ep.ref, {
          status: 'cancelled',
          cancelledAt: admin.firestore.Timestamp.fromDate(now),
          cancelledBy: uid,
          updatedAt: admin.firestore.Timestamp.fromDate(now),
        });
      });

      const remainingSubjects = currentSubjects.filter((item) => item !== subject);
      const activePrimary = primaryRows.filter((item) => item.active === true && item.subject !== subject);
      const subjectMarks = (Array.isArray(student.tutorSubjectMarks) ? student.tutorSubjectMarks : []).filter((item) => item.subject !== subject);
      transaction.update(studentRef, {
        subjects: remainingSubjects,
        subject: student.subject === subject ? (remainingSubjects[0] || null) : (student.subject || null),
        tutorSubjectMarks: subjectMarks,
        assignedTutorIds: [...new Set(activePrimary.map((item) => item.tutorId).filter(Boolean))],
        assignedSubjects: [...new Set(activePrimary.map((item) => item.subject).filter(Boolean))],
        updatedAt: admin.firestore.Timestamp.fromDate(now),
      });
      return { studentId, removedSubjects: [subject], endedPrimaryPeriods: closePrimary.length, endedSharedPeriods: closeShared.length };
    }

    const additions = subjects.filter((subject) => !currentSubjects.includes(subject));
    if (!additions.length) return { studentId, subjects: [] };
    const subscriptionRef = db.collection('subscriptions').doc(studentId);
    const subscriptionSnapshot = await transaction.get(subscriptionRef);
    const subscription = subscriptionSnapshot.exists ? subscriptionSnapshot.data() : null;
    const paymentSnapshot = subscription?.latestReference
      ? await transaction.get(db.collection('payments').doc(subscription.latestReference))
      : null;
    assertPaidSubjectCapacity({
      subscription,
      payment: paymentSnapshot?.exists ? paymentSnapshot.data() : null,
      studentId,
      existingCount: currentSubjects.length,
      additions: additions.length,
    });

    const staleBySubject = new Map(additions.map((subject) => [subject, {
      primary: primarySnapshot.docs.filter((item) => item.data().subject === subject && item.data().active === true),
      shared: sharedSnapshot.docs.filter((item) => item.data().subject === subject && item.data().active === true),
    }]));
    const stalePrimary = [...staleBySubject.values()].flatMap((item) => item.primary);
    const staleShared = [...staleBySubject.values()].flatMap((item) => item.shared);
    const periodReads = [...stalePrimary.map((item) => [item, PRIMARY_PERIODS]), ...staleShared.map((item) => [item, SHARED_PERIODS])];
    const stalePeriodSnapshots = await Promise.all(periodReads.map(([item, periodsCollection]) => {
      const periodId = item.data().currentPeriodId;
      return periodId ? transaction.get(db.collection(periodsCollection).doc(periodId)) : Promise.resolve(null);
    }));

    const closeStale = (rows, periodsCollection, offset) => rows.forEach((item, index) => closePeriod({
      transaction,
      periodRef: db.collection(periodsCollection).doc(item.data().currentPeriodId || item.id),
      pointerRef: item.ref,
      pointer: item.data(),
      period: stalePeriodSnapshots[offset + index]?.exists ? stalePeriodSnapshots[offset + index].data() : null,
      actorId: uid,
      reason: 'legacy_subject_removal_reconciled',
      now,
    }));
    closeStale(stalePrimary, PRIMARY_PERIODS, 0);
    closeStale(staleShared, SHARED_PERIODS, stalePrimary.length);

    // Active episode creation and 3-month topic restore (without tutor carryover)
    for (const subject of additions) {
      // Ensure single active episode: cancel any lingering active episode for this subject
      const existingActiveSnap = await db.collection('users').doc(studentId).collection('subjects')
        .where('subjectKey', '==', subject)
        .where('status', '==', 'active')
        .get();
      existingActiveSnap.docs.forEach((ep) => {
        transaction.update(ep.ref, {
          status: 'cancelled',
          cancelledAt: admin.firestore.Timestamp.fromDate(now),
          cancelledBy: uid,
          endReason: 'superseded_by_new_episode',
          updatedAt: admin.firestore.Timestamp.fromDate(now),
        });
      });

      const prevEpSnap = await db.collection('users').doc(studentId).collection('subjects')
        .where('subjectKey', '==', subject)
        .where('status', '==', 'cancelled')
        .orderBy('cancelledAt', 'desc')
        .limit(1)
        .get();

      let restored = false;
      const newEpRef = db.collection('users').doc(studentId).collection('subjects').doc();

      if (!prevEpSnap.empty) {
        const prevDoc = prevEpSnap.docs[0];
        const prevData = prevDoc.data();
        const cancelledAtMillis = prevData.cancelledAt?.toMillis ? prevData.cancelledAt.toMillis() : (prevData.cancelledAt ? new Date(prevData.cancelledAt).getTime() : 0);
        const isWithinThreeMonths = cancelledAtMillis && (now.getTime() - cancelledAtMillis <= 90 * 24 * 60 * 60 * 1000);
        const isSameGrade = prevData.grade === student.grade;

        if (isWithinThreeMonths && isSameGrade) {
          restored = true;
          transaction.set(newEpRef, {
            studentId,
            subjectKey: subject,
            subjectName: subject,
            grade: student.grade || prevData.grade || '',
            curriculum: 'CAPS',
            status: 'active',
            startedAt: admin.firestore.Timestamp.fromDate(now),
            cancelledAt: null,
            previousSubjectInstanceId: prevDoc.id,
            restoredFromSubjectInstanceId: prevDoc.id,
            restoredAt: admin.firestore.Timestamp.fromDate(now),
            completedTopicCount: prevData.completedTopicCount || 0,
            dailyExerciseTarget: Math.min(5, Math.max(1, prevData.completedTopicCount || 1)),
            primaryTutorId: '',
            staffByUid: {},
            activeStaffIds: [],
            historicalStaffIds: [],
            staffMemberships: [],
            initialReport: prevData.initialReport || '',
            studentName: student.displayName || student.email || 'Student',
            createdAt: admin.firestore.Timestamp.fromDate(now),
            updatedAt: admin.firestore.Timestamp.fromDate(now),
          });

          // Copy topics from previous episode
          const topicsSnap = await prevDoc.ref.collection('topics').get();
          for (const topicDoc of topicsSnap.docs) {
            const newTopicRef = newEpRef.collection('topics').doc(topicDoc.id);
            transaction.set(newTopicRef, topicDoc.data());

            const scoresSnap = await topicDoc.ref.collection('understandingScores').get();
            for (const scoreDoc of scoresSnap.docs) {
              transaction.set(newTopicRef.collection('understandingScores').doc(scoreDoc.id), scoreDoc.data());
            }
          }
        }
      }

      if (!restored) {
        transaction.set(newEpRef, {
          studentId,
          subjectKey: subject,
          subjectName: subject,
          grade: student.grade || '',
          curriculum: 'CAPS',
          status: 'active',
          startedAt: admin.firestore.Timestamp.fromDate(now),
          cancelledAt: null,
          completedTopicCount: 0,
          dailyExerciseTarget: 1,
          primaryTutorId: '',
          staffByUid: {},
          activeStaffIds: [],
          historicalStaffIds: [],
          staffMemberships: [],
          initialReport: '',
          studentName: student.displayName || student.email || 'Student',
          createdAt: admin.firestore.Timestamp.fromDate(now),
          updatedAt: admin.firestore.Timestamp.fromDate(now),
        });
      }
    }

    const remainingActivePrimary = primaryRows.filter((item) => item.active === true && !additions.includes(item.subject));
    const nextSubjectList = [...new Set([...currentSubjects, ...additions])];
    transaction.update(studentRef, {
      subjects: nextSubjectList,
      subject: student.subject || nextSubjectList[0] || null,
      assignedTutorIds: [...new Set(remainingActivePrimary.map((item) => item.tutorId).filter(Boolean))],
      assignedSubjects: [...new Set(remainingActivePrimary.map((item) => item.subject).filter(Boolean))],
      updatedAt: admin.firestore.Timestamp.fromDate(now),
    });
    return { studentId, subjects: additions, reassignedTutorIds: [] };
  });
});

export const assignStudentToTutor = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const actorId = requireUid(request);
  const { studentId, tutorId, subject } = request.data ?? {};
  if (!studentId || !tutorId || !subject) throw new HttpsError('invalid-argument', 'A student, tutor, and subject are required.');
  const db = getDb();
  const studentRef = db.collection('users').doc(studentId);
  const tutorRef = db.collection('users').doc(tutorId);
  const pointerRef = db.collection(PRIMARY).doc(assignmentId({ studentId, tutorId, subject }));
  return db.runTransaction(async (transaction) => {
    const [actorSnapshot, studentSnapshot, tutorSnapshot, currentAssignments] = await Promise.all([
      transaction.get(db.collection('users').doc(actorId)),
      transaction.get(studentRef),
      transaction.get(tutorRef),
      transaction.get(db.collection(PRIMARY).where('studentId', '==', studentId)),
    ]);
    if (!actorSnapshot.exists || actorSnapshot.data().role !== 'admin') throw new HttpsError('permission-denied', 'Only an admin can assign a primary tutor.');
    if (!studentSnapshot.exists || studentSnapshot.data().role !== 'student' || !approvedSubjects(studentSnapshot.data()).includes(subject)) {
      throw new HttpsError('failed-precondition', 'The student does not currently have this subject.');
    }
    ensureTutorForSubject(tutorSnapshot.exists ? tutorSnapshot.data() : null, subject);
    if (currentAssignments.docs.some((item) => item.data().subject === subject && item.data().active === true)) {
      throw new HttpsError('already-exists', `This student already has an active ${subject} tutor assignment.`);
    }
    const now = new Date();
    const currentPointer = await transaction.get(pointerRef);
    if (currentPointer.exists && currentPointer.data().active === true) {
      throw new HttpsError('already-exists', `This tutor already has active ${subject} access.`);
    }
    startPeriod({ transaction, db, collectionName: PRIMARY_PERIODS, pointerRef, studentId, tutorId, subject, accessRole: 'co-owner', actorId, now });
    const activeRows = currentAssignments.docs.map((item) => item.data()).filter((item) => item.active === true);
    transaction.set(studentRef, {
      assignedTutorIds: [...new Set([...activeRows.map((item) => item.tutorId), tutorId].filter(Boolean))],
      assignedSubjects: [...new Set([...activeRows.map((item) => item.subject), subject].filter(Boolean))],
      updatedAt: admin.firestore.Timestamp.fromDate(now),
    }, { merge: true });

    // Sync to active subject episode
    const activeEpSnap = await db.collection('users').doc(studentId).collection('subjects')
      .where('subjectKey', '==', subject)
      .where('status', '==', 'active')
      .limit(1)
      .get();
    if (!activeEpSnap.empty) {
      const epDoc = activeEpSnap.docs[0];
      const epData = epDoc.data();
      const currentStaffIds = Array.isArray(epData.activeStaffIds) ? epData.activeStaffIds : [];
      const nextStaffIds = [...new Set([...currentStaffIds, tutorId])];
      transaction.update(epDoc.ref, {
        primaryTutorId: tutorId,
        activeStaffIds: nextStaffIds,
        [`staffByUid.${tutorId}`]: 'co-owner',
        updatedAt: admin.firestore.Timestamp.fromDate(now),
      });
    }

    return { id: pointerRef.id, studentId, tutorId, subject };
  });
});

export const manageStaffStudentAccess = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const actorId = requireUid(request);
  const { action, studentId, tutorId, subject, accessRole, accessId } = request.data ?? {};
  if (!['grant', 'revoke'].includes(action) || !studentId || !subject) {
    throw new HttpsError('invalid-argument', 'A student, subject, and valid access action are required.');
  }
  if (action === 'grant' && (!tutorId || !ACCESS_ROLES.includes(accessRole))) {
    throw new HttpsError('invalid-argument', 'Choose a tutor or teacher and a valid access role.');
  }
  const db = getDb();
  const studentRef = db.collection('users').doc(studentId);
  const actorRef = db.collection('users').doc(actorId);
  const primaryRef = db.collection(PRIMARY).doc(assignmentId({ studentId, tutorId: actorId, subject }));
  const actorSharedRef = db.collection(SHARED).doc(assignmentId({ studentId, tutorId: actorId, subject }));

  return db.runTransaction(async (transaction) => {
    const [studentSnapshot, actorSnapshot, primarySnapshot, actorSharedSnapshot] = await Promise.all([
      transaction.get(studentRef), transaction.get(actorRef), transaction.get(primaryRef), transaction.get(actorSharedRef),
    ]);
    if (!studentSnapshot.exists || !studentSnapshot.data().subjects?.includes(subject) && studentSnapshot.data().subject !== subject) {
      throw new HttpsError('failed-precondition', 'The student is no longer registered for this subject.');
    }
    const actorOwns = primarySnapshot.exists && primarySnapshot.data().active === true;
    const actorCoOwns = actorSharedSnapshot.exists && actorSharedSnapshot.data().active === true && actorSharedSnapshot.data().accessRole === 'co-owner';
    if (!actorSnapshot.exists || !isTutor(actorSnapshot.data()) || (!actorOwns && !actorCoOwns)) {
      throw new HttpsError('permission-denied', 'Only a primary tutor or co-owner can manage staff access.');
    }
    const now = new Date();

    if (action === 'grant') {
      if (tutorId === actorId) throw new HttpsError('invalid-argument', 'You already have access to this student.');
      const targetRef = db.collection('users').doc(tutorId);
      const targetSnapshot = await transaction.get(targetRef);
      ensureTutorForSubject(targetSnapshot.exists ? targetSnapshot.data() : null, subject);
      const pointerRef = db.collection(SHARED).doc(assignmentId({ studentId, tutorId, subject }));
      const pointerSnapshot = await transaction.get(pointerRef);
      if (pointerSnapshot.exists && pointerSnapshot.data().active === true && pointerSnapshot.data().accessRole === accessRole) {
        return { id: pointerRef.id, studentId, tutorId, subject, accessRole, active: true };
      }
      let previousPeriod = null;
      if (pointerSnapshot.exists && pointerSnapshot.data().active === true && pointerSnapshot.data().currentPeriodId) {
        const periodSnapshot = await transaction.get(db.collection(SHARED_PERIODS).doc(pointerSnapshot.data().currentPeriodId));
        previousPeriod = periodSnapshot.exists ? periodSnapshot.data() : null;
      }
      if (pointerSnapshot.exists && pointerSnapshot.data().active === true) {
        closePeriod({
          transaction,
          periodRef: db.collection(SHARED_PERIODS).doc(pointerSnapshot.data().currentPeriodId || pointerSnapshot.id),
          pointerRef,
          pointer: pointerSnapshot.data(),
          period: previousPeriod,
          actorId,
          reason: 'access_role_changed',
          now,
        });
      }
      startPeriod({ transaction, db, collectionName: SHARED_PERIODS, pointerRef, studentId, tutorId, subject, accessRole, actorId, now });

      // Sync to active subject episode
      const activeEpSnap = await db.collection('users').doc(studentId).collection('subjects')
        .where('subjectKey', '==', subject)
        .where('status', '==', 'active')
        .limit(1)
        .get();
      if (!activeEpSnap.empty) {
        const epDoc = activeEpSnap.docs[0];
        const epData = epDoc.data();
        const currentStaffIds = Array.isArray(epData.activeStaffIds) ? epData.activeStaffIds : [];
        const nextStaffIds = [...new Set([...currentStaffIds, tutorId])];
        transaction.update(epDoc.ref, {
          activeStaffIds: nextStaffIds,
          [`staffByUid.${tutorId}`]: accessRole,
          updatedAt: admin.firestore.Timestamp.fromDate(now),
        });
      }

      return { id: pointerRef.id, studentId, tutorId, subject, accessRole, active: true };
    }

    if (!accessId) throw new HttpsError('invalid-argument', 'An access record is required.');
    const targetRef = db.collection(SHARED).doc(accessId);
    const targetSnapshot = await transaction.get(targetRef);
    if (!targetSnapshot.exists || targetSnapshot.data().studentId !== studentId || targetSnapshot.data().subject !== subject || targetSnapshot.data().active !== true) {
      throw new HttpsError('not-found', 'Active staff access record not found.');
    }
    const revokedTutorId = targetSnapshot.data().tutorId;
    let period = null;
    if (targetSnapshot.data().currentPeriodId) {
      const periodSnapshot = await transaction.get(db.collection(SHARED_PERIODS).doc(targetSnapshot.data().currentPeriodId));
      period = periodSnapshot.exists ? periodSnapshot.data() : null;
    }
    closePeriod({
      transaction,
      periodRef: db.collection(SHARED_PERIODS).doc(targetSnapshot.data().currentPeriodId || targetSnapshot.id),
      pointerRef: targetRef,
      pointer: targetSnapshot.data(),
      period,
      actorId,
      reason: 'access_revoked',
      now,
    });

    // Sync to active subject episode
    const activeEpSnap = await db.collection('users').doc(studentId).collection('subjects')
      .where('subjectKey', '==', subject)
      .where('status', '==', 'active')
      .limit(1)
      .get();
    if (!activeEpSnap.empty) {
      const epDoc = activeEpSnap.docs[0];
      const epData = epDoc.data();
      const currentStaffIds = Array.isArray(epData.activeStaffIds) ? epData.activeStaffIds : [];
      const nextStaffIds = currentStaffIds.filter((id) => id !== revokedTutorId);
      transaction.update(epDoc.ref, {
        activeStaffIds: nextStaffIds,
        [`staffByUid.${revokedTutorId}`]: 'revoked',
        updatedAt: admin.firestore.Timestamp.fromDate(now),
      });
    }

    return { id: accessId, revoked: true };
  });
});

export const changeStudentGrade = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = requireUid(request);
  const { studentId, newGrade } = request.data ?? {};
  if (!studentId || !newGrade) throw new HttpsError('invalid-argument', 'A student ID and new grade are required.');

  const db = getDb();
  const studentRef = db.collection('users').doc(studentId);
  return db.runTransaction(async (transaction) => {
    const studentSnapshot = await transaction.get(studentRef);
    if (!studentSnapshot.exists || studentSnapshot.data().role !== 'student') {
      throw new HttpsError('not-found', 'Student profile not found.');
    }
    const student = studentSnapshot.data();
    await authorizeStudentChange({ transaction, db, uid, studentId, student });

    const oldGrade = student.grade;
    if (oldGrade === newGrade) return { studentId, grade: newGrade, unchanged: true };

    const now = new Date();
    // Cancel all existing active subject episodes with endReason: 'grade_changed'
    const activeEpsSnap = await db.collection('users').doc(studentId).collection('subjects')
      .where('status', '==', 'active')
      .get();

    const registeredSubjects = [...new Set([student.subject, ...(Array.isArray(student.subjects) ? student.subjects : [])].filter(Boolean))];

    activeEpsSnap.docs.forEach((ep) => {
      transaction.update(ep.ref, {
        status: 'cancelled',
        cancelledAt: admin.firestore.Timestamp.fromDate(now),
        cancelledBy: uid,
        endReason: 'grade_changed',
        updatedAt: admin.firestore.Timestamp.fromDate(now),
      });
    });

    // Create fresh active subject episode for each registered subject with zero topics
    for (const subject of registeredSubjects) {
      const newEpRef = db.collection('users').doc(studentId).collection('subjects').doc();
      transaction.set(newEpRef, {
        studentId,
        subjectKey: subject,
        subjectName: subject,
        grade: newGrade,
        curriculum: 'CAPS',
        status: 'active',
        startedAt: admin.firestore.Timestamp.fromDate(now),
        cancelledAt: null,
        completedTopicCount: 0,
        dailyExerciseTarget: 1,
        primaryTutorId: '',
        staffByUid: {},
        activeStaffIds: [],
        historicalStaffIds: [],
        staffMemberships: [],
        initialReport: '',
        studentName: student.displayName || student.email || 'Student',
        createdAt: admin.firestore.Timestamp.fromDate(now),
        updatedAt: admin.firestore.Timestamp.fromDate(now),
      });
    }

    transaction.update(studentRef, {
      grade: newGrade,
      updatedAt: admin.firestore.Timestamp.fromDate(now),
    });

    return { studentId, previousGrade: oldGrade, newGrade, resetEpisodesCount: registeredSubjects.length };
  });
});

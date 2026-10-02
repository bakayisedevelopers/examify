import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { admin, getDb } from './admin.js';
import { sendNotificationToUsers } from './notifications.js';
import {
  buildAssignments,
  getExerciseTopicKeys,
} from './peerMarkingAllocation.js';

const hasSubmission = (data = {}) => Boolean(
  (data.submittedImageUrl && data.submittedFileName) || data.submittedImages?.some((image) => image?.url),
);

const buildCohortKey = (exercise = {}) => ({
  assignmentDate: exercise.assignmentDate,
  subject: exercise.subject,
  grade: exercise.grade,
});

const complete = (value) => value && value.assignmentDate && value.subject && value.grade;
const safeId = (value) => String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
const chunks = (values, size = 30) => {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
};
const getExerciseTopicNames = (exercise = {}) => [...new Set([
  exercise.topic,
  ...(Array.isArray(exercise.topics) ? exercise.topics : []),
].map((value) => String(value ?? '').trim()).filter(Boolean))];
const topicKeyForMatch = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9|]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const readMatchingCandidateExercises = async ({ db, cohort, topicNames }) => {
  const topicBatches = chunks([...new Set(topicNames)].filter(Boolean));
  const snapshots = await Promise.all(topicBatches.flatMap((topics) => [
    db.collection('dailyExerciseAssignments')
      .where('subject', '==', cohort.subject)
      .where('grade', '==', cohort.grade)
      .where('topic', 'in', topics)
      .orderBy('assignmentDate', 'desc')
      .limit(5000)
      .get(),
    db.collection('dailyExerciseAssignments')
      .where('subject', '==', cohort.subject)
      .where('grade', '==', cohort.grade)
      .where('topics', 'array-contains-any', topics)
      .orderBy('assignmentDate', 'desc')
      .limit(5000)
      .get(),
  ]));
  const unique = new Map();
  snapshots.flatMap((snapshot) => snapshot.docs).forEach((document) => {
    if (!unique.has(document.id)) unique.set(document.id, { id: document.id, ...document.data() });
  });
  return [...unique.values()].filter(hasSubmission);
};

const readReviewerHistory = async ({ db, reviewerIds, cohort }) => {
  const snapshots = await Promise.all(chunks(reviewerIds).map((ids) => db.collection('peerMarkingAssignments')
    .where('reviewerId', 'in', ids)
    .where('subject', '==', cohort.subject)
    .where('grade', '==', cohort.grade)
    .get()));
  const histories = snapshots.flatMap((snapshot) => snapshot.docs)
    .map((document) => ({ id: document.id, ...document.data() }))
    .filter((row) => row.status === 'completed' && row.reviewerId && row.exerciseId);
  const markedExerciseIdsByReviewer = new Map();
  const recentRevieweesByReviewer = new Map();
  histories.forEach((row) => {
    if (!markedExerciseIdsByReviewer.has(row.reviewerId)) markedExerciseIdsByReviewer.set(row.reviewerId, new Set());
    if (!recentRevieweesByReviewer.has(row.reviewerId)) recentRevieweesByReviewer.set(row.reviewerId, new Set());
    markedExerciseIdsByReviewer.get(row.reviewerId).add(row.exerciseId);
    if (row.revieweeId) recentRevieweesByReviewer.get(row.reviewerId).add(row.revieweeId);
  });
  return { histories, markedExerciseIdsByReviewer, recentRevieweesByReviewer };
};

const readPreviouslyMarkedTargets = async ({ db, histories }) => {
  const wantedIds = new Set();
  histories.forEach((row) => wantedIds.add(row.exerciseId));
  const targetSnapshots = await Promise.all(chunks([...wantedIds], 200).map((ids) => db.getAll(
    ...ids.map((id) => db.collection('dailyExerciseAssignments').doc(id)),
  )));
  return targetSnapshots.flat().filter((snapshot) => snapshot.exists)
    .map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }))
    .filter(hasSubmission);
};

const writeAssignmentIfAvailable = async ({ db, cohort, reviewer, target, matchedTopics = [] }) => {
  const assignmentId = safeId(`${cohort.assignmentDate}_${cohort.grade}_${cohort.subject}_${reviewer.studentId}_${target.id}`);
  const assignmentRef = db.collection('peerMarkingAssignments').doc(assignmentId);
  const created = await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(db.collection('peerMarkingAssignments')
      .where('reviewerId', '==', reviewer.studentId)
      .where('assignmentDate', '==', cohort.assignmentDate)
      .where('subject', '==', cohort.subject)
      .where('grade', '==', cohort.grade));
    if (!existing.empty) return false;
    transaction.create(assignmentRef, {
      reviewerId: reviewer.studentId,
      revieweeId: target.studentId,
      exerciseId: target.id,
      reviewerExerciseId: reviewer.id,
      assignmentDate: cohort.assignmentDate,
      targetAssignmentDate: target.assignmentDate ?? '',
      subject: cohort.subject,
      grade: cohort.grade,
      title: target.title ?? '',
      topic: matchedTopics[0] ?? target.topic ?? target.topics?.[0] ?? '',
      matchedTopics,
      submittedImageUrl: target.submittedImageUrl ?? target.submittedImages?.[0]?.url ?? '',
      submittedImages: Array.isArray(target.submittedImages) && target.submittedImages.length
        ? target.submittedImages
        : target.submittedImageUrl ? [{ url: target.submittedImageUrl, fileName: target.submittedFileName ?? '', pageNumber: 1 }] : [],
      submittedFileName: target.submittedFileName ?? target.submittedImages?.[0]?.fileName ?? '',
      paperIds: target.paperIds ?? [],
      questionLinks: target.questionLinks ?? [],
      status: 'assigned',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return true;
  });
  return created ? assignmentId : '';
};

export const assignPeerMarkingOnSubmission = onDocumentWritten(
  { document: 'dailyExerciseAssignments/{exerciseId}', timeoutSeconds: 180, memory: '1GiB' },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after || !hasSubmission(after)) return;
    if (before && hasSubmission(before) && before.submittedImageUrl === after.submittedImageUrl) return;

    const cohort = buildCohortKey(after);
    if (!complete(cohort)) {
      logger.warn('Peer marking skipped because assignment lacks grade/subject/date', { exerciseId: event.params.exerciseId, cohort });
      return;
    }

    const db = getDb();
    const [todayExercisesSnapshot, existingSnapshot] = await Promise.all([
      db.collection('dailyExerciseAssignments')
        .where('assignmentDate', '==', cohort.assignmentDate)
        .where('subject', '==', cohort.subject)
        .where('grade', '==', cohort.grade)
        .get(),
      db.collection('peerMarkingAssignments')
        .where('assignmentDate', '==', cohort.assignmentDate)
        .where('subject', '==', cohort.subject)
        .where('grade', '==', cohort.grade)
        .get(),
    ]);
    const submittedRows = todayExercisesSnapshot.docs
      .map((document) => ({ id: document.id, ...document.data() }))
      .filter((item) => hasSubmission(item) && item.studentId);
    const submittedByStudent = new Map();
    submittedRows.forEach((item) => {
      const current = submittedByStudent.get(item.studentId);
      if (!current) {
        submittedByStudent.set(item.studentId, { ...item, topics: getExerciseTopicNames(item) });
        return;
      }
      current.topics = [...new Set([...current.topics, ...getExerciseTopicNames(item)])];
    });
    const submitted = [...submittedByStudent.values()];
    const assignedReviewerIds = new Set(existingSnapshot.docs.map((document) => document.data().reviewerId).filter(Boolean));
    const reviewers = submitted.filter((item) => !assignedReviewerIds.has(item.studentId));
    if (!reviewers.length) return;

    const reviewerIds = reviewers.map((reviewer) => reviewer.studentId);
    const topicKeysByReviewer = new Map(reviewers.map((reviewer) => [
      reviewer.studentId,
      getExerciseTopicKeys(reviewer),
    ]));
    const topicNames = [...new Set(reviewers.flatMap(getExerciseTopicNames))];
    if (!topicNames.length) return;

    const [{ histories, markedExerciseIdsByReviewer, recentRevieweesByReviewer }, historicalCandidates] = await Promise.all([
      readReviewerHistory({ db, reviewerIds, cohort }),
      readMatchingCandidateExercises({ db, cohort, topicNames }),
    ]);
    const previouslyMarkedTargets = await readPreviouslyMarkedTargets({ db, histories });
    const candidatesById = new Map();
    [...submitted, ...historicalCandidates, ...previouslyMarkedTargets].forEach((candidate) => {
      if (!candidatesById.has(candidate.id)) candidatesById.set(candidate.id, candidate);
    });

    const pairs = buildAssignments({
      reviewers,
      candidates: [...candidatesById.values()],
      topicKeysByReviewer,
      markedExerciseIdsByReviewer,
      recentRevieweesByReviewer,
      assignedReviewerIds,
      currentDate: cohort.assignmentDate,
      subject: cohort.subject,
      grade: cohort.grade,
    });
    const createdAssignments = [];
    for (const pair of pairs) {
      const matchedTopics = getExerciseTopicNames(pair.target).filter((topic) => getExerciseTopicKeys(pair.reviewer).has(topicKeyForMatch(topic)));
      const assignmentId = await writeAssignmentIfAvailable({ db, cohort, ...pair, matchedTopics });
      if (assignmentId) createdAssignments.push({ assignmentId, ...pair });
    }

    await Promise.all(createdAssignments.map(({ assignmentId, reviewer, target }) => sendNotificationToUsers({
      userIds: [reviewer.studentId],
      title: 'New work to mark',
      body: `${target.subject ?? cohort.subject} ${target.title ?? 'exercise'} is ready for peer marking.`,
      type: 'peer-marking.assigned',
      url: '/student?tab=mark',
      data: {
        assignmentId,
        exerciseId: target.id,
        subject: target.subject ?? cohort.subject,
        assignmentDate: cohort.assignmentDate,
      },
      tag: `peer-marking-${assignmentId}`,
    })));
    logger.info('Peer marking assignments created', {
      cohort,
      submittedCount: submitted.length,
      waitingReviewerCount: reviewers.length,
      pairCount: createdAssignments.length,
    });
  },
);

export const completePeerMarkingAssignment = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'You must be signed in to submit peer marking.');
  const { assignmentId, reviewImages = [], reviewImageUrl, reviewFileName } = request.data ?? {};
  if (!assignmentId) throw new HttpsError('invalid-argument', 'assignmentId is required.');
  const pages = Array.isArray(reviewImages) && reviewImages.length
    ? reviewImages
    : (reviewImageUrl ? [{ url: reviewImageUrl, fileName: reviewFileName || 'review.png', pageNumber: 1 }] : []);
  if (!pages.length) throw new HttpsError('invalid-argument', 'At least one marked image page is required.');

  const db = getDb();
  const assignmentRef = db.collection('peerMarkingAssignments').doc(assignmentId);
  const assignmentSnap = await assignmentRef.get();
  if (!assignmentSnap.exists) throw new HttpsError('not-found', 'Peer marking assignment not found.');
  const assignment = assignmentSnap.data();

  if (assignment.reviewerId !== uid) {
    throw new HttpsError('permission-denied', 'You are not assigned to review this work.');
  }
  if (assignment.status === 'completed') {
    throw new HttpsError('failed-precondition', 'This peer review has already been completed.');
  }

  const primaryPage = pages[0];
  const now = admin.firestore.Timestamp.now();
  const completion = {
    reviewImageUrl: primaryPage.url,
    reviewFileName: primaryPage.fileName,
    reviewImages: pages,
    status: 'completed',
    completedAt: now,
    updatedAt: now,
  };

  const batch = db.batch();
  batch.update(assignmentRef, completion);

  const peerMarkFields = {
    peerReviewed: 'Yes',
    peerReviewStatus: 'completed',
    peerReviewDate: now,
    peerMarkedImageUrl: primaryPage.url,
    peerMarkedFileName: primaryPage.fileName,
    peerMarkedImages: pages,
    submittedReviewImageUrl: primaryPage.url,
    submittedReviewFileName: primaryPage.fileName,
    submittedReviewImages: pages,
    peerReviewerId: uid,
    peerMarkingAssignmentId: assignmentId,
    markedExerciseId: assignment.exerciseId,
  };

  if (assignment.exerciseId) {
    batch.set(db.collection('dailyExerciseAssignments').doc(assignment.exerciseId), peerMarkFields, { merge: true });
    batch.set(db.collection('submissions').doc(assignment.exerciseId), { ...completion, ...peerMarkFields }, { merge: true });
  }

  if (assignment.reviewerExerciseId) {
    batch.set(db.collection('dailyExerciseAssignments').doc(assignment.reviewerExerciseId), {
      peerMarkingImageUrl: primaryPage.url,
      peerMarkingFileName: primaryPage.fileName,
      peerMarkingImages: pages,
      markedPeerExerciseId: assignment.exerciseId,
      peerMarkingAssignmentId: assignmentId,
      peerMarkingRevieweeId: assignment.revieweeId,
      peerMarkingStatus: 'completed',
      updatedAt: now,
    }, { merge: true });
  }

  await batch.commit();
  return { success: true, assignmentId, ...completion };
});

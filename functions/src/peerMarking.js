import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { admin, getDb } from './admin.js';
import { buildAssignments, getExerciseTopicKeys } from './peerMarkingAllocation.js';
import { sendNotificationToUsers } from './notifications.js';

const hasSubmission = (exercise = {}) => exercise.submissionStatus === 'submitted'
  || exercise.submitted === 'Yes' || Boolean(exercise.submittedImageUrl);
const cohortFor = (exercise = {}) => ({
  assignmentDate: exercise.assignmentDate ?? '', subject: exercise.subject ?? '', grade: exercise.grade ?? '',
});
const topicNames = (exercise = {}) => [...new Set([
  ...(Array.isArray(exercise.topics) ? exercise.topics : []),
  ...(Array.isArray(exercise.topicBreakdown) ? exercise.topicBreakdown.map((entry) => entry?.topic) : []),
  ...(Array.isArray(exercise.questionLinks) ? exercise.questionLinks.map((entry) => entry?.topic) : []),
  ...String(exercise.topic || '').split('|'),
].filter(Boolean).map((topic) => String(topic).trim()))];
const normalizeTopic = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const sameCohort = (left, right) => left.assignmentDate === right.assignmentDate
  && left.subject === right.subject && String(left.grade) === String(right.grade);
const parseExercisePath = (document) => {
  const parts = document.ref.path.split('/');
  return { studentId: parts[1], subjectInstanceId: parts[3], exerciseId: document.id };
};

export const assignPeerMarkingOnSubmission = onDocumentWritten(
  { document: 'users/{studentId}/subjects/{subjectInstanceId}/exercises/{exerciseId}', timeoutSeconds: 180, memory: '1GiB' },
  async (event) => {
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after || !hasSubmission(after) || (before && hasSubmission(before))) return;
    const cohort = cohortFor(after);
    if (!cohort.assignmentDate || !cohort.subject || !cohort.grade) return;
    const db = getDb();
    const exerciseSnapshot = await db.collectionGroup('exercises')
      .where('assignmentDate', '==', cohort.assignmentDate)
      .where('subject', '==', cohort.subject)
      .where('grade', '==', cohort.grade).get();
    const submitted = exerciseSnapshot.docs
      .filter((document) => hasSubmission(document.data()))
      .map((document) => ({ id: document.id, ...document.data(), ...parseExercisePath(document), ref: document.ref }));
    const assignmentSnapshot = await db.collectionGroup('peerMarkingAssignments')
      .where('assignmentDate', '==', cohort.assignmentDate)
      .where('subject', '==', cohort.subject)
      .where('grade', '==', cohort.grade).get();
    const assignedReviewerIds = new Set(assignmentSnapshot.docs.map((document) => document.data().reviewerId));
    const reviewers = submitted.filter((exercise) => !assignedReviewerIds.has(exercise.studentId));
    if (!reviewers.length) return;
    const historicalSnapshot = await db.collectionGroup('exercises')
      .where('subject', '==', cohort.subject).where('grade', '==', cohort.grade).get();
    const candidates = historicalSnapshot.docs.filter((document) => hasSubmission(document.data()))
      .map((document) => ({ id: document.id, ...document.data(), ...parseExercisePath(document), ref: document.ref }));
    const pairs = buildAssignments({
      reviewers, candidates,
      topicKeysByReviewer: new Map(reviewers.map((reviewer) => [reviewer.studentId, getExerciseTopicKeys(reviewer)])),
      markedExerciseIdsByReviewer: new Map(), recentRevieweesByReviewer: new Map(), assignedReviewerIds,
      currentDate: cohort.assignmentDate, subject: cohort.subject, grade: cohort.grade,
    });
    for (const { reviewer, target } of pairs) {
      if (!sameCohort(cohortFor(reviewer), cohort)) continue;
      const assignmentRef = target.ref.collection('peerMarkingAssignments').doc(reviewer.studentId);
      const reviewerTopics = getExerciseTopicKeys(reviewer);
      const matchedTopics = topicNames(target).filter((topic) => reviewerTopics.has(normalizeTopic(topic)));
      const targetTopics = topicNames(target);
      const assignedTopics = matchedTopics.length ? matchedTopics : targetTopics;
      const assignedTopicKeys = new Set(assignedTopics.map(normalizeTopic));
      const assignedQuestionLinks = (Array.isArray(target.questionLinks) ? target.questionLinks : [])
        .filter((link) => !matchedTopics.length || assignedTopicKeys.has(normalizeTopic(link.topic)));
      await assignmentRef.set({
        assignmentId: assignmentRef.id,
        reviewerId: reviewer.studentId, reviewerSubjectInstanceId: reviewer.subjectInstanceId,
        reviewerExerciseId: reviewer.id, revieweeId: target.studentId, revieweeSubjectInstanceId: target.subjectInstanceId,
        exerciseId: target.id, assignmentPath: assignmentRef.path, exercisePath: target.ref.path,
        reviewerExercisePath: reviewer.ref.path, assignmentDate: cohort.assignmentDate,
        subject: cohort.subject, grade: cohort.grade, topic: assignedTopics[0] ?? '', topics: assignedTopics,
        matchedTopics, topicMatchType: matchedTopics.length ? 'shared' : 'unshared-fallback',
        topicBreakdown: (Array.isArray(target.topicBreakdown) ? target.topicBreakdown : [])
          .filter((item) => !matchedTopics.length || assignedTopicKeys.has(normalizeTopic(item.topic))),
        questionLinks: assignedQuestionLinks,
        paperIds: Array.isArray(target.paperIds) ? target.paperIds : [],
        title: target.title ?? '', submittedImageUrl: target.submittedImageUrl ?? '', submittedImages: target.submittedImages ?? [],
        status: 'assigned', createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await sendNotificationToUsers({ userIds: [reviewer.studentId], title: 'New work to mark',
        body: `${cohort.subject} exercise is ready for peer marking.`, type: 'peer-marking.assigned', url: '/student?tab=mark',
        data: { assignmentId: assignmentRef.id, assignmentPath: assignmentRef.path, exerciseId: target.id }, tag: `peer-marking-${assignmentRef.id}` });
    }
    logger.info('Nested peer-marking allocation completed', { reviewerCount: reviewers.length, pairCount: pairs.length });
  },
);

export const completePeerMarkingAssignment = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to submit peer marking.');
  const { assignmentPath, reviewImages = [], reviewImageUrl, reviewFileName } = request.data ?? {};
  if (!assignmentPath || !/^users\/[^/]+\/subjects\/[^/]+\/exercises\/[^/]+\/peerMarkingAssignments\/[^/]+$/.test(assignmentPath)) {
    throw new HttpsError('invalid-argument', 'A valid nested assignment path is required.');
  }
  const pages = reviewImages.length ? reviewImages : reviewImageUrl ? [{ url: reviewImageUrl, fileName: reviewFileName, pageNumber: 1 }] : [];
  if (!pages.length) throw new HttpsError('invalid-argument', 'At least one marked image is required.');
  const db = getDb();
  const assignmentRef = db.doc(assignmentPath);
  const assignmentSnapshot = await assignmentRef.get();
  if (!assignmentSnapshot.exists) throw new HttpsError('not-found', 'Peer-marking assignment not found.');
  const assignment = assignmentSnapshot.data();
  if (assignment.reviewerId !== uid) throw new HttpsError('permission-denied', 'This work is assigned to another student.');
  if (assignment.status !== 'assigned') throw new HttpsError('failed-precondition', 'This assignment is no longer available.');
  const now = admin.firestore.Timestamp.now();
  const primary = pages[0];
  const reviewRef = assignmentRef.parent.parent.collection('peerReviews').doc();
  const batch = db.batch();
  batch.set(reviewRef, { reviewerId: uid, reviewerSubjectInstanceId: assignment.reviewerSubjectInstanceId,
    peerAssignmentId: assignmentRef.id, reviewImages: pages, reviewImageUrl: primary.url,
    reviewedAt: now, status: 'completed' });
  batch.update(assignmentRef, { reviewId: reviewRef.id, reviewImages: pages, reviewImageUrl: primary.url,
    reviewFileName: primary.fileName ?? '', status: 'completed', completedAt: now, updatedAt: now });
  batch.update(assignmentRef.parent.parent, { peerReviewed: 'Yes', peerReviewStatus: 'completed',
    peerReviewDate: now, peerMarkedImages: pages, peerReviewerId: uid, updatedAt: now });
  if (assignment.reviewerExercisePath) batch.set(db.doc(assignment.reviewerExercisePath), {
    peerMarkingImages: pages, markedPeerExerciseId: assignment.exerciseId,
    peerMarkingAssignmentId: assignmentRef.id, peerMarkingStatus: 'completed', updatedAt: now,
  }, { merge: true });
  await batch.commit();
  return { success: true, assignmentId: assignmentRef.id, reviewId: reviewRef.id, status: 'completed' };
});

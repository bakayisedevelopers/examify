import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';
import { getDb } from './admin.js';

const hasSubmission = (data = {}) => Boolean(data.submittedImageUrl && data.submittedFileName);

const buildCohortKey = (exercise = {}) => ({
  assignmentDate: exercise.assignmentDate,
  subject: exercise.subject,
  grade: exercise.grade,
});

const complete = (value) => value && value.assignmentDate && value.subject && value.grade;

const safeId = (value) => String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');

const getTime = (value) => value?.toDate?.()?.getTime?.() ?? 0;

const getRecentRevieweeMap = (historyDocs, currentDate) => {
  const rows = historyDocs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((item) => item.assignmentDate !== currentDate)
    .filter((item) => item.reviewerId && item.revieweeId)
    .sort((left, right) => {
      const dateCompare = String(right.assignmentDate ?? '').localeCompare(String(left.assignmentDate ?? ''));
      return dateCompare || (getTime(right.completedAt) - getTime(left.completedAt));
    });

  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row.reviewerId)) map.set(row.reviewerId, { recent: [], counts: new Map() });
    const entry = map.get(row.reviewerId);
    entry.counts.set(row.revieweeId, (entry.counts.get(row.revieweeId) ?? 0) + 1);
    if (!entry.recent.includes(row.revieweeId) && entry.recent.length < 3) {
      entry.recent.push(row.revieweeId);
    }
  });
  return map;
};

const buildAssignments = ({ submitted, completedToday, recentReviewees }) => {
  const completedReviewerIds = new Set(completedToday.map((item) => item.reviewerId).filter(Boolean));
  const completedExerciseIds = new Set(completedToday.map((item) => item.exerciseId).filter(Boolean));

  const reviewers = submitted.filter((item) => !completedReviewerIds.has(item.studentId));
  const targets = submitted.filter((item) => !completedExerciseIds.has(item.id));
  const usedTargetIds = new Set();
  const assignments = [];

  reviewers.forEach((reviewer) => {
    const history = recentReviewees.get(reviewer.studentId) ?? { recent: [], counts: new Map() };
    const options = targets
      .filter((target) => target.studentId !== reviewer.studentId)
      .filter((target) => !usedTargetIds.has(target.id))
      .map((target) => {
        const recentIndex = history.recent.indexOf(target.studentId);
        const recentPenalty = recentIndex === -1 ? 0 : 1000 - (recentIndex * 100);
        const repeatPenalty = (history.counts.get(target.studentId) ?? 0) * 10;
        const submittedAt = getTime(target.submittedAt) || getTime(target.updatedAt);
        return { target, score: recentPenalty + repeatPenalty + submittedAt / 10000000000000 };
      })
      .sort((left, right) => left.score - right.score || String(left.target.studentId).localeCompare(String(right.target.studentId)));

    const selected = options[0]?.target;
    if (!selected) return;
    usedTargetIds.add(selected.id);
    assignments.push({ reviewer, target: selected });
  });

  return assignments;
};

export const assignPeerMarkingOnSubmission = onDocumentWritten(
  { document: 'dailyExerciseAssignments/{exerciseId}', timeoutSeconds: 120, memory: '512MiB' },
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
    const assignmentsSnapshot = await db.collection('dailyExerciseAssignments')
      .where('assignmentDate', '==', cohort.assignmentDate)
      .where('subject', '==', cohort.subject)
      .where('grade', '==', cohort.grade)
      .get();

    const submitted = assignmentsSnapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((item) => hasSubmission(item))
      .filter((item, index, list) => item.studentId && list.findIndex((row) => row.studentId === item.studentId) === index)
      .sort((left, right) => {
        const leftTime = getTime(left.submittedAt) || getTime(left.updatedAt);
        const rightTime = getTime(right.submittedAt) || getTime(right.updatedAt);
        return leftTime - rightTime || String(left.studentId).localeCompare(String(right.studentId));
      });

    if (submitted.length < 2) {
      logger.info('Peer marking waiting for more submissions', { cohort, submittedCount: submitted.length });
      return;
    }

    const existingSnapshot = await db.collection('peerMarkingAssignments')
      .where('assignmentDate', '==', cohort.assignmentDate)
      .where('subject', '==', cohort.subject)
      .where('grade', '==', cohort.grade)
      .get();

    const completedToday = existingSnapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((item) => item.status === 'completed');

    const historySnapshot = await db.collection('peerMarkingAssignments')
      .where('subject', '==', cohort.subject)
      .where('grade', '==', cohort.grade)
      .get();
    const recentReviewees = getRecentRevieweeMap(historySnapshot.docs, cohort.assignmentDate);
    const pairs = buildAssignments({ submitted, completedToday, recentReviewees });

    const batch = db.batch();
    existingSnapshot.docs
      .filter((doc) => doc.data().status !== 'completed')
      .forEach((doc) => batch.delete(doc.ref));

    pairs.forEach(({ reviewer, target }) => {
      const assignmentId = safeId(`${cohort.assignmentDate}_${cohort.grade}_${cohort.subject}_${reviewer.studentId}_${target.id}`);
      batch.set(db.collection('peerMarkingAssignments').doc(assignmentId), {
        reviewerId: reviewer.studentId,
        revieweeId: target.studentId,
        exerciseId: target.id,
        reviewerExerciseId: reviewer.id,
        assignmentDate: cohort.assignmentDate,
        subject: cohort.subject,
        grade: cohort.grade,
        title: target.title ?? '',
        topic: target.topic ?? '',
        submittedImageUrl: target.submittedImageUrl ?? '',
        submittedFileName: target.submittedFileName ?? '',
        paperIds: target.paperIds ?? [],
        questionLinks: target.questionLinks ?? [],
        status: 'assigned',
        createdAt: new Date(),
        updatedAt: new Date(),
      }, { merge: true });
    });

    await batch.commit();
    logger.info('Peer marking assignments refreshed', { cohort, submittedCount: submitted.length, pairCount: pairs.length });
  }
);

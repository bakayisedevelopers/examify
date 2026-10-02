import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { admin, getDb } from './admin.js';

const normalizeTopicKey = (value = '') => String(value)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/['’]s\b/g, '')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

const normalizeSubject = (value = '') => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const requireActor = async (db, uid) => {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before reviewing student work.');
  const snapshot = await db.collection('users').doc(uid).get();
  if (!snapshot.exists) throw new HttpsError('permission-denied', 'The signed-in account was not found.');
  const profile = snapshot.data();
  if (profile.role !== 'admin' && !['tutor', 'teacher'].includes(profile.role)) {
    throw new HttpsError('permission-denied', 'Only an assigned tutor or admin can review student work.');
  }
  return profile;
};

const getStaffRole = (episode, uid) => uid === episode.primaryTutorId
  ? 'co-owner'
  : episode.staffByUid?.[uid] ?? '';

const requireEpisodeAccess = ({ episode, uid, isAdmin, allowedRoles = ['co-owner', 'marker'] }) => {
  if (!episode || episode.status !== 'active') throw new HttpsError('failed-precondition', 'The student subject is no longer active.');
  const role = getStaffRole(episode, uid);
  if (!isAdmin && !allowedRoles.includes(role)) {
    throw new HttpsError('permission-denied', 'Your tutor access does not allow this action.');
  }
  return role;
};

const averageWithNewScore = ({ topic, score }) => {
  const count = Number(topic.scoreCount) || 0;
  const previousAverage = Number(topic.understandingLevel) || 0;
  return Math.round(((previousAverage * count) + score) / (count + 1));
};

const findAssignment = async (db, assignmentId) => {
  const snapshot = await db.collectionGroup('peerMarkingAssignments')
    .where('assignmentId', '==', assignmentId).limit(1).get();
  return snapshot.docs[0] ?? null;
};

export const getCompletedPeerMarkingWorkForTutor = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = request.auth?.uid;
  const { studentId, subject } = request.data ?? {};
  if (!studentId || !subject) throw new HttpsError('invalid-argument', 'A student and subject are required.');
  const db = getDb();
  const actor = await requireActor(db, uid);
  const isAdmin = actor.role === 'admin';
  const episodes = await db.collection('users').doc(studentId).collection('subjects')
    .where('subjectKey', '==', subject).where('status', '==', 'active').limit(1).get();
  if (episodes.empty) throw new HttpsError('not-found', 'The student subject is not active.');
  requireEpisodeAccess({ episode: episodes.docs[0].data(), uid, isAdmin, allowedRoles: ['co-owner', 'marker', 'viewer'] });

  const assignments = await db.collectionGroup('peerMarkingAssignments')
    .where('reviewerId', '==', studentId).where('status', '==', 'completed').get();
  return assignments.docs.map((item) => ({ id: item.id, ...item.data(), assignmentPath: item.ref.path }))
    .filter((item) => item.subject === subject && item.reviewImageUrl);
});

export const reviewTutorPeerMarkingAssignment = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = request.auth?.uid;
  const { peerAssignmentId, studentId, understandingLevel } = request.data ?? {};
  const score = Number(understandingLevel);
  if (!peerAssignmentId || !studentId || !Number.isFinite(score) || score < 0 || score > 10) {
    throw new HttpsError('invalid-argument', 'A peer assignment, student, and score from 0 to 10 are required.');
  }
  const db = getDb();
  const actor = await requireActor(db, uid);
  const assignmentSnapshot = await findAssignment(db, peerAssignmentId);
  if (!assignmentSnapshot) throw new HttpsError('not-found', 'Peer-marking assignment not found.');
  const assignment = assignmentSnapshot.data();
  if (assignment.status !== 'completed' || assignment.reviewerId !== studentId) {
    throw new HttpsError('failed-precondition', 'Only this student’s completed peer marking can be reviewed.');
  }
  const subjectInstanceId = assignment.reviewerSubjectInstanceId;
  const episodeRef = db.collection('users').doc(studentId).collection('subjects').doc(subjectInstanceId);
  const episodeSnapshot = await episodeRef.get();
  const episode = episodeSnapshot.exists ? episodeSnapshot.data() : null;
  requireEpisodeAccess({ episode, uid, isAdmin: actor.role === 'admin' });
  if (normalizeSubject(episode.subjectKey) !== normalizeSubject(assignment.subject)) {
    throw new HttpsError('failed-precondition', 'The peer assignment does not match the student subject.');
  }

  const topicName = String(assignment.topic || assignment.topics?.[0] || '').trim();
  const canonicalTopicKey = normalizeTopicKey(topicName);
  if (!canonicalTopicKey) throw new HttpsError('failed-precondition', 'The peer assignment has no topic to review.');
  const topicRef = episodeRef.collection('topics').doc(canonicalTopicKey);
  const scoreRef = topicRef.collection('understandingScores').doc(`markingReview-${peerAssignmentId}`);
  const now = admin.firestore.FieldValue.serverTimestamp();
  let average = score;
  await db.runTransaction(async (transaction) => {
    const [currentAssignment, currentEpisode, topicSnapshot, existingScore] = await Promise.all([
      transaction.get(assignmentSnapshot.ref), transaction.get(episodeRef), transaction.get(topicRef), transaction.get(scoreRef),
    ]);
    const current = currentAssignment.data();
    if (current.status !== 'completed' || current.reviewerId !== studentId) {
      throw new HttpsError('failed-precondition', 'The peer-marking assignment is no longer available.');
    }
    requireEpisodeAccess({ episode: currentEpisode.data(), uid, isAdmin: actor.role === 'admin' });
    if (!topicSnapshot.exists()) throw new HttpsError('failed-precondition', 'Complete a lesson on this topic before recording a review score.');
    if (existingScore.exists()) {
      if (Number(existingScore.data().score) !== score) {
        throw new HttpsError('already-exists', 'This peer-marking review already has an immutable score.');
      }
      average = Number(topicSnapshot.data().understandingLevel) || score;
      return;
    }
    const topic = topicSnapshot.data();
    average = averageWithNewScore({ topic, score });
    transaction.set(scoreRef, {
      sourceType: 'markingReview', sourceId: peerAssignmentId, score, tutorId: uid,
      notes: 'Tutor evaluation of peer marking', createdAt: now,
    });
    transaction.update(topicRef, {
      latestScore: score, understandingLevel: average,
      scoreCount: (Number(topic.scoreCount) || 0) + 1,
      tutorReport: 'Tutor evaluation of peer marking', updatedAt: now,
    });
    transaction.update(assignmentSnapshot.ref, {
      tutorReviewStatus: 'reviewed', tutorReviewed: true, tutorReviewedBy: uid,
      tutorReviewedAt: now, tutorUnderstandingLevel: score, tutorReviewTopic: topicName, updatedAt: now,
    });
  });
  return { peerAssignmentId, topic: topicName, understandingLevel: score, averageUnderstandingLevel: average, reviewed: true };
});

export const saveTutorExerciseScore = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = request.auth?.uid;
  const { studentId, subjectInstanceId, exerciseId, subject, topic, scoreEventId, understandingLevel } = request.data ?? {};
  const score = Number(understandingLevel);
  const canonicalTopicKey = normalizeTopicKey(topic);
  if (!studentId || !subjectInstanceId || !exerciseId || !subject || !canonicalTopicKey
    || !/^[a-zA-Z0-9_-]{1,100}$/.test(String(scoreEventId ?? ''))
    || !Number.isFinite(score) || score < 0 || score > 10) {
    throw new HttpsError('invalid-argument', 'Student, subject episode, exercise, topic, score event, and a score from 0 to 10 are required.');
  }
  const db = getDb();
  const actor = await requireActor(db, uid);
  const episodeRef = db.collection('users').doc(studentId).collection('subjects').doc(subjectInstanceId);
  const exerciseRef = episodeRef.collection('exercises').doc(exerciseId);
  const episodeSnapshot = await episodeRef.get();
  const episode = episodeSnapshot.exists ? episodeSnapshot.data() : null;
  requireEpisodeAccess({ episode, uid, isAdmin: actor.role === 'admin' });
  if (normalizeSubject(episode.subjectKey) !== normalizeSubject(subject)) {
    throw new HttpsError('failed-precondition', 'The exercise subject does not match the student subject episode.');
  }

  const topicRef = episodeRef.collection('topics').doc(canonicalTopicKey);
  const scoreRef = topicRef.collection('understandingScores').doc(`Exercise-${scoreEventId}`);
  const now = admin.firestore.FieldValue.serverTimestamp();
  let average = score;
  await db.runTransaction(async (transaction) => {
    const [currentEpisode, exerciseSnapshot, topicSnapshot, existingScore] = await Promise.all([
      transaction.get(episodeRef), transaction.get(exerciseRef), transaction.get(topicRef), transaction.get(scoreRef),
    ]);
    requireEpisodeAccess({ episode: currentEpisode.data(), uid, isAdmin: actor.role === 'admin' });
    if (!exerciseSnapshot.exists()) throw new HttpsError('not-found', 'Exercise not found.');
    const exercise = exerciseSnapshot.data();
    if (exercise.studentId && exercise.studentId !== studentId) throw new HttpsError('permission-denied', 'This exercise belongs to another student.');
    if (normalizeSubject(exercise.subject) !== normalizeSubject(subject)) throw new HttpsError('failed-precondition', 'The exercise subject does not match.');
    const submitted = Boolean(exercise.submittedImageUrl || exercise.submittedAt
      || exercise.submissionStatus === 'submitted' || exercise.submissionStatus === 'graded'
      || exercise.submitted === 'Yes'
      || (Array.isArray(exercise.submittedImages) && exercise.submittedImages.length));
    if (!submitted) throw new HttpsError('failed-precondition', 'A tutor can score an exercise only after the student submits handwritten work.');
    const exerciseTopics = [...new Set([...(Array.isArray(exercise.topics) ? exercise.topics : []), exercise.topic]
      .filter(Boolean).map(normalizeTopicKey))];
    if (exerciseTopics.length && !exerciseTopics.includes(canonicalTopicKey)) {
      throw new HttpsError('failed-precondition', 'The selected topic is not part of this exercise.');
    }
    if (!topicSnapshot.exists()) throw new HttpsError('failed-precondition', 'Complete a lesson on this topic before recording an exercise score.');
    if (existingScore.exists()) {
      if (Number(existingScore.data().score) !== score) throw new HttpsError('already-exists', 'This score event is immutable.');
      average = Number(topicSnapshot.data().understandingLevel) || score;
      return;
    }
    const topicData = topicSnapshot.data();
    average = averageWithNewScore({ topic: topicData, score });
    transaction.set(scoreRef, {
      sourceType: 'Exercise', sourceId: exerciseId, score, tutorId: uid,
      notes: `Tutor mark for exercise: ${exercise.title || 'Exercise'}`, createdAt: now,
    });
    transaction.update(topicRef, {
      latestScore: score, understandingLevel: average,
      scoreCount: (Number(topicData.scoreCount) || 0) + 1,
      tutorReport: `Tutor mark for exercise: ${exercise.title || 'Exercise'}`, updatedAt: now,
    });
    transaction.update(exerciseRef, {
      updatedAt: now,
    });
  });
  return { topic: String(topic).trim(), understandingLevel: average, exerciseId };
});

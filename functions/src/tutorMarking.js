import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { admin, getDb } from './admin.js';
import { getExerciseTopicNames } from './peerMarkingAllocation.js';

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

const SCORE_WINDOW_DAYS = 28;
const getScoreWindowStart = (now = admin.firestore.Timestamp.now()) =>
  admin.firestore.Timestamp.fromMillis(now.toMillis() - (SCORE_WINDOW_DAYS * 24 * 60 * 60 * 1000));

const understandingRatioFromRecord = (record = {}) => {
  const score = Number(record.score);
  if (!Number.isFinite(score) || score < 0) return null;
  if (record.scoreScale === 'ratio-0-to-1') return score <= 1 ? score : null;
  const hasQuestionMarks = Number.isFinite(Number(record.earnedMarks)) && Number.isFinite(Number(record.totalMarks))
    && Number(record.totalMarks) > 0;
  const divisor = record.sourceType === 'Lesson' || !hasQuestionMarks ? 10 : 100;
  const ratio = score / divisor;
  return ratio <= 1 ? ratio : null;
};

const makeTopicRollup = (scoreSnapshots, now, additionalScore = null) => {
  const cutoff = getScoreWindowStart(now).toMillis();
  const scores = scoreSnapshots.docs
    .map((snapshot) => snapshot.data())
    .filter((item) => item.createdAt?.toMillis?.() >= cutoff)
    .map((item) => ({ score: understandingRatioFromRecord(item), createdAt: item.createdAt }))
    .filter((item) => item.score !== null);
  const additionalScores = Array.isArray(additionalScore) ? additionalScore : additionalScore ? [additionalScore] : [];
  scores.push(...additionalScores);
  scores.sort((left, right) => left.createdAt.toMillis() - right.createdAt.toMillis());
  const count = scores.length;
  const average = count
    ? Math.round((scores.reduce((total, item) => total + item.score, 0) / count) * 10000) / 10000
    : null;
  return {
    understandingLevel: average,
    understandingScale: 'ratio-0-to-1',
    scoreCount: count,
    latestScore: count ? scores[count - 1].score : null,
    scoreWindowDays: SCORE_WINDOW_DAYS,
    scoreUpdatedAt: now,
  };
};

const recentTopicScoresQuery = (topicRef, now) => topicRef.collection('understandingScores')
  .where('createdAt', '>=', getScoreWindowStart(now));

const normalizeQuestionMarks = (questionMarks, label = 'Question marks') => {
  if (!Array.isArray(questionMarks) || !questionMarks.length || questionMarks.length > 100) {
    throw new HttpsError('invalid-argument', `${label} must include one or more questions.`);
  }
  const normalized = questionMarks.map((item) => {
    const earnedMarks = Number(item?.earnedMarks);
    const totalMarks = Number(item?.totalMarks);
    const questionReference = String(item?.questionReference || '').trim();
    const paperId = String(item?.paperId || '').trim();
    const pageNumber = Number(item?.pageNumber) || 0;
    if (!questionReference || !Number.isFinite(earnedMarks) || !Number.isFinite(totalMarks) || totalMarks <= 0 || earnedMarks < 0 || earnedMarks > totalMarks) {
      throw new HttpsError('invalid-argument', `${label} must include a question reference and earned marks from 0 through the available marks for each question.`);
    }
    return { questionReference, paperId, pageNumber, earnedMarks, totalMarks };
  });
  if (new Set(normalized.map((item) => item.questionReference)).size !== normalized.length) {
    throw new HttpsError('invalid-argument', `${label} must list each question only once.`);
  }
  return normalized;
};

const scoreForQuestion = ({ earnedMarks, totalMarks }) =>
  Math.round((earnedMarks / totalMarks) * 10000) / 10000;

const scoreFromQuestionMarks = (questionMarks) => questionMarks.length
  ? Math.round((questionMarks.reduce((total, item) => total + scoreForQuestion(item), 0) / questionMarks.length) * 10000) / 10000
  : 0;

const safeDocumentIdPart = (value) => encodeURIComponent(String(value ?? '')).replace(/%/g, '_') || 'unknown';

const questionScoreRef = ({ topicRef, sourceType, sourceId, scoreEventId, questionReference, paperId = '' }) =>
  topicRef.collection('understandingScores').doc(`${sourceType}-${safeDocumentIdPart(sourceId)}-${scoreEventId}-${safeDocumentIdPart(paperId)}-${safeDocumentIdPart(questionReference)}`);

const ensureQuestionMarksMatchIndexedQuestions = ({ questionMarks, indexedQuestions = [], topic }) => {
  const topicKey = normalizeTopicKey(topic);
  const applicable = indexedQuestions.filter((item) => normalizeTopicKey(item.topic) === topicKey);
  if (!applicable.length) return;
  const byReference = new Map(applicable.map((item) => [String(item.questionReference || '').trim(), item]));
  const providedReferences = new Set(questionMarks.map((mark) => mark.questionReference));
  if (providedReferences.size !== byReference.size || [...byReference.keys()].some((reference) => !providedReferences.has(reference))) {
    throw new HttpsError('invalid-argument', `Enter marks for every indexed question under ${topic}.`);
  }
  for (const mark of questionMarks) {
    const indexed = byReference.get(mark.questionReference);
    if (!indexed) throw new HttpsError('failed-precondition', `Question ${mark.questionReference} does not belong to ${topic}.`);
    if (mark.paperId && String(indexed.paperId || '') !== mark.paperId) {
      throw new HttpsError('failed-precondition', `Question ${mark.questionReference} is linked to a different paper.`);
    }
    if (mark.pageNumber && Number(indexed.pageNumber) !== mark.pageNumber) {
      throw new HttpsError('failed-precondition', `Question ${mark.questionReference} is linked to a different page.`);
    }
    const knownTotal = Number(indexed.marks);
    if (Number.isFinite(knownTotal) && knownTotal > 0 && mark.totalMarks !== knownTotal) {
      throw new HttpsError('failed-precondition', `The available marks for question ${mark.questionReference} must be ${knownTotal}.`);
    }
  }
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
  const { peerAssignmentId, studentId, topicMarks, scoreEventId } = request.data ?? {};
  if (!peerAssignmentId || !studentId || !Array.isArray(topicMarks) || !topicMarks.length
    || !/^[a-zA-Z0-9_-]{1,100}$/.test(String(scoreEventId ?? ''))) {
    throw new HttpsError('invalid-argument', 'A peer assignment, student, per-topic question marks, and score event ID are required.');
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

  const assignmentTopics = getExerciseTopicNames(assignment);
  const scoreEntries = [...new Map(topicMarks.map((item) => {
    const topicName = String(item?.topic || '').trim();
    const canonicalTopicKey = normalizeTopicKey(topicName);
    if (!canonicalTopicKey || !assignmentTopics.some((topic) => normalizeTopicKey(topic) === canonicalTopicKey)) {
      throw new HttpsError('invalid-argument', `Topic ${topicName || '(empty)'} is not part of this marking assignment.`);
    }
    const questionMarks = normalizeQuestionMarks(item.questionMarks, `${topicName} question marks`);
    ensureQuestionMarksMatchIndexedQuestions({ questionMarks, indexedQuestions: assignment.questionLinks ?? [], topic: topicName });
    const topicRef = episodeRef.collection('topics').doc(canonicalTopicKey);
    return [canonicalTopicKey, {
      topicName,
      canonicalTopicKey,
      questionMarks,
      score: scoreFromQuestionMarks(questionMarks),
      topicRef,
      scoreRefs: questionMarks.map((mark) => questionScoreRef({
        topicRef, sourceType: 'Marking', sourceId: peerAssignmentId, scoreEventId, questionReference: mark.questionReference, paperId: mark.paperId,
      })),
    }];
  })).values()];
  if (scoreEntries.length !== assignmentTopics.length) {
    throw new HttpsError('invalid-argument', 'Enter marks for every topic in the peer-marked work.');
  }
  const now = admin.firestore.Timestamp.now();
  const averages = [];
  await db.runTransaction(async (transaction) => {
    averages.length = 0;
    const entryReads = scoreEntries.map((entry) => Promise.all([
      transaction.get(entry.topicRef),
      transaction.get(recentTopicScoresQuery(entry.topicRef, now)),
      ...entry.scoreRefs.map((scoreRef) => transaction.get(scoreRef)),
    ]));
    const [currentAssignment, currentEpisode, ...topicReads] = await Promise.all([
      transaction.get(assignmentSnapshot.ref), transaction.get(episodeRef),
      ...entryReads,
    ]);
    const current = currentAssignment.data();
    if (current.status !== 'completed' || current.reviewerId !== studentId) {
      throw new HttpsError('failed-precondition', 'The peer-marking assignment is no longer available.');
    }
    requireEpisodeAccess({ episode: currentEpisode.data(), uid, isAdmin: actor.role === 'admin' });
    const scoreResults = [];
    scoreEntries.forEach((entry, index) => {
      const [topicSnapshot, recentScores, ...existingScores] = topicReads[index];
      const topicData = topicSnapshot.exists ? topicSnapshot.data() : {};
      const topicIsDone = topicData.topicStatus === 'done'
        || topicData.attendanceStatus === 'attended'
        || Boolean(topicData.firstCompletedAt);
      const additionalScores = [];
      const questionScores = entry.questionMarks.map((mark, questionIndex) => {
        const score = scoreForQuestion(mark);
        const existingScore = existingScores[questionIndex];
        if (existingScore.exists) {
          const existing = existingScore.data();
          if (Number(existing.score) !== score || Number(existing.earnedMarks) !== mark.earnedMarks || Number(existing.totalMarks) !== mark.totalMarks) {
            throw new HttpsError('already-exists', 'This marking question score event already exists with different marks.');
          }
        } else {
          additionalScores.push({ score, createdAt: now });
          transaction.set(entry.scoreRefs[questionIndex], {
            sourceType: 'Marking', sourceId: peerAssignmentId, peerAssignmentId,
            exerciseId: assignment.exerciseId ?? assignment.markedExerciseId ?? null,
            scoreEventId,
            questionReference: mark.questionReference, paperId: mark.paperId, pageNumber: mark.pageNumber,
            earnedMarks: mark.earnedMarks, totalMarks: mark.totalMarks,
            score, scoreScale: 'ratio-0-to-1', tutorId: uid,
            notes: `Tutor evaluation of peer marking ${peerAssignmentId} for exercise ${assignment.exerciseId ?? 'unknown'}; question ${mark.questionReference}`, createdAt: now,
          });
        }
        return { questionReference: mark.questionReference, paperId: mark.paperId, pageNumber: mark.pageNumber, score, earnedMarks: mark.earnedMarks, totalMarks: mark.totalMarks };
      });
      const rollup = makeTopicRollup(recentScores, now, additionalScores);
      transaction.set(entry.topicRef, {
        ...(!topicSnapshot.exists ? {
          canonicalTopicKey: entry.canonicalTopicKey,
          topicName: entry.topicName,
          createdAt: now,
        } : {}),
        ...(!topicIsDone ? {
          topicStatus: 'marked',
          attendanceStatus: 'not-attended',
          firstMarkedAt: topicData.firstMarkedAt ?? now,
        } : {}),
        ...rollup,
        tutorReport: 'Tutor evaluation of peer marking', updatedAt: now,
      }, { merge: true });
      scoreResults.push({ topic: entry.topicName, understandingLevel: entry.score, averageUnderstandingLevel: rollup.understandingLevel, questionScores });
    });
    transaction.update(assignmentSnapshot.ref, {
      tutorReviewStatus: 'reviewed', tutorReviewed: true, tutorReviewedBy: uid,
      tutorReviewedAt: now,
      tutorTopicScores: scoreResults,
      tutorUnderstandingLevel: scoreResults.length ? scoreResults.reduce((total, item) => total + item.understandingLevel, 0) / scoreResults.length : null,
      tutorReviewTopic: assignmentTopics.join(' | '), updatedAt: now,
    });
    averages.push(...scoreResults);
  });
  return { peerAssignmentId, topicScores: averages, reviewed: true };
});

export const saveTutorExerciseScore = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = request.auth?.uid;
  const { studentId, subjectInstanceId, exerciseId, subject, topic, scoreEventId, questionMarks } = request.data ?? {};
  const canonicalTopicKey = normalizeTopicKey(topic);
  if (!studentId || !subjectInstanceId || !exerciseId || !subject || !canonicalTopicKey
    || !/^[a-zA-Z0-9_-]{1,100}$/.test(String(scoreEventId ?? ''))) {
    throw new HttpsError('invalid-argument', 'Student, subject episode, exercise, topic, question marks, and score event are required.');
  }
  const normalizedQuestionMarks = normalizeQuestionMarks(questionMarks);
  const score = scoreFromQuestionMarks(normalizedQuestionMarks);
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
  const scoreRefs = normalizedQuestionMarks.map((mark) => questionScoreRef({
    topicRef, sourceType: 'Exercise', sourceId: exerciseId, scoreEventId, questionReference: mark.questionReference, paperId: mark.paperId,
  }));
  const now = admin.firestore.Timestamp.now();
  let average = score;
  await db.runTransaction(async (transaction) => {
    const [currentEpisode, exerciseSnapshot, topicSnapshot, recentScores, ...existingScores] = await Promise.all([
      transaction.get(episodeRef), transaction.get(exerciseRef), transaction.get(topicRef), transaction.get(recentTopicScoresQuery(topicRef, now)),
      ...scoreRefs.map((scoreRef) => transaction.get(scoreRef)),
    ]);
    requireEpisodeAccess({ episode: currentEpisode.data(), uid, isAdmin: actor.role === 'admin' });
    if (!exerciseSnapshot.exists) throw new HttpsError('not-found', 'Exercise not found.');
    const exercise = exerciseSnapshot.data();
    if (exercise.studentId && exercise.studentId !== studentId) throw new HttpsError('permission-denied', 'This exercise belongs to another student.');
    if (normalizeSubject(exercise.subject) !== normalizeSubject(subject)) throw new HttpsError('failed-precondition', 'The exercise subject does not match.');
    const submitted = Boolean(exercise.submittedImageUrl || exercise.submittedAt
      || exercise.submissionStatus === 'submitted' || exercise.submissionStatus === 'graded'
      || exercise.submitted === 'Yes'
      || (Array.isArray(exercise.submittedImages) && exercise.submittedImages.length));
    if (!submitted) throw new HttpsError('failed-precondition', 'A tutor can score an exercise only after the student submits handwritten work.');
    const exerciseTopics = getExerciseTopicNames(exercise).map(normalizeTopicKey);
    if (exerciseTopics.length && !exerciseTopics.includes(canonicalTopicKey)) {
      throw new HttpsError('failed-precondition', 'The selected topic is not part of this exercise.');
    }
    ensureQuestionMarksMatchIndexedQuestions({ questionMarks: normalizedQuestionMarks, indexedQuestions: exercise.questionLinks ?? [], topic });
    if (!topicSnapshot.exists) throw new HttpsError('failed-precondition', 'Complete a lesson on this topic before recording an exercise score.');
    const additionalScores = [];
    normalizedQuestionMarks.forEach((mark, index) => {
      const questionScore = scoreForQuestion(mark);
      const existingScore = existingScores[index];
      if (existingScore.exists) {
        const existing = existingScore.data();
        if (Number(existing.score) !== questionScore || Number(existing.earnedMarks) !== mark.earnedMarks || Number(existing.totalMarks) !== mark.totalMarks) {
          throw new HttpsError('already-exists', 'This exercise question score event is immutable.');
        }
        return;
      }
      additionalScores.push({ score: questionScore, createdAt: now });
      transaction.set(scoreRefs[index], {
        sourceType: 'Exercise', sourceId: exerciseId, exerciseId, scoreEventId,
        questionReference: mark.questionReference, paperId: mark.paperId, pageNumber: mark.pageNumber,
        earnedMarks: mark.earnedMarks, totalMarks: mark.totalMarks,
        score: questionScore, scoreScale: 'ratio-0-to-1', tutorId: uid,
        notes: `Tutor mark for exercise ${exerciseId} (${exercise.title || 'Exercise'}); question ${mark.questionReference}`,
        createdAt: now,
      });
    });
    const rollup = makeTopicRollup(recentScores, now, additionalScores);
    average = rollup.understandingLevel;
    transaction.update(topicRef, {
      ...rollup,
      tutorReport: `Tutor mark for exercise: ${exercise.title || 'Exercise'}`, updatedAt: now,
    });
    transaction.update(exerciseRef, {
      updatedAt: now,
    });
  });
  return { topic: String(topic).trim(), understandingLevel: average, exerciseId, score };
});

export const removeCompletedTopicFromLesson = onCall({ cpu: 'gcf_gen1', maxInstances: 1, concurrency: 1 }, async (request) => {
  const uid = request.auth?.uid;
  const { studentId, subjectInstanceId, lessonId, subject, topic } = request.data ?? {};
  const topicName = String(topic ?? '').trim();
  const topicKey = normalizeTopicKey(topicName);
  if (!studentId || !subjectInstanceId || !lessonId || !subject || !topicKey) {
    throw new HttpsError('invalid-argument', 'Student, subject, completed lesson, and topic are required.');
  }

  const db = getDb();
  const actor = await requireActor(db, uid);
  const isAdmin = actor.role === 'admin';
  const episodeRef = db.collection('users').doc(studentId).collection('subjects').doc(subjectInstanceId);
  const lessonRef = episodeRef.collection('lessons').doc(lessonId);
  const topicRef = episodeRef.collection('topics').doc(topicKey);
  const lessonScoreRef = topicRef.collection('understandingScores').doc(`Lesson-${lessonId}`);
  const now = admin.firestore.Timestamp.now();
  let result;

  await db.runTransaction(async (transaction) => {
    const completedLessonsQuery = episodeRef.collection('lessons').where('status', '==', 'completed');
    const recentScoresQuery = recentTopicScoresQuery(topicRef, now);
    const [episodeSnapshot, lessonSnapshot, topicSnapshot, lessonScoreSnapshot, completedLessonsSnapshot, recentScoresSnapshot] = await Promise.all([
      transaction.get(episodeRef),
      transaction.get(lessonRef),
      transaction.get(topicRef),
      transaction.get(lessonScoreRef),
      transaction.get(completedLessonsQuery),
      transaction.get(recentScoresQuery),
    ]);
    const episode = episodeSnapshot.exists ? episodeSnapshot.data() : null;
    requireEpisodeAccess({ episode, uid, isAdmin, allowedRoles: ['co-owner'] });
    if (normalizeSubject(episode.subjectKey) !== normalizeSubject(subject)) {
      throw new HttpsError('failed-precondition', 'The lesson subject does not match the active student subject.');
    }
    if (!lessonSnapshot.exists) throw new HttpsError('not-found', 'Completed lesson not found.');
    const lesson = lessonSnapshot.data();
    if (lesson.status !== 'completed') throw new HttpsError('failed-precondition', 'Only a completed lesson topic can be removed.');
    const lessonTopics = [...new Set([
      ...(Array.isArray(lesson.topics) ? lesson.topics : []),
      lesson.topic,
      ...(Array.isArray(lesson.topicUnderstandingScores) ? lesson.topicUnderstandingScores.map((entry) => entry?.topic) : []),
    ].map((value) => String(value ?? '').trim()).filter(Boolean))];
    if (!lessonTopics.some((value) => normalizeTopicKey(value) === topicKey)) {
      throw new HttpsError('not-found', 'This topic is not part of the selected lesson.');
    }

    const remainingTopics = lessonTopics.filter((value) => normalizeTopicKey(value) !== topicKey);
    const storedTopicScores = Array.isArray(lesson.topicUnderstandingScores) ? lesson.topicUnderstandingScores : null;
    const remainingTopicScores = storedTopicScores?.filter((entry) => normalizeTopicKey(entry?.topic) !== topicKey);
    const deleteField = admin.firestore.FieldValue.delete();
    const lessonChanges = remainingTopics.length
      ? {
        topics: remainingTopics,
        topic: remainingTopics[0],
        ...(storedTopicScores ? { topicUnderstandingScores: remainingTopicScores } : {}),
        updatedAt: now,
      }
      : {
        topics: deleteField,
        topic: deleteField,
        topicUnderstandingScores: deleteField,
        understandingLevel: deleteField,
        completedOn: deleteField,
        status: 'incomplete',
        updatedAt: now,
      };
    transaction.update(lessonRef, lessonChanges);
    if (lessonScoreSnapshot.exists) transaction.delete(lessonScoreRef);

    const anotherCompletedLessonHasTopic = completedLessonsSnapshot.docs.some((item) => {
      if (item.id === lessonId) return false;
      const data = item.data();
      return [...new Set([
        ...(Array.isArray(data.topics) ? data.topics : []),
        data.topic,
        ...(Array.isArray(data.topicUnderstandingScores) ? data.topicUnderstandingScores.map((entry) => entry?.topic) : []),
      ].map((value) => String(value ?? '').trim()).filter(Boolean))]
        .some((value) => normalizeTopicKey(value) === topicKey);
    });
    if (topicSnapshot.exists) {
      const otherScores = {
        docs: recentScoresSnapshot.docs.filter((item) => item.id !== lessonScoreRef.id),
      };
      transaction.update(topicRef, {
        ...makeTopicRollup(otherScores, now),
        topicStatus: anotherCompletedLessonHasTopic ? 'done' : 'removed',
        attendanceStatus: anotherCompletedLessonHasTopic ? 'attended' : 'not-attended',
        ...(!anotherCompletedLessonHasTopic ? {
          firstCompletedAt: deleteField,
          lastCoveredAt: deleteField,
        } : {}),
        updatedAt: now,
      });
    }

    result = {
      removedTopic: topicName,
      remainingTopics,
      lessonStatus: remainingTopics.length ? 'completed' : 'incomplete',
      topicRemainsCompleted: anotherCompletedLessonHasTopic,
    };
  });

  return result;
});

export const refreshTopicUnderstandingAverages = onCall({ timeoutSeconds: 540, memory: '1GiB', cpu: 1 }, async (request) => {
  const uid = request.auth?.uid;
  const episodes = request.data?.episodes;
  if (!Array.isArray(episodes) || !episodes.length || episodes.length > 500) {
    throw new HttpsError('invalid-argument', 'One or more student subject episodes are required.');
  }
  const db = getDb();
  const actor = await requireActor(db, uid);
  const isAdmin = actor.role === 'admin';
  const now = admin.firestore.Timestamp.now();
  const cutoff = getScoreWindowStart(now);
  const normalizedEpisodes = episodes.map((item) => {
    const studentId = String(item?.studentId || '');
    const subjectInstanceId = String(item?.subjectInstanceId || '');
    const requestedTopicIds = (Array.isArray(item?.topicIds) ? item.topicIds : []).map((topicId) => String(topicId || ''));
    const topicIds = [...new Set(requestedTopicIds)];
    if (!studentId || !subjectInstanceId || topicIds.length > 30) {
      throw new HttpsError('invalid-argument', 'Each episode needs a student, subject episode, and up to 30 topic IDs.');
    }
    if (topicIds.some((topicId) => !/^[a-z0-9 ]{1,120}$/.test(topicId))) {
      throw new HttpsError('invalid-argument', 'Topic IDs must be canonical topic keys.');
    }
    return { studentId, subjectInstanceId, topicIds };
  });
  const verifiedEpisodes = await Promise.all(normalizedEpisodes.map(async (item) => {
    if (!item.topicIds.length) return { ...item, episodeRef: null };
    const episodeRef = db.collection('users').doc(item.studentId).collection('subjects').doc(item.subjectInstanceId);
    const episodeSnapshot = await episodeRef.get();
    requireEpisodeAccess({ episode: episodeSnapshot.exists ? episodeSnapshot.data() : null, uid, isAdmin });
    return { ...item, episodeRef };
  }));
  const topicJobs = verifiedEpisodes.flatMap((item) => item.episodeRef
    ? item.topicIds.map((topicId) => ({ topicRef: item.episodeRef.collection('topics').doc(topicId) }))
    : []);
  let updatedCount = 0;
  for (let index = 0; index < topicJobs.length; index += 50) {
    const computedRollups = await Promise.all(topicJobs.slice(index, index + 50).map(async ({ topicRef }) => {
      const topicSnapshot = await topicRef.get();
      if (!topicSnapshot.exists) return null;
      const scoreSnapshot = await topicRef.collection('understandingScores').where('createdAt', '>=', cutoff).get();
      return { topicRef, rollup: makeTopicRollup(scoreSnapshot, now) };
    }));
    const batch = db.batch();
    computedRollups.filter(Boolean).forEach(({ topicRef, rollup }) => {
      batch.update(topicRef, { ...rollup, updatedAt: now });
      updatedCount += 1;
    });
    const updates = computedRollups.filter(Boolean).length;
    if (updates) await batch.commit();
  }
  return { updatedCount, scoreWindowDays: SCORE_WINDOW_DAYS };
});

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
  if (new Set(normalized.map((item) => `${item.paperId}::${item.questionReference}`)).size !== normalized.length) {
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

const questionScoreRef = ({ topicRef, sourceType, sourceId, questionReference, paperId = '' }) =>
  topicRef.collection('understandingScores').doc(`${sourceType}-${safeDocumentIdPart(sourceId)}-${safeDocumentIdPart(paperId)}-${safeDocumentIdPart(questionReference)}`);

const ensureQuestionMarksBelongToIndexedQuestions = ({ questionMarks, indexedQuestions = [], topic, topicId = '' }) => {
  if (!indexedQuestions.length) return;
  const topicKey = normalizeTopicKey(topic);
  for (const mark of questionMarks) {
    const indexed = indexedQuestions.find((item) => {
      const reference = String(item.questionReference || item.reference || '').trim();
      const paperId = String(item.paperId || '').trim();
      const matchesReference = reference === mark.questionReference;
      const matchesPaper = !mark.paperId || !paperId || paperId === mark.paperId;
      const matchesPage = !mark.pageNumber || !Number(item.pageNumber) || Number(item.pageNumber) === mark.pageNumber;
      const indexedTopicId = String(item.topicId || item.canonicalTopicKey || '').trim();
      const matchesTopic = topicId && indexedTopicId
        ? topicId === indexedTopicId || normalizeTopicKey(item.topic) === topicKey
        : normalizeTopicKey(item.topic) === topicKey;
      return matchesReference && matchesPaper && matchesPage && matchesTopic;
    });
    if (!indexed) throw new HttpsError('failed-precondition', `Question ${mark.questionReference} does not belong to ${topic}.`);
    if (mark.paperId && indexed.paperId && String(indexed.paperId) !== mark.paperId) {
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

const questionLinksWithTopics = ({ questionLinks = [], topicBreakdown = [], questions = [] }) => {
  const links = Array.isArray(questionLinks) && questionLinks.length
    ? questionLinks
    : Array.isArray(topicBreakdown) && topicBreakdown.length
      ? topicBreakdown
      : Array.isArray(questions) ? questions : [];
  return links.map((link) => {
    const reference = String(link?.questionReference || link?.reference || '').trim().toLocaleLowerCase();
    const paperId = String(link?.paperId || '').trim();
    const breakdown = (Array.isArray(topicBreakdown) ? topicBreakdown : []).find((item) =>
      String(item?.questionReference || item?.reference || '').trim().toLocaleLowerCase() === reference
      && (!paperId || !item?.paperId || paperId === String(item.paperId).trim()));
    return {
      ...link,
      topic: link?.topic || breakdown?.topic || '',
      topicId: link?.topicId || link?.canonicalTopicKey || breakdown?.topicId || breakdown?.canonicalTopicKey || '',
    };
  });
};

const resolveTopicDocument = async (transaction, episodeRef, { topic, topicId = '' }) => {
  const topicName = String(topic ?? '').trim();
  const normalizedName = normalizeTopicKey(topicName);
  const requestedId = String(topicId ?? '').trim();
  const candidateIds = [...new Set([requestedId, normalizedName].filter((value) => value && !value.includes('/')))];
  for (const candidateId of candidateIds) {
    const topicRef = episodeRef.collection('topics').doc(candidateId);
    const snapshot = await transaction.get(topicRef);
    if (!snapshot.exists) continue;
    const data = snapshot.data();
    const storedIdentity = [data.topicName, data.canonicalTopicKey]
      .filter(Boolean)
      .map(normalizeTopicKey);
    const idMatchesName = normalizeTopicKey(snapshot.id) === normalizedName;
    const requestedIdHasNoStoredName = candidateId === requestedId && !storedIdentity.length;
    if (!normalizedName || idMatchesName || storedIdentity.includes(normalizedName) || requestedIdHasNoStoredName) {
      return { topicRef, topicSnapshot: snapshot, canonicalTopicKey: topicRef.id };
    }
  }

  if (normalizedName) {
    const topics = await transaction.get(episodeRef.collection('topics'));
    const matching = topics.docs.find((item) => {
      const data = item.data();
      return [data.canonicalTopicKey, data.topicName, item.id]
        .some((value) => normalizeTopicKey(value) === normalizedName);
    });
    if (matching) return { topicRef: matching.ref, topicSnapshot: matching, canonicalTopicKey: matching.id };
  }

  const topicRef = episodeRef.collection('topics').doc(normalizedName);
  return { topicRef, topicSnapshot: null, canonicalTopicKey: normalizedName };
};

const matchingScoreRecords = ({ sourceScoreSnapshot, sourceType, sourceId, questionMark }) => sourceScoreSnapshot.docs.filter((item) => {
  const data = item.data();
  const recordSourceId = String(data.sourceId || data.exerciseId || data.peerAssignmentId || '');
  const sameReference = String(data.questionReference || '').trim().toLocaleLowerCase()
    === String(questionMark.questionReference || '').trim().toLocaleLowerCase();
  const recordPaperId = String(data.paperId || '').trim();
  const questionPaperId = String(questionMark.paperId || '').trim();
  return data.sourceType === sourceType && recordSourceId === sourceId && sameReference
    && (!recordPaperId || !questionPaperId || recordPaperId === questionPaperId);
});

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

  const indexedAssignmentQuestions = questionLinksWithTopics(assignment);
  const indexedAssignmentTopicNames = indexedAssignmentQuestions.map((question) => question.topic).filter(Boolean);
  const assignmentTopics = [...new Map((indexedAssignmentTopicNames.length ? indexedAssignmentTopicNames : getExerciseTopicNames(assignment))
    .map((name) => String(name ?? '').trim()).filter(Boolean).map((name) => [normalizeTopicKey(name), name])).values()];
  const scoreEntryMap = new Map();
  topicMarks.forEach((item) => {
    const topicName = String(item?.topic || '').trim();
    const topicId = String(item?.topicId || '').trim();
    const canonicalTopicKey = normalizeTopicKey(topicName);
    if (!canonicalTopicKey || !assignmentTopics.some((topic) => normalizeTopicKey(topic) === canonicalTopicKey)) {
      throw new HttpsError('invalid-argument', `Topic ${topicName || '(empty)'} is not part of this marking assignment.`);
    }
    const questionMarks = normalizeQuestionMarks(item.questionMarks, `${topicName} question marks`);
    ensureQuestionMarksBelongToIndexedQuestions({
      questionMarks,
      indexedQuestions: indexedAssignmentQuestions,
      topic: topicName,
      topicId,
    });
    const existingEntry = scoreEntryMap.get(canonicalTopicKey);
    if (existingEntry) {
      const byQuestion = new Map(existingEntry.questionMarks.map((mark) => [`${mark.paperId}::${mark.questionReference}`, mark]));
      questionMarks.forEach((mark) => byQuestion.set(`${mark.paperId}::${mark.questionReference}`, mark));
      existingEntry.questionMarks = [...byQuestion.values()];
    } else {
      scoreEntryMap.set(canonicalTopicKey, { topicName, topicId, canonicalTopicKey, questionMarks });
    }
  });
  const scoreEntries = [...scoreEntryMap.values()].map((entry) => ({
    ...entry,
    score: scoreFromQuestionMarks(entry.questionMarks),
  }));
  const now = admin.firestore.Timestamp.now();
  let scoreResults = [];
  let isFullyReviewed = false;
  await db.runTransaction(async (transaction) => {
    const topicResolutions = await Promise.all(scoreEntries.map((entry) => resolveTopicDocument(transaction, episodeRef, entry)));
    const [currentAssignment, currentEpisode, ...topicReads] = await Promise.all([
      transaction.get(assignmentSnapshot.ref),
      transaction.get(episodeRef),
      ...topicResolutions.map(({ topicRef }) => Promise.all([
        transaction.get(topicRef),
        transaction.get(recentTopicScoresQuery(topicRef, now)),
        transaction.get(topicRef.collection('understandingScores').where('sourceId', '==', peerAssignmentId)),
      ])),
    ]);
    const current = currentAssignment.data();
    if (current.status !== 'completed' || current.reviewerId !== studentId) {
      throw new HttpsError('failed-precondition', 'The peer-marking assignment is no longer available.');
    }
    requireEpisodeAccess({ episode: currentEpisode.data(), uid, isAdmin: actor.role === 'admin' });
    scoreResults = scoreEntries.map((entry, index) => {
      const [topicSnapshot, recentScores, sourceScores] = topicReads[index];
      const { topicRef, canonicalTopicKey } = topicResolutions[index];
      const replacedIds = new Set();
      const questionScores = entry.questionMarks.map((mark) => {
        const matches = matchingScoreRecords({ sourceScoreSnapshot: sourceScores, sourceType: 'Marking', sourceId: peerAssignmentId, questionMark: mark });
        const stableRef = questionScoreRef({ topicRef, sourceType: 'Marking', sourceId: peerAssignmentId, questionReference: mark.questionReference, paperId: mark.paperId });
        const existing = matches.find((item) => item.id === stableRef.id) || matches
          .sort((left, right) => (right.data().createdAt?.toMillis?.() ?? 0) - (left.data().createdAt?.toMillis?.() ?? 0))[0];
        const scoreRef = existing?.ref || stableRef;
        matches.forEach((item) => {
          replacedIds.add(item.id);
          if (item.ref.path !== scoreRef.path) transaction.delete(item.ref);
        });
        const score = scoreForQuestion(mark);
        transaction.set(scoreRef, {
          sourceType: 'Marking', sourceId: peerAssignmentId, peerAssignmentId,
          exerciseId: assignment.exerciseId ?? assignment.markedExerciseId ?? null,
          scoreEventId,
          questionReference: mark.questionReference, paperId: mark.paperId, pageNumber: mark.pageNumber,
          earnedMarks: mark.earnedMarks, totalMarks: mark.totalMarks,
          score, scoreScale: 'ratio-0-to-1', tutorId: uid,
          notes: `Tutor evaluation of peer marking ${peerAssignmentId} for exercise ${assignment.exerciseId ?? 'unknown'}; question ${mark.questionReference}`,
          createdAt: now, updatedAt: now,
        }, { merge: true });
        return { questionReference: mark.questionReference, paperId: mark.paperId, pageNumber: mark.pageNumber, score, earnedMarks: mark.earnedMarks, totalMarks: mark.totalMarks };
      });
      const effectiveRecentScores = recentScores.docs
        .filter((item) => !replacedIds.has(item.id))
        .map((item) => ({ data: () => item.data() }));
      effectiveRecentScores.push(...questionScores.map((item) => ({ data: () => ({ ...item, scoreScale: 'ratio-0-to-1', createdAt: now }) })));
      const rollup = makeTopicRollup({ docs: effectiveRecentScores }, now);
      transaction.set(topicRef, {
        ...(!topicSnapshot.exists ? {
          canonicalTopicKey,
          topicName: entry.topicName,
          topicStatus: 'marked',
          attendanceStatus: 'not-attended',
          firstMarkedAt: now,
          createdAt: now,
        } : {}),
        ...rollup,
        tutorReport: 'Tutor evaluation of peer marking', updatedAt: now,
      }, { merge: true });
      return { topic: entry.topicName, understandingLevel: entry.score, averageUnderstandingLevel: rollup.understandingLevel, questionScores };
    });

    const mergedTopicScores = Array.isArray(current.tutorTopicScores) ? [...current.tutorTopicScores] : [];
    scoreResults.forEach((result) => {
      const key = normalizeTopicKey(result.topic);
      const index = mergedTopicScores.findIndex((item) => normalizeTopicKey(item.topic) === key);
      const prior = index >= 0 ? mergedTopicScores[index] : {};
      const questionsByKey = new Map((prior.questionScores ?? []).map((item) => [`${String(item.paperId || '')}::${String(item.questionReference || '').toLocaleLowerCase()}`, item]));
      result.questionScores.forEach((item) => questionsByKey.set(`${String(item.paperId || '')}::${String(item.questionReference || '').toLocaleLowerCase()}`, item));
      const questionScores = [...questionsByKey.values()];
      const topicResult = {
        ...prior,
        topic: result.topic,
        understandingLevel: scoreFromQuestionMarks(questionScores.map((item) => ({ earnedMarks: item.earnedMarks, totalMarks: item.totalMarks }))),
        averageUnderstandingLevel: result.averageUnderstandingLevel,
        questionScores,
      };
      if (index >= 0) mergedTopicScores[index] = topicResult;
      else mergedTopicScores.push(topicResult);
    });
    const expectedQuestions = questionLinksWithTopics(current);
    const savedQuestionKeys = new Set(mergedTopicScores.flatMap((item) => (item.questionScores ?? []).map((question) =>
      `${normalizeTopicKey(item.topic)}::${String(question.paperId || '')}::${String(question.questionReference || '').toLocaleLowerCase()}`)));
    isFullyReviewed = expectedQuestions.length
      ? expectedQuestions.every((question) => savedQuestionKeys.has(`${normalizeTopicKey(question.topic)}::${String(question.paperId || '')}::${String(question.questionReference || '').toLocaleLowerCase()}`))
      : assignmentTopics.every((topic) => mergedTopicScores.some((item) => normalizeTopicKey(item.topic) === normalizeTopicKey(topic)));
    transaction.update(assignmentSnapshot.ref, {
      ...(isFullyReviewed ? { tutorReviewStatus: 'reviewed', tutorReviewed: true, tutorReviewedBy: uid, tutorReviewedAt: now } : {}),
      tutorTopicScores: mergedTopicScores,
      tutorUnderstandingLevel: mergedTopicScores.length ? mergedTopicScores.reduce((total, item) => total + Number(item.understandingLevel || 0), 0) / mergedTopicScores.length : null,
      tutorReviewTopic: assignmentTopics.join(' | '), updatedAt: now,
    });
  });
  return { peerAssignmentId, topicScores: scoreResults, reviewed: isFullyReviewed };
});

export const saveTutorExerciseScore = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = request.auth?.uid;
  const { studentId, subjectInstanceId, exerciseId, subject, topic, topicId = '', scoreEventId, questionMarks } = request.data ?? {};
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
  const now = admin.firestore.Timestamp.now();
  let average = null;
  await db.runTransaction(async (transaction) => {
    const topicResolution = await resolveTopicDocument(transaction, episodeRef, { topic, topicId });
    const { topicRef } = topicResolution;
    const [currentEpisode, exerciseSnapshot, topicSnapshot, recentScores, sourceScores] = await Promise.all([
      transaction.get(episodeRef),
      transaction.get(exerciseRef),
      transaction.get(topicRef),
      transaction.get(recentTopicScoresQuery(topicRef, now)),
      transaction.get(topicRef.collection('understandingScores').where('sourceId', '==', exerciseId)),
    ]);
    requireEpisodeAccess({ episode: currentEpisode.data(), uid, isAdmin: actor.role === 'admin' });
    if (normalizeSubject(currentEpisode.data()?.subjectKey) !== normalizeSubject(subject)) {
      throw new HttpsError('failed-precondition', 'The exercise subject does not match the student subject episode.');
    }
    if (!exerciseSnapshot.exists) throw new HttpsError('not-found', 'Exercise not found.');
    const exercise = exerciseSnapshot.data();
    if (exercise.studentId && exercise.studentId !== studentId) throw new HttpsError('permission-denied', 'This exercise belongs to another student.');
    if (normalizeSubject(exercise.subject) !== normalizeSubject(subject)) throw new HttpsError('failed-precondition', 'The exercise subject does not match.');
    const submitted = Boolean(exercise.submittedImageUrl || exercise.submittedAt
      || exercise.submissionStatus === 'submitted' || exercise.submissionStatus === 'graded'
      || exercise.submitted === 'Yes'
      || (Array.isArray(exercise.submittedImages) && exercise.submittedImages.length));
    if (!submitted) throw new HttpsError('failed-precondition', 'A tutor can score an exercise only after the student submits handwritten work.');
    const indexedExerciseQuestions = questionLinksWithTopics(exercise);
    const indexedExerciseTopicNames = indexedExerciseQuestions.map((question) => question.topic).filter(Boolean);
    const exerciseTopics = [...new Set((indexedExerciseTopicNames.length ? indexedExerciseTopicNames : getExerciseTopicNames(exercise))
      .map(normalizeTopicKey).filter(Boolean))];
    const questionHasTopicId = topicId && indexedExerciseQuestions.some((item) =>
      String(item.topicId || item.canonicalTopicKey || '') === topicId
      && normalizedQuestionMarks.some((mark) => String(item.questionReference || item.reference || '').trim() === mark.questionReference));
    if (exerciseTopics.length && !exerciseTopics.includes(canonicalTopicKey) && !questionHasTopicId) {
      throw new HttpsError('failed-precondition', 'The selected topic is not part of this exercise.');
    }
    ensureQuestionMarksBelongToIndexedQuestions({
      questionMarks: normalizedQuestionMarks,
      indexedQuestions: indexedExerciseQuestions,
      topic,
      topicId,
    });
    if (!topicSnapshot.exists) throw new HttpsError('failed-precondition', 'Complete a lesson on this topic before recording an exercise score.');

    const replacedIds = new Set();
    const questionScores = normalizedQuestionMarks.map((mark) => {
      const matches = matchingScoreRecords({ sourceScoreSnapshot: sourceScores, sourceType: 'Exercise', sourceId: exerciseId, questionMark: mark });
      const stableRef = questionScoreRef({ topicRef, sourceType: 'Exercise', sourceId: exerciseId, questionReference: mark.questionReference, paperId: mark.paperId });
      const existing = matches.find((item) => item.id === stableRef.id) || matches
        .sort((left, right) => (right.data().createdAt?.toMillis?.() ?? 0) - (left.data().createdAt?.toMillis?.() ?? 0))[0];
      const scoreRef = existing?.ref || stableRef;
      matches.forEach((item) => {
        replacedIds.add(item.id);
        if (item.ref.path !== scoreRef.path) transaction.delete(item.ref);
      });
      const questionScore = scoreForQuestion(mark);
      transaction.set(scoreRef, {
        sourceType: 'Exercise', sourceId: exerciseId, exerciseId, scoreEventId,
        questionReference: mark.questionReference, paperId: mark.paperId, pageNumber: mark.pageNumber,
        earnedMarks: mark.earnedMarks, totalMarks: mark.totalMarks,
        score: questionScore, scoreScale: 'ratio-0-to-1', tutorId: uid,
        notes: `Tutor mark for exercise ${exerciseId} (${exercise.title || 'Exercise'}); question ${mark.questionReference}`,
        createdAt: now, updatedAt: now,
      }, { merge: true });
      return { ...mark, score: questionScore };
    });

    const effectiveRecentScores = recentScores.docs
      .filter((item) => !replacedIds.has(item.id))
      .map((item) => ({ data: () => item.data() }));
    effectiveRecentScores.push(...questionScores.map((item) => ({ data: () => ({ ...item, scoreScale: 'ratio-0-to-1', createdAt: now }) })));
    const rollup = makeTopicRollup({ docs: effectiveRecentScores }, now);
    average = rollup.understandingLevel;
    transaction.update(topicRef, {
      ...rollup,
      tutorReport: `Tutor mark for exercise: ${exercise.title || 'Exercise'}`, updatedAt: now,
    });
    transaction.update(exerciseRef, {
      updatedAt: now,
    });
  });
  return { topic: String(topic).trim(), understandingLevel: average, averageUnderstandingLevel: average, exerciseId, score, questionScores: normalizedQuestionMarks.map((item) => ({ ...item, score: scoreForQuestion(item) })) };
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

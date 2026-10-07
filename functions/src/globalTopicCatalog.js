import { FieldPath } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { getDb } from './admin.js';

const MAX_CATALOG_GROUPS = 1000;
const PAPER_PAGE_SIZE = 250;
const MAPPING_PAGE_SIZE = 250;
const MIGRATION_COLLECTION = 'settings';
const MIGRATION_DOCUMENT = 'globalTopicCatalogMigration';

const normalizeTopicKey = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9|]+/g, ' ')
  .replace(/\s*\|\s*/g, ' | ')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeTopicDifficulty = (value) => {
  const difficulty = String(value ?? '').trim().toLowerCase();
  if (['easy', 'basic'].includes(difficulty)) return 'easy';
  if (['medium', 'moderate', 'average'].includes(difficulty)) return 'medium';
  if (['hard', 'difficult', 'challenging'].includes(difficulty)) return 'hard';
  return '';
};

const topicParts = (value) => {
  const parts = String(value ?? '').split('|').map((part) => normalizeTopicKey(part)).filter(Boolean);
  return parts.length === 2 ? parts : [normalizeTopicKey(value)].filter(Boolean);
};

const topicLabelsMatch = (left, right) => {
  const leftParts = topicParts(left);
  const rightParts = topicParts(right);
  if (!leftParts.length || !rightParts.length) return false;
  if (leftParts.length === 2 && rightParts.length === 2) return leftParts[0] === rightParts[0] && leftParts[1] === rightParts[1];
  if (leftParts.length === 2) return rightParts[0] === leftParts[0];
  if (rightParts.length === 2) return leftParts[0] === rightParts[0];
  return leftParts[0] === rightParts[0];
};

export const normalizeStoredTopicLabel = (value) => {
  const parts = String(value ?? '').split('|').map((part) => part.trim().replace(/\s+/g, ' '));
  if (parts.length !== 2 || parts.some((part) => !part) || parts.join(' | ').length > 180) return '';
  return `${parts[0]} | ${parts[1]}`;
};

export const normalizeGeneratedTopicLabel = (value) => {
  const normalized = normalizeStoredTopicLabel(value);
  if (!normalized) return '';
  const parts = normalized.split('|').map((part) => part.trim());
  if (parts.some((part) => part.split(/\s+/).length > 3 || /[.!?;,:]/.test(part))) return '';
  return normalized;
};

const expandLegacyTopicLabel = (value) => {
  const label = normalizeStoredTopicLabel(value);
  if (!label) return [];
  const normalized = normalizeTopicKey(label);
  const combinedNumberTopic = normalizeTopicKey('Fractions, decimals and percentages | Numbers, Operations and Relationships');
  if (normalized === combinedNumberTopic) {
    return [
      'Fractions | Fraction Concepts',
      'Decimals | Decimal Concepts',
      'Percentages | Percentage Concepts',
    ];
  }
  return [label];
};

const uniqueTopicLabels = (values = []) => {
  const labels = new Map();
  values.flatMap(expandLegacyTopicLabel).forEach((label) => {
    const key = normalizeTopicKey(label);
    if (key && !labels.has(key)) labels.set(key, label);
  });
  return [...labels.values()];
};

export const mergeGlobalTopicLabels = async (db, subject, grade, labels, { ensureSubject = true, topicMetadata = [] } = {}) => {
  const subjectName = String(subject ?? '').trim();
  const gradeName = String(grade ?? '').trim();
  if (!subjectName || !gradeName || subjectName.includes('/') || gradeName.includes('/')) return { topics: [], addedCount: 0 };

  const subjectRef = db.collection('subjects').doc(subjectName);
  const gradeRef = subjectRef.collection('grades').doc(gradeName);
  if (ensureSubject) {
    await subjectRef.set({ subjectName, updatedAt: new Date() }, { merge: true });
  }

  return db.runTransaction(async (transaction) => {
    const gradeSnapshot = await transaction.get(gradeRef);
    const current = uniqueTopicLabels(gradeSnapshot.data()?.topics);
    const merged = uniqueTopicLabels([...current, ...(Array.isArray(labels) ? labels : [])]);
    const currentKeys = new Set(current.map(normalizeTopicKey));
    const addedCount = merged.filter((label) => !currentKeys.has(normalizeTopicKey(label))).length;
    const metadataByTopic = new Map();
    [...(Array.isArray(gradeSnapshot.data()?.topicMetadata) ? gradeSnapshot.data().topicMetadata : []),
      ...(Array.isArray(topicMetadata) ? topicMetadata : [])].forEach((item) => {
      const topic = normalizeStoredTopicLabel(item?.topic ?? item?.label);
      const difficulty = normalizeTopicDifficulty(item?.difficulty);
      const key = normalizeTopicKey(topic);
      if (topic && difficulty && !metadataByTopic.has(key)) metadataByTopic.set(key, { topic, difficulty });
    });
    const savedTopicMetadata = merged.flatMap((topic) => {
      const metadata = metadataByTopic.get(normalizeTopicKey(topic));
      return metadata ? [{ topic, difficulty: metadata.difficulty }] : [];
    });
    transaction.set(gradeRef, {
      subjectName,
      gradeName,
      topics: merged,
      ...(savedTopicMetadata.length || Array.isArray(gradeSnapshot.data()?.topicMetadata) ? { topicMetadata: savedTopicMetadata } : {}),
      updatedAt: new Date(),
    }, { merge: true });
    return { topics: merged, addedCount };
  });
};

export const ensureGlobalTopicGrade = onCall({ timeoutSeconds: 120, memory: '256MiB' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before loading subject topics.');
  const db = getDb();
  const actorSnapshot = await db.collection('users').doc(uid).get();
  const role = actorSnapshot.data()?.role;
  if (!actorSnapshot.exists || !['admin', 'tutor', 'teacher'].includes(role)) {
    throw new HttpsError('permission-denied', 'Only an admin or assigned tutor can initialize subject topics.');
  }

  const subject = String(request.data?.subject ?? '').trim().slice(0, 100);
  const grade = String(request.data?.grade ?? '').trim().slice(0, 32);
  if (!subject || !grade || subject.includes('/') || grade.includes('/')) {
    throw new HttpsError('invalid-argument', 'Provide a valid subject and grade.');
  }

  const seedTopics = asTopicLabels(request.data?.seedTopics);
  const seedTopicMetadata = (Array.isArray(request.data?.seedTopicMetadata) ? request.data.seedTopicMetadata : [])
    .map((item) => ({
      topic: normalizeStoredTopicLabel(item?.topic ?? item?.label),
      difficulty: normalizeTopicDifficulty(item?.difficulty),
    }))
    .filter((item) => item.topic && item.difficulty);
  if (role !== 'admin') {
    const studentIds = [...new Set((Array.isArray(request.data?.studentIds) ? request.data.studentIds : [])
      .map((studentId) => String(studentId ?? '').trim())
      .filter(Boolean))].slice(0, 30);
    let hasTeachingAccess = false;
    for (const studentId of studentIds) {
      const studentRef = db.collection('users').doc(studentId);
      const [studentSnapshot, episodeSnapshot] = await Promise.all([
        studentRef.get(),
        studentRef.collection('subjects').get(),
      ]);
      if (!studentSnapshot.exists || studentSnapshot.data()?.role !== 'student') continue;
      hasTeachingAccess = episodeSnapshot.docs.some((episodeDocument) => {
        const episode = episodeDocument.data();
        return episode.status === 'active'
          && episode.subjectKey === subject
          && episode.grade === grade
          && (episode.primaryTutorId === uid || episode.staffByUid?.[uid] === 'co-owner');
      });
      if (hasTeachingAccess) break;
    }
    if (!hasTeachingAccess) throw new HttpsError('permission-denied', 'An active tutor assignment is required to initialize this subject and grade.');
  }

  const subjectRef = db.collection('subjects').doc(subject);
  const gradeRef = subjectRef.collection('grades').doc(grade);
  const existing = await gradeRef.get();
  const existingTopics = uniqueTopicLabels(existing.data()?.topics);
  if (existingTopics.length) return { topics: existingTopics, created: false };
  const merged = await mergeGlobalTopicLabels(db, subject, grade, seedTopics, { topicMetadata: seedTopicMetadata });
  return { topics: merged.topics, created: !existing.exists };
});

const addGroupTopics = (groups, subject, grade, labels, topicMetadata = []) => {
  const subjectName = String(subject ?? '').trim();
  const gradeName = String(grade ?? '').trim();
  if (!subjectName || !gradeName || subjectName.includes('/') || gradeName.includes('/')) return;
  const key = `${subjectName}\u0000${gradeName}`;
  const group = groups.get(key) ?? { subject: subjectName, grade: gradeName, topics: new Map(), topicMetadata: new Map() };
  uniqueTopicLabels(labels).forEach((label) => {
    const normalized = normalizeTopicKey(label);
    if (!group.topics.has(normalized)) group.topics.set(normalized, label);
  });
  (Array.isArray(topicMetadata) ? topicMetadata : []).forEach((item) => {
    const topic = normalizeStoredTopicLabel(item?.topic ?? item?.label);
    const difficulty = normalizeTopicDifficulty(item?.difficulty);
    const normalized = normalizeTopicKey(topic);
    if (topic && difficulty && !group.topicMetadata.has(normalized)) group.topicMetadata.set(normalized, { topic, difficulty });
  });
  groups.set(key, group);
};

const asTopicLabels = (value) => (Array.isArray(value) ? value : [value])
  .map((item) => typeof item === 'string' ? item : item?.canonicalLabel ?? item?.topic ?? item?.name ?? item?.label ?? '')
  .flatMap(expandLegacyTopicLabel);

const verifyAdmin = async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in as an admin to initialize the global topic catalog.');
  const actorSnapshot = await getDb().collection('users').doc(uid).get();
  if (!actorSnapshot.exists || actorSnapshot.data()?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only admins can initialize the global topic catalog.');
  }
};

const preferredDifficulty = (values = []) => {
  const counts = new Map();
  values.map(normalizeTopicDifficulty).filter(Boolean).forEach((difficulty) => {
    counts.set(difficulty, (counts.get(difficulty) ?? 0) + 1);
  });
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] === 'medium' ? -1 : right[0] === 'medium' ? 1 : left[0].localeCompare(right[0])))[0]?.[0] ?? '';
};

const paperQuestionsForTopic = (paper, topic) => (Array.isArray(paper?.questions) ? paper.questions : []).filter((question) => {
  const labels = [question?.topic, ...(Array.isArray(question?.topics) ? question.topics : [])];
  return labels.some((label) => topicLabelsMatch(topic, label));
});

const analyzedDifficultyForTopic = (papers, topic) => {
  const values = [];
  papers.forEach((paper) => {
    (Array.isArray(paper.topicMetadata) ? paper.topicMetadata : []).forEach((item) => {
      if (topicLabelsMatch(topic, item?.topic ?? item?.label)) values.push(item?.difficulty);
    });
    paperQuestionsForTopic(paper, topic).forEach((question) => {
      values.push(question?.difficulty, question?.metadata?.difficulty);
    });
  });
  return preferredDifficulty(values);
};

export const cleanupGlobalTopicCatalog = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
  await verifyAdmin(request);
  const subject = String(request.data?.subject ?? '').trim().slice(0, 100);
  const grade = String(request.data?.grade ?? '').trim().slice(0, 32);
  const action = String(request.data?.action ?? '').trim();
  if (!subject || !grade || subject.includes('/') || grade.includes('/')) {
    throw new HttpsError('invalid-argument', 'Provide a valid subject and grade.');
  }
  if (!['remove-listed', 'reconcile-grade'].includes(action)) {
    throw new HttpsError('invalid-argument', 'Choose a supported topic catalog cleanup action.');
  }

  const db = getDb();
  const gradeRef = db.collection('subjects').doc(subject).collection('grades').doc(grade);
  const [gradeSnapshot, paperSnapshot] = await Promise.all([
    gradeRef.get(),
    db.collection('questionPapers').where('subject', '==', subject).get(),
  ]);
  const gradeData = gradeSnapshot.data() ?? {};
  const currentTopics = uniqueTopicLabels(gradeData.topics);
  const papers = paperSnapshot.docs.map((paperDocument) => paperDocument.data())
    .filter((paper) => paper.grade === grade && paper.analysisStatus === 'Analyzed'
      && paper.availableForGeneration !== false && Array.isArray(paper.questions) && paper.questions.length > 0);
  const requestedLabels = asTopicLabels(request.data?.topics);
  const checkedTopics = action === 'remove-listed'
    ? currentTopics.filter((topic) => requestedLabels.some((requested) => topicLabelsMatch(topic, requested)))
    : currentTopics;
  const metadataByTopic = new Map();
  (Array.isArray(gradeData.topicMetadata) ? gradeData.topicMetadata : []).forEach((item) => {
    const topic = normalizeStoredTopicLabel(item?.topic ?? item?.label);
    const difficulty = normalizeTopicDifficulty(item?.difficulty);
    if (topic && difficulty) metadataByTopic.set(normalizeTopicKey(topic), difficulty);
  });

  const removedKeys = new Set();
  const inferredMetadata = new Map();
  checkedTopics.forEach((topic) => {
    const matchingQuestions = papers.flatMap((paper) => paperQuestionsForTopic(paper, topic));
    if (!matchingQuestions.length) {
      removedKeys.add(normalizeTopicKey(topic));
      return;
    }
    const savedDifficulty = metadataByTopic.get(normalizeTopicKey(topic));
    const analyzedDifficulty = analyzedDifficultyForTopic(papers, topic);
    if (action === 'reconcile-grade' && !savedDifficulty && !analyzedDifficulty) {
      removedKeys.add(normalizeTopicKey(topic));
      return;
    }
    if (!savedDifficulty && analyzedDifficulty) inferredMetadata.set(normalizeTopicKey(topic), { topic, difficulty: analyzedDifficulty });
  });

  const result = await db.runTransaction(async (transaction) => {
    const latestSnapshot = await transaction.get(gradeRef);
    const latest = latestSnapshot.data() ?? {};
    const latestTopics = uniqueTopicLabels(latest.topics);
    const latestTopicKeys = new Set(latestTopics.map(normalizeTopicKey));
    const removedTopics = latestTopics.filter((topic) => removedKeys.has(normalizeTopicKey(topic)));
    const topics = latestTopics.filter((topic) => !removedKeys.has(normalizeTopicKey(topic)));
    const metadata = new Map();
    (Array.isArray(latest.topicMetadata) ? latest.topicMetadata : []).forEach((item) => {
      const topic = normalizeStoredTopicLabel(item?.topic ?? item?.label);
      const difficulty = normalizeTopicDifficulty(item?.difficulty);
      if (topic && difficulty && latestTopicKeys.has(normalizeTopicKey(topic)) && !removedKeys.has(normalizeTopicKey(topic))) {
        metadata.set(normalizeTopicKey(topic), { topic, difficulty });
      }
    });
    inferredMetadata.forEach((item, key) => {
      if (latestTopicKeys.has(key) && !removedKeys.has(key) && !metadata.has(key)) metadata.set(key, item);
    });
    transaction.set(gradeRef, {
      subjectName: subject,
      gradeName: grade,
      topics,
      topicMetadata: [...metadata.values()],
      updatedAt: new Date(),
    }, { merge: true });
    return { removedTopics, remainingTopicCount: topics.length };
  });

  return {
    subject,
    grade,
    action,
    checkedTopicCount: checkedTopics.length,
    analyzedPaperCount: papers.length,
    removedTopics: result.removedTopics,
    remainingTopicCount: result.remainingTopicCount,
    difficultyMetadataUpdatedCount: inferredMetadata.size,
  };
});

export const migrateGlobalTopicCatalog = onCall({ timeoutSeconds: 540, memory: '1GiB', cpu: 1 }, async (request) => {
  await verifyAdmin(request);
  const db = getDb();
  const stateRef = db.collection(MIGRATION_COLLECTION).doc(MIGRATION_DOCUMENT);
  const lockState = await db.runTransaction(async (transaction) => {
    const stateSnapshot = await transaction.get(stateRef);
    const state = stateSnapshot.data() ?? {};
    if (state.status === 'completed') return { completed: true, state };
    if (state.status === 'running' && Date.now() - Number(state.startedAtMs ?? 0) < 15 * 60 * 1000) {
      throw new HttpsError('failed-precondition', 'Global topic catalog initialization is already running.');
    }
    transaction.set(stateRef, { status: 'running', startedAtMs: Date.now(), startedAt: new Date(), updatedAt: new Date() }, { merge: true });
    return { completed: false };
  });
  if (lockState.completed) {
    return { alreadyInitialized: true, groupCount: Number(lockState.state.groupCount ?? 0), topicCount: Number(lockState.state.topicCount ?? 0) };
  }

  try {
    const catalog = Array.isArray(request.data?.catalog) ? request.data.catalog : [];
    if (!catalog.length || catalog.length > MAX_CATALOG_GROUPS) {
      throw new HttpsError('invalid-argument', `Provide 1-${MAX_CATALOG_GROUPS} subject and grade topic groups.`);
    }
    const groups = new Map();
    catalog.forEach((entry) => {
      const subject = String(entry?.subject ?? '').trim();
      const grade = String(entry?.grade ?? '').trim();
      const topics = asTopicLabels(entry?.topics);
      if (!subject || !grade || !topics.length) return;
      addGroupTopics(groups, subject, grade, topics);
    });

    let paperCount = 0;
    let analyzedPaperCount = 0;
    let paperCursor = null;
    while (true) {
      let pageQuery = db.collection('questionPapers')
        .select('subject', 'grade', 'analysisStatus', 'availableForGeneration', 'topics', 'topicMetadata', 'questions')
        .orderBy(FieldPath.documentId())
        .limit(PAPER_PAGE_SIZE);
      if (paperCursor) pageQuery = pageQuery.startAfter(paperCursor);
      const page = await pageQuery.get();
      if (page.empty) break;
      page.docs.forEach((paperDocument) => {
        paperCount += 1;
        const paper = paperDocument.data();
        if (paper.analysisStatus !== 'Analyzed' || paper.availableForGeneration === false) return;
        const labels = [
          ...asTopicLabels(paper.topics),
          ...asTopicLabels(paper.topicMetadata),
          ...(Array.isArray(paper.questions) ? paper.questions.flatMap((question) => [
            ...asTopicLabels(question?.topics),
            ...asTopicLabels(question?.topic),
          ]) : []),
        ];
        if (labels.length) {
          const topicMetadata = [
            ...(Array.isArray(paper.topicMetadata) ? paper.topicMetadata : []),
            ...(Array.isArray(paper.questions) ? paper.questions.flatMap((question) => {
              const topics = Array.isArray(question?.topics) && question.topics.length ? question.topics : [question?.topic];
              return topics.map((topic) => ({ topic, difficulty: question?.difficulty }));
            }) : []),
          ];
          addGroupTopics(groups, paper.subject, paper.grade, labels, topicMetadata);
          analyzedPaperCount += 1;
        }
      });
      paperCursor = page.docs.at(-1);
      if (page.size < PAPER_PAGE_SIZE) break;
    }

    let mappingCursor = null;
    while (true) {
      let pageQuery = db.collection('topicResolverMappings')
        .select('subject', 'grade', 'canonicalTopic')
        .orderBy(FieldPath.documentId())
        .limit(MAPPING_PAGE_SIZE);
      if (mappingCursor) pageQuery = pageQuery.startAfter(mappingCursor);
      const page = await pageQuery.get();
      if (page.empty) break;
      page.docs.forEach((mappingDocument) => {
        const mapping = mappingDocument.data();
        addGroupTopics(groups, mapping.subject, mapping.grade, asTopicLabels(mapping.canonicalTopic));
      });
      mappingCursor = page.docs.at(-1);
      if (page.size < MAPPING_PAGE_SIZE) break;
    }

    const subjects = [...new Set([...groups.values()].map((group) => group.subject))];
    for (let offset = 0; offset < subjects.length; offset += 400) {
      const batch = db.batch();
      subjects.slice(offset, offset + 400).forEach((subjectName) => {
        batch.set(db.collection('subjects').doc(subjectName), { subjectName, updatedAt: new Date() }, { merge: true });
      });
      await batch.commit();
    }

    const groupRows = [...groups.values()];
    for (let offset = 0; offset < groupRows.length; offset += 12) {
      await Promise.all(groupRows.slice(offset, offset + 12).map((group) => mergeGlobalTopicLabels(
        db,
        group.subject,
        group.grade,
        [...group.topics.values()],
        { ensureSubject: false, topicMetadata: [...group.topicMetadata.values()] },
      )));
    }
    const topicCount = groupRows.reduce((count, group) => count + group.topics.size, 0);
    await stateRef.set({
      status: 'completed',
      groupCount: groupRows.length,
      topicCount,
      paperCount,
      analyzedPaperCount,
      completedAt: new Date(),
      updatedAt: new Date(),
    }, { merge: true });
    return { alreadyInitialized: false, groupCount: groupRows.length, topicCount, paperCount, analyzedPaperCount };
  } catch (error) {
    await stateRef.set({ status: 'failed', error: String(error?.message ?? error).slice(0, 500), updatedAt: new Date() }, { merge: true }).catch(() => {});
    throw error;
  }
});

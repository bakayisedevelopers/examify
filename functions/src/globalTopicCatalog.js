import { createHash } from 'node:crypto';
import { FieldPath } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { getDb } from './admin.js';
import { enqueueTaskOnce, stableTaskId } from './taskQueueUtils.js';
import {
  findDrivePastPaperGradeFolder,
  listDrivePastPaperGradeFolders,
  listDriveJsonFilesInGradeFolder,
  summarizeDriveJsonError,
  writeDriveTopicsJson,
} from './googleDrivePaperJson.js';

const MAX_CATALOG_GROUPS = 1000;
const PAPER_PAGE_SIZE = 250;
const MAPPING_PAGE_SIZE = 250;
const MIGRATION_COLLECTION = 'settings';
const MIGRATION_DOCUMENT = 'globalTopicCatalogMigration';
const DRIVE_TOPIC_SYNC_LOCK_PREFIX = 'driveTopicCatalogSync';
const DRIVE_TOPIC_ALL_SYNC_JOBS = 'driveTopicCatalogSyncJobs';
const DRIVE_TOPIC_ALL_SYNC_POINTER = 'driveTopicCatalogAllSync';
const DRIVE_TOPIC_ALL_SYNC_TASK = 'syncAllDriveTopicCatalogsTask';
const DRIVE_TOPIC_ALL_SYNC_TASK_OPTIONS = {
  retryConfig: { maxAttempts: 5, minBackoffSeconds: 10, maxBackoffSeconds: 300, maxDoublings: 4 },
  rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
  timeoutSeconds: 540,
  memory: '1GiB',
};

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

const makeDriveTopicCatalogPlan = async ({ subject, grade, driveFolder: knownDriveFolder = null }) => {
  const db = getDb();
  const gradeRef = db.collection('subjects').doc(subject).collection('grades').doc(grade);
  const [gradeSnapshot, paperSnapshot, discoveredDriveFolder] = await Promise.all([
    gradeRef.get(),
    db.collection('questionPapers').where('subject', '==', subject)
      .select('subject', 'grade', 'analysisStatus', 'availableForGeneration', 'questions', 'topicMetadata', 'analysisCompletedAt')
      .get(),
    knownDriveFolder ? Promise.resolve(knownDriveFolder) : findDrivePastPaperGradeFolder({ subject, grade }),
  ]);
  const driveFolder = discoveredDriveFolder;
  if (!driveFolder) throw new HttpsError('failed-precondition', `No ${grade} folder for ${subject} exists under the configured past-papers Drive root.`);

  const gradeData = gradeSnapshot.data() ?? {};
  const currentTopics = uniqueTopicLabels(gradeData.topics);
  const papers = paperSnapshot.docs.filter((paperDocument) => {
    const paper = paperDocument.data();
    return paper.grade === grade && paper.analysisStatus === 'Analyzed'
      && paper.availableForGeneration !== false && Array.isArray(paper.questions) && paper.questions.length > 0;
  });
  const rows = new Map();
  const addTopic = (value, difficulty) => {
    const topic = normalizeStoredTopicLabel(value);
    const key = normalizeTopicKey(topic);
    if (!topic || !key) return;
    const row = rows.get(key) ?? { topic, difficulties: [] };
    const normalizedDifficulty = normalizeTopicDifficulty(difficulty);
    if (normalizedDifficulty) row.difficulties.push(normalizedDifficulty);
    rows.set(key, row);
  };
  papers.forEach((paperDocument) => {
    const paper = paperDocument.data();
    (Array.isArray(paper.questions) ? paper.questions : []).forEach((question) => {
      const labels = Array.isArray(question?.topics) && question.topics.length ? question.topics : [question?.topic];
      labels.forEach((label) => addTopic(label, question?.difficulty ?? question?.metadata?.difficulty));
    });
  });

  const topics = [...rows.values()].map((row) => row.topic).sort((left, right) => left.localeCompare(right));
  const savedDifficulty = new Map();
  (Array.isArray(gradeData.topicMetadata) ? gradeData.topicMetadata : []).forEach((item) => {
    const topic = normalizeStoredTopicLabel(item?.topic ?? item?.label);
    const difficulty = normalizeTopicDifficulty(item?.difficulty);
    if (topic && difficulty) savedDifficulty.set(normalizeTopicKey(topic), difficulty);
  });
  const topicMetadata = [...rows.entries()].flatMap(([key, row]) => {
    const difficulty = savedDifficulty.get(key) || preferredDifficulty(row.difficulties);
    return difficulty ? [{ topic: row.topic, difficulty }] : [];
  }).sort((left, right) => left.topic.localeCompare(right.topic));
  const nextKeys = new Set(topics.map(normalizeTopicKey));
  const currentKeys = new Set(currentTopics.map(normalizeTopicKey));
  const removedTopics = currentTopics.filter((topic) => !nextKeys.has(normalizeTopicKey(topic)));
  const addedTopics = topics.filter((topic) => !currentKeys.has(normalizeTopicKey(topic)));
  const topicJsonFiles = (await listDriveJsonFilesInGradeFolder(driveFolder.id))
    .filter((file) => String(file.name ?? '').trim().toLocaleLowerCase() === 'topics.json');
  if (topicJsonFiles.length > 1) {
    throw new HttpsError('failed-precondition', 'More than one topics.json file exists in this Drive grade folder. Remove or rename the duplicate files before syncing.');
  }
  const hashInput = {
    subject,
    grade,
    currentTopics: currentTopics.map(normalizeTopicKey).sort(),
    topics: topics.map(normalizeTopicKey).sort(),
    topicMetadata,
    papers: papers.map((paperDocument) => ({
      id: paperDocument.id,
      completedAt: paperDocument.get('analysisCompletedAt')?.toMillis?.() ?? null,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  };
  const previewToken = createHash('sha256').update(JSON.stringify(hashInput)).digest('hex');
  return {
    subject,
    grade,
    gradeRef,
    currentTopics,
    topics,
    topicMetadata,
    removedTopics,
    addedTopics,
    analyzedPaperCount: papers.length,
    driveFolderName: driveFolder.name,
    topicsFileExists: topicJsonFiles.length === 1,
    topicsFileId: topicJsonFiles[0]?.id ?? '',
    previewToken,
  };
};

export const previewDriveTopicCatalogSync = onCall({ timeoutSeconds: 180, memory: '512MiB' }, async (request) => {
  await verifyAdmin(request);
  const subject = String(request.data?.subject ?? '').trim().slice(0, 100);
  const grade = String(request.data?.grade ?? '').trim().slice(0, 32);
  if (!subject || !grade || subject.includes('/') || grade.includes('/')) {
    throw new HttpsError('invalid-argument', 'Provide a valid subject and grade.');
  }
  try {
    const plan = await makeDriveTopicCatalogPlan({ subject, grade });
    return {
      subject,
      grade,
      currentTopicCount: plan.currentTopics.length,
      analyzedTopicCount: plan.topics.length,
      analyzedPaperCount: plan.analyzedPaperCount,
      removedTopics: plan.removedTopics,
      addedTopics: plan.addedTopics,
      topics: plan.topics,
      topicMetadata: plan.topicMetadata,
      driveFolderName: plan.driveFolderName,
      topicsFileExists: plan.topicsFileExists,
      previewToken: plan.previewToken,
    };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('failed-precondition', summarizeDriveJsonError(error));
  }
});

export const syncDriveTopicCatalog = onCall({ timeoutSeconds: 240, memory: '512MiB' }, async (request) => {
  const uid = request.auth?.uid;
  await verifyAdmin(request);
  const subject = String(request.data?.subject ?? '').trim().slice(0, 100);
  const grade = String(request.data?.grade ?? '').trim().slice(0, 32);
  const previewToken = String(request.data?.previewToken ?? '').trim();
  if (!subject || !grade || subject.includes('/') || grade.includes('/') || !previewToken) {
    throw new HttpsError('invalid-argument', 'Choose a subject and grade and review a current topic-sync preview first.');
  }
  const db = getDb();
  const lockId = createHash('sha256').update(`${subject}\u0000${grade}`).digest('hex').slice(0, 32);
  const syncStateRef = db.collection('settings').doc(`${DRIVE_TOPIC_SYNC_LOCK_PREFIX}_${lockId}`);
  const lockOwner = `${uid}_${Date.now()}`;
  const lockAcquired = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(syncStateRef);
    const state = snapshot.data() ?? {};
    const startedAt = state.startedAt?.toMillis?.() ?? 0;
    if (state.status === 'running' && Date.now() - startedAt < 15 * 60 * 1000) return false;
    transaction.set(syncStateRef, { status: 'running', owner: lockOwner, subject, grade, startedAt: new Date(), updatedAt: new Date(), error: '' }, { merge: true });
    return true;
  });
  if (!lockAcquired) throw new HttpsError('failed-precondition', 'A topic sync for this subject and grade is already running.');

  try {
    const plan = await makeDriveTopicCatalogPlan({ subject, grade });
    if (plan.previewToken !== previewToken) {
      throw new HttpsError('failed-precondition', 'Analyzed papers or saved topics changed after the preview. Create a fresh preview before applying the sync.');
    }
    const driveResult = await writeDriveTopicsJson({
      subject,
      grade,
      document: {
        schemaVersion: 1,
        subject,
        grade,
        topics: plan.topics,
        topicMetadata: plan.topicMetadata,
        updatedAt: new Date().toISOString(),
      },
    });
    await db.runTransaction(async (transaction) => {
      const latestSnapshot = await transaction.get(plan.gradeRef);
      const latestTopics = uniqueTopicLabels(latestSnapshot.data()?.topics).map(normalizeTopicKey).sort();
      const expectedTopics = plan.currentTopics.map(normalizeTopicKey).sort();
      if (JSON.stringify(latestTopics) !== JSON.stringify(expectedTopics)) {
        throw new HttpsError('failed-precondition', 'The Firestore topic list changed during sync. The Drive file was written; create a new preview and sync again.');
      }
      transaction.set(plan.gradeRef, {
        subjectName: subject,
        gradeName: grade,
        topics: plan.topics,
        topicMetadata: plan.topicMetadata,
        driveTopicCatalogSyncInitialized: true,
        driveTopicSyncStatus: 'synced',
        driveTopicSyncError: '',
        driveTopicsFileId: driveResult.file?.id ?? '',
        driveTopicsSyncedAt: new Date(),
        updatedAt: new Date(),
      }, { merge: true });
    });
    await syncStateRef.set({ status: 'completed', owner: lockOwner, subject, grade, topicsFileId: driveResult.file?.id ?? '', topicCount: plan.topics.length, removedCount: plan.removedTopics.length, completedAt: new Date(), updatedAt: new Date(), error: '' }, { merge: true });
    return {
      subject,
      grade,
      topicCount: plan.topics.length,
      removedTopics: plan.removedTopics,
      addedTopics: plan.addedTopics,
      analyzedPaperCount: plan.analyzedPaperCount,
      topics: plan.topics,
      topicsFileId: driveResult.file?.id ?? '',
    };
  } catch (error) {
    const message = summarizeDriveJsonError(error);
    await syncStateRef.set({ status: 'failed', owner: lockOwner, subject, grade, error: message, updatedAt: new Date() }, { merge: true }).catch(() => {});
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', `The topic sync did not complete: ${message}`);
  }
});

const topicCatalogPairKey = ({ subject, grade }) => `${normalizeTopicKey(subject)}\u0000${normalizeTopicKey(grade)}`;
const topicCatalogPairDocumentId = ({ subject, grade }) => createHash('sha256')
  .update(topicCatalogPairKey({ subject, grade }))
  .digest('hex')
  .slice(0, 40);
const driveTopicCatalogJobRef = (db, jobId) => db.collection(DRIVE_TOPIC_ALL_SYNC_JOBS).doc(jobId);
const driveTopicCatalogPointerRef = (db) => db.collection(MIGRATION_COLLECTION).doc(DRIVE_TOPIC_ALL_SYNC_POINTER);
const publicDriveTopicCatalogJob = (job, jobId) => ({
  ...Object.fromEntries(Object.entries(job ?? {}).filter(([key]) => key !== 'pairs')),
  jobId,
});
const enqueueDriveTopicCatalogJobTask = (jobId, index) => enqueueTaskOnce(
  DRIVE_TOPIC_ALL_SYNC_TASK,
  { jobId, index },
  { id: stableTaskId('drive-topics', `${jobId}:${index}`) },
);

const collectDriveTopicCatalogPairs = async () => {
  const db = getDb();
  const [subjectsSnapshot, driveFolders] = await Promise.all([
    db.collection('subjects').get(),
    listDrivePastPaperGradeFolders(),
  ]);
  const pairs = new Map();
  const driveFoldersByKey = new Map();
  driveFolders.forEach((folder) => {
    const key = topicCatalogPairKey({ subject: folder.subject, grade: folder.grade });
    const existing = driveFoldersByKey.get(key) ?? [];
    existing.push(folder);
    driveFoldersByKey.set(key, existing);
  });

  for (const subjectSnapshot of subjectsSnapshot.docs) {
    const subject = String(subjectSnapshot.data()?.subjectName ?? subjectSnapshot.id).trim();
    if (!subject || subject.includes('/')) continue;
    const gradesSnapshot = await subjectSnapshot.ref.collection('grades').get();
    gradesSnapshot.docs.forEach((gradeSnapshot) => {
      const grade = String(gradeSnapshot.data()?.gradeName ?? gradeSnapshot.id).trim();
      if (!grade || grade.includes('/')) return;
      const key = topicCatalogPairKey({ subject, grade });
      const matchingDriveFolders = driveFoldersByKey.get(key) ?? [];
      pairs.set(key, {
        subject,
        grade,
        driveFolder: matchingDriveFolders.length === 1 ? matchingDriveFolders[0] : null,
        driveFolderAmbiguous: matchingDriveFolders.length > 1,
      });
    });
  }

  driveFolders.forEach((folder) => {
    const key = topicCatalogPairKey(folder);
    if (!pairs.has(key)) pairs.set(key, { ...folder, driveFolder: folder, driveFolderAmbiguous: false });
  });
  return [...pairs.values()].sort((left, right) =>
    left.subject.localeCompare(right.subject) || left.grade.localeCompare(right.grade));
};

export const startDriveTopicCatalogAllSync = onCall({ timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
  const uid = request.auth?.uid;
  await verifyAdmin(request);
  const db = getDb();
  const pointerRef = driveTopicCatalogPointerRef(db);
  const pointerSnapshot = await pointerRef.get();
  const existingJobId = String(pointerSnapshot.data()?.jobId ?? '');
  if (existingJobId) {
    const existingJob = await driveTopicCatalogJobRef(db, existingJobId).get();
    if (existingJob.data()?.status === 'running') return { ...publicDriveTopicCatalogJob(existingJob.data(), existingJobId), alreadyRunning: true };
  }

  let pairs;
  try {
    pairs = await collectDriveTopicCatalogPairs();
  } catch (error) {
    throw new HttpsError('failed-precondition', summarizeDriveJsonError(error));
  }
  if (!pairs.length) throw new HttpsError('failed-precondition', 'No subject-grade folders were found in Firestore or under the configured Google Drive past-papers root.');
  if (pairs.length > MAX_CATALOG_GROUPS) throw new HttpsError('resource-exhausted', `The topic catalog contains more than ${MAX_CATALOG_GROUPS} subject-grade folders. Split the sync into smaller groups.`);

  const jobId = `${Date.now()}_${uid}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  const jobRef = driveTopicCatalogJobRef(db, jobId);
  const now = new Date();
  const job = {
    jobId,
    status: 'running',
    startedBy: uid,
    startedAt: now,
    updatedAt: now,
    currentIndex: 0,
    totalCount: pairs.length,
    completedCount: 0,
    failedCount: 0,
    currentSubject: pairs[0].subject,
    currentGrade: pairs[0].grade,
    failures: [],
    pairs,
  };
  const started = await db.runTransaction(async (transaction) => {
    const latestPointer = await transaction.get(pointerRef);
    const latestJobId = String(latestPointer.data()?.jobId ?? '');
    if (latestJobId) {
      const latestJobSnapshot = await transaction.get(driveTopicCatalogJobRef(db, latestJobId));
      if (latestJobSnapshot.data()?.status === 'running') return { jobId: latestJobId, job: latestJobSnapshot.data(), alreadyRunning: true };
    }
    transaction.set(jobRef, job);
    transaction.set(pointerRef, { jobId, status: 'running', updatedAt: now }, { merge: true });
    return { jobId, job, alreadyRunning: false };
  });
  if (started.alreadyRunning) return { ...publicDriveTopicCatalogJob(started.job, started.jobId), alreadyRunning: true };

  try {
    await enqueueDriveTopicCatalogJobTask(jobId, 0);
  } catch (error) {
    const message = summarizeDriveJsonError(error);
    await jobRef.set({ status: 'failed', error: message, completedAt: new Date(), updatedAt: new Date() }, { merge: true });
    await pointerRef.set({ jobId, status: 'failed', updatedAt: new Date() }, { merge: true });
    throw new HttpsError('internal', `The topic sync could not be queued: ${message}`);
  }
  return { ...publicDriveTopicCatalogJob(job, jobId), alreadyRunning: false };
});

export const getDriveTopicCatalogAllSyncStatus = onCall(async (request) => {
  await verifyAdmin(request);
  const db = getDb();
  const requestedJobId = String(request.data?.jobId ?? '').trim();
  let jobId = requestedJobId;
  if (!jobId) {
    const pointer = await driveTopicCatalogPointerRef(db).get();
    jobId = String(pointer.data()?.jobId ?? '');
  }
  if (!jobId) return { status: 'not_started', jobId: '' };
  const snapshot = await driveTopicCatalogJobRef(db, jobId).get();
  if (!snapshot.exists) return { status: 'not_found', jobId };
  return publicDriveTopicCatalogJob(snapshot.data(), jobId);
});

export const syncAllDriveTopicCatalogsTask = onTaskDispatched(DRIVE_TOPIC_ALL_SYNC_TASK_OPTIONS, async (request) => {
  const jobId = String(request.data?.jobId ?? '').trim();
  const taskIndex = Math.max(0, Math.floor(Number(request.data?.index) || 0));
  if (!jobId) throw new Error('jobId is required.');
  const db = getDb();
  const jobRef = driveTopicCatalogJobRef(db, jobId);
  try {
    const jobSnapshot = await jobRef.get();
    if (!jobSnapshot.exists || jobSnapshot.data()?.status !== 'running') return;
    const job = jobSnapshot.data();
    const currentIndex = Math.max(0, Number(job.currentIndex) || 0);
    if (taskIndex < currentIndex) {
      await enqueueDriveTopicCatalogJobTask(jobId, currentIndex);
      return;
    }
    if (taskIndex > currentIndex) return;
    const pair = job.pairs?.[currentIndex];
    if (!pair) {
      const status = Number(job.failedCount) > 0 ? 'completed_with_errors' : 'completed';
      await jobRef.set({ status, completedAt: new Date(), updatedAt: new Date() }, { merge: true });
      await driveTopicCatalogPointerRef(db).set({ jobId, status, updatedAt: new Date() }, { merge: true });
      return;
    }

    const pairId = topicCatalogPairDocumentId(pair);
    const gradeResultRef = jobRef.collection('grades').doc(pairId);
    let result = (await gradeResultRef.get()).data();
    if (!['completed', 'failed'].includes(result?.status)) {
    await gradeResultRef.set({ subject: pair.subject, grade: pair.grade, status: 'processing', startedAt: new Date(), updatedAt: new Date(), error: '' }, { merge: true });
    try {
      if (pair.driveFolderAmbiguous) {
        throw new Error(`More than one Drive folder matches ${pair.subject} / ${pair.grade}; rename duplicate subject or grade folders before syncing.`);
      }
      const plan = await makeDriveTopicCatalogPlan({ subject: pair.subject, grade: pair.grade, driveFolder: pair.driveFolder });
      const driveResult = await writeDriveTopicsJson({
        subject: pair.subject,
        grade: pair.grade,
        folder: plan.driveFolder,
        document: {
          schemaVersion: 1,
          subject: pair.subject,
          grade: pair.grade,
          topics: plan.topics,
          topicMetadata: plan.topicMetadata,
          updatedAt: new Date().toISOString(),
        },
      });
      await db.runTransaction(async (transaction) => {
        const latestSnapshot = await transaction.get(plan.gradeRef);
        const latestTopics = uniqueTopicLabels(latestSnapshot.data()?.topics).map(normalizeTopicKey).sort();
        const expectedTopics = plan.currentTopics.map(normalizeTopicKey).sort();
        if (JSON.stringify(latestTopics) !== JSON.stringify(expectedTopics)) {
          throw new Error('The Firestore topic list changed during this grade sync. Run the all-topic sync again to reconcile the latest data.');
        }
        transaction.set(plan.gradeRef, {
          subjectName: pair.subject,
          gradeName: pair.grade,
          topics: plan.topics,
          topicMetadata: plan.topicMetadata,
          driveTopicCatalogSyncInitialized: true,
          driveTopicSyncStatus: 'synced',
          driveTopicSyncError: '',
          driveTopicsFileId: driveResult.file?.id ?? '',
          driveTopicsSyncedAt: new Date(),
          updatedAt: new Date(),
        }, { merge: true });
      });
      result = {
        subject: pair.subject,
        grade: pair.grade,
        status: 'completed',
        topicCount: plan.topics.length,
        removedCount: plan.removedTopics.length,
        analyzedPaperCount: plan.analyzedPaperCount,
        topicsFileId: driveResult.file?.id ?? '',
        updatedAt: new Date(),
      };
      await gradeResultRef.set(result, { merge: true });
    } catch (error) {
      const message = summarizeDriveJsonError(error);
      result = { subject: pair.subject, grade: pair.grade, status: 'failed', error: message, updatedAt: new Date() };
      await gradeResultRef.set(result, { merge: true });
    }
    }

    const nextIndex = currentIndex + 1;
    const nextPair = job.pairs?.[nextIndex];
    let nextStatus = 'running';
    await db.runTransaction(async (transaction) => {
    const latest = await transaction.get(jobRef);
    const latestJob = latest.data();
    if (!latest.exists || latestJob?.status !== 'running' || Number(latestJob.currentIndex) !== currentIndex) return;
    const failedCount = Number(latestJob.failedCount ?? 0) + (result.status === 'failed' ? 1 : 0);
    const completedCount = Number(latestJob.completedCount ?? 0) + (result.status === 'completed' ? 1 : 0);
    const failures = result.status === 'failed'
      ? [...(Array.isArray(latestJob.failures) ? latestJob.failures : []), { subject: pair.subject, grade: pair.grade, error: result.error }].slice(-20)
      : (Array.isArray(latestJob.failures) ? latestJob.failures : []);
    nextStatus = nextPair ? 'running' : failedCount > 0 ? 'completed_with_errors' : 'completed';
    transaction.set(jobRef, {
      currentIndex: nextIndex,
      completedCount,
      failedCount,
      failures,
      currentSubject: nextPair?.subject ?? '',
      currentGrade: nextPair?.grade ?? '',
      status: nextStatus,
      ...(nextPair ? {} : { completedAt: new Date() }),
      updatedAt: new Date(),
    }, { merge: true });
    if (!nextPair) transaction.set(driveTopicCatalogPointerRef(db), { jobId, status: nextStatus, updatedAt: new Date() }, { merge: true });
    });
    if (nextPair) await enqueueDriveTopicCatalogJobTask(jobId, nextIndex);
  } catch (error) {
    if (Number(request.retryCount) >= DRIVE_TOPIC_ALL_SYNC_TASK_OPTIONS.retryConfig.maxAttempts - 1) {
      const message = summarizeDriveJsonError(error);
      await jobRef.set({ status: 'failed', error: message, completedAt: new Date(), updatedAt: new Date() }, { merge: true }).catch(() => {});
      await driveTopicCatalogPointerRef(db).set({ jobId, status: 'failed', updatedAt: new Date() }, { merge: true }).catch(() => {});
    }
    throw error;
  }
});

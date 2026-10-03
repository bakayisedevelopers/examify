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

export const mergeGlobalTopicLabels = async (db, subject, grade, labels, { ensureSubject = true } = {}) => {
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
    transaction.set(gradeRef, {
      subjectName,
      gradeName,
      topics: merged,
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
  const merged = await mergeGlobalTopicLabels(db, subject, grade, seedTopics);
  return { topics: merged.topics, created: !existing.exists };
});

const addGroupTopics = (groups, subject, grade, labels) => {
  const subjectName = String(subject ?? '').trim();
  const gradeName = String(grade ?? '').trim();
  if (!subjectName || !gradeName || subjectName.includes('/') || gradeName.includes('/')) return;
  const key = `${subjectName}\u0000${gradeName}`;
  const group = groups.get(key) ?? { subject: subjectName, grade: gradeName, topics: new Map() };
  uniqueTopicLabels(labels).forEach((label) => {
    const normalized = normalizeTopicKey(label);
    if (!group.topics.has(normalized)) group.topics.set(normalized, label);
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
        .select('subject', 'grade', 'analysisStatus', 'topics', 'questions')
        .orderBy(FieldPath.documentId())
        .limit(PAPER_PAGE_SIZE);
      if (paperCursor) pageQuery = pageQuery.startAfter(paperCursor);
      const page = await pageQuery.get();
      if (page.empty) break;
      page.docs.forEach((paperDocument) => {
        paperCount += 1;
        const paper = paperDocument.data();
        if (paper.analysisStatus !== 'Analyzed') return;
        const labels = [
          ...asTopicLabels(paper.topics),
          ...(Array.isArray(paper.questions) ? paper.questions.flatMap((question) => [
            ...asTopicLabels(question?.topics),
            ...asTopicLabels(question?.topic),
          ]) : []),
        ];
        if (labels.length) {
          addGroupTopics(groups, paper.subject, paper.grade, labels);
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
        { ensureSubject: false },
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

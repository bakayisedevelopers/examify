import { createHash } from 'node:crypto';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { getDb, storage, taskQueue } from './admin.js';
import { mergeGlobalTopicLabels, normalizeGeneratedTopicLabel, normalizeStoredTopicLabel } from './globalTopicCatalog.js';
import { callKiloVisionWithFallback } from './kilo.js';
import { callGeminiGenerateContent } from './gemini.js';
import { enqueueTaskOnce, stableTaskId } from './taskQueueUtils.js';
import {
  downloadDriveJsonFile,
  findDrivePastPaperGradeFolder,
  listDriveJsonFilesInGradeFolder,
  readDriveQuestionPaperAnalysisJson,
  summarizeDriveJsonError,
  writeDriveTopicsJson,
} from './googleDrivePaperJson.js';

const ANALYZING = 'Analyzing';
const ANALYZED = 'Analyzed';
const FAILED = 'Failed';
const WAITING_FOR_DRIVE_JSON = 'Waiting for Drive JSON';
const driveJsonAnalysisOnly = () => String(process.env.QUESTION_PAPER_ANALYSIS_MODE ?? 'drive_json').trim().toLowerCase() !== 'firebase_ai';
const MAX_PAGES_PER_DOCUMENT = 40;
const PAGES_PER_BATCH = 1;
const PDF_RENDER_SCALE = 1.6;
const MAX_STORED_QUESTIONS = 180;
const MAX_TASK_ATTEMPTS = 5;
const GEMINI_BATCH_ATTEMPT = 5;
const RUNS_COLLECTION = 'analysisRuns';
const BATCHES_COLLECTION = 'batches';
const PAPER_QUEUE_COLLECTION = 'questionPaperAnalysisQueue';
const PAPER_QUEUE_STATE_COLLECTION = 'questionPaperAnalysisState';
const PAPER_ANALYSIS_CONTROL_COLLECTION = 'questionPaperAnalysisControl';
const TASK_OPTIONS = {
  retryConfig: { maxAttempts: MAX_TASK_ATTEMPTS, minBackoffSeconds: 10, maxBackoffSeconds: 300, maxDoublings: 4 },
  rateLimits: { maxConcurrentDispatches: 3, maxDispatchesPerSecond: 2 },
  timeoutSeconds: 540,
  memory: '1GiB',
};
const BATCH_TASK_OPTIONS = {
  ...TASK_OPTIONS,
  retryConfig: { maxAttempts: MAX_TASK_ATTEMPTS, minBackoffSeconds: 60, maxBackoffSeconds: 600, maxDoublings: 4 },
  rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
};
const pdfWasmUrl = new URL('../node_modules/pdfjs-dist/wasm/', import.meta.url).href;

const stripCodeFence = (text = '') => String(text)
  .replace(/^```json\s*/i, '')
  .replace(/^```\s*/i, '')
  .replace(/\s*```$/i, '')
  .trim();

const extractJsonObject = (text = '') => {
  const stripped = stripCodeFence(text);
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return stripped;
  return stripped.slice(start, end + 1);
};

const extractJsonArray = (text = '') => {
  const stripped = stripCodeFence(text);
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return stripped;
  return stripped.slice(start, end + 1);
};

const parseJsonCandidate = (candidate = '') => {
  const normalized = String(candidate)
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
};

const parseStructuredAnalysis = (text = '') => {
  const parsed = parseJsonCandidate(extractJsonObject(text));
  return parsed && typeof parsed === 'object' && Array.isArray(parsed.questions) ? parsed : null;
};

const normalizeParsedBatch = (parsed) => {
  if (!parsed) return null;
  if (Array.isArray(parsed)) return { questions: parsed };
  if (Array.isArray(parsed.questions)) return parsed;
  if (Array.isArray(parsed.questionIndex)) return { ...parsed, questions: parsed.questionIndex };
  if (Array.isArray(parsed.items)) return { ...parsed, questions: parsed.items };
  if (Array.isArray(parsed.extractedQuestions)) return { ...parsed, questions: parsed.extractedQuestions };
  if (Array.isArray(parsed.data?.questions)) return { ...parsed.data, summary: parsed.summary ?? parsed.data.summary };
  return null;
};

const inferQuestionsFromText = (text = '') => {
  const lines = String(text)
    .split(/\n|(?=Question\s+\d)|(?=\b\d+\.\d)/i)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 8);
  const seen = new Set();
  const questions = [];

  lines.forEach((line) => {
    if (!/question|\b\d+\.\d/i.test(line)) return;
    const referenceMatch = line.match(/(?:question\s*)?(\d+(?:\.\d+){0,4}(?:\s*\([a-z]\))?)/i);
    if (!referenceMatch) return;
    const questionReference = referenceMatch[1].replace(/\s+/g, '');
    if (seen.has(questionReference)) return;
    seen.add(questionReference);
    const pageMatch = line.match(/\bpage\s*(\d+)/i);
    const marksMatch = line.match(/\b(\d+)\s*marks?\b/i);
    const topicMatch = line.match(/\b(?:topic|skill)\s*[:=-]\s*([^.;]+)/i) || line.match(/\bon\s+([^.;:]+?)(?:\s*[:;-]|\s+\d+\s*marks|\s*$)/i);
    questions.push({
      questionReference,
      parentQuestion: questionReference.split('.')[0],
      topic: topicMatch?.[1]?.trim() || 'Unclassified topic',
      pageNumber: pageMatch ? Number(pageMatch[1]) : 1,
      marks: marksMatch ? Number(marksMatch[1]) : 0,
      section: '',
      instruction: line.slice(0, 700),
      memoSummary: '',
    });
  });

  return questions.slice(0, 60);
};

const parseBatchAnalysis = (text = '') => {
  const raw = String(text ?? '').trim();
  const parsed = normalizeParsedBatch(parseStructuredAnalysis(raw)) ||
    normalizeParsedBatch(parseJsonCandidate(extractJsonObject(raw))) ||
    normalizeParsedBatch(parseJsonCandidate(extractJsonArray(raw)));
  const fallbackQuestions = parsed ? [] : inferQuestionsFromText(raw);
  const fallbackSummary = raw.slice(0, 1200);
  if (!parsed) {
    logger.warn('Vision model returned non-JSON batch output; preserving raw text', {
      textLength: raw.length,
      inferredQuestionCount: fallbackQuestions.length,
      preview: raw.slice(0, 160),
    });
  }
  return {
    questions: parsed?.questions ?? fallbackQuestions,
    topics: Array.isArray(parsed?.topics) ? parsed.topics : [],
    topicMetadata: Array.isArray(parsed?.topicMetadata) ? parsed.topicMetadata : [],
    summary: String(parsed?.summary ?? fallbackSummary).trim(),
    readabilityNotes: Array.isArray(parsed?.readabilityNotes) ? parsed.readabilityNotes : [],
    rawText: String(parsed?.rawText ?? parsed?.extractedText ?? parsed?.summary ?? raw).trim(),
    parseWarning: parsed ? '' : 'Vision model returned non-JSON output; raw text was preserved.',
  };
};

const parseDifficulty = (value) => {
  const difficulty = String(value ?? '').trim().toLowerCase();
  if (['easy', 'basic'].includes(difficulty)) return 'easy';
  if (['medium', 'moderate', 'average'].includes(difficulty)) return 'medium';
  if (['hard', 'difficult', 'challenging'].includes(difficulty)) return 'hard';
  return '';
};

const normalizeDifficulty = (value) => parseDifficulty(value);

const normalizeTopicOption = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9|]+/g, ' ')
  .replace(/\s*\|\s*/g, ' | ')
  .replace(/\s+/g, ' ')
  .trim();

const normalizeSuggestedTopic = (value) => {
  return normalizeGeneratedTopicLabel(value);
};

const sanitizeAnalysisTopicOptions = (value, metadata = []) => {
  const difficultyByTopic = new Map();
  [...(Array.isArray(value) ? value : []), ...(Array.isArray(metadata) ? metadata : [])].forEach((item) => {
    const label = typeof item === 'string' ? item : item?.topic ?? item?.label ?? '';
    const topic = normalizeStoredTopicLabel(label);
    const difficulty = parseDifficulty(typeof item === 'object' ? item?.difficulty : null);
    const key = normalizeTopicOption(topic);
    if (topic && difficulty && !difficultyByTopic.has(key)) difficultyByTopic.set(key, difficulty);
  });
  const seen = new Set();
  return (Array.isArray(value) ? value : []).reduce((topics, value) => {
    const label = typeof value === 'string' ? value : value?.topic ?? value?.label ?? '';
    const topic = normalizeStoredTopicLabel(label);
    const key = normalizeTopicOption(topic);
    if (topic && key && !seen.has(key)) {
      seen.add(key);
      topics.push({ topic, difficulty: difficultyByTopic.get(key) || '' });
    }
    return topics;
  }, []);
};

const constrainTopicList = (values, allowedTopics) => {
  const topics = Array.isArray(values) ? values : [];
  if (!allowedTopics?.length) return [...new Set(topics.map(normalizeSuggestedTopic).filter(Boolean))];
  const allowedByKey = new Map(allowedTopics.map((item) => {
    const topic = typeof item === 'string' ? item : item?.topic;
    return [normalizeTopicOption(topic), topic];
  }));
  return [...new Set(topics
    .map((topic) => allowedByKey.get(normalizeTopicOption(topic)) ?? normalizeSuggestedTopic(topic))
    .filter(Boolean))];
};

const isIntentionallyEmptyPage = (parsed = {}) => {
  if (parsed.parseWarning) return false;
  const summary = String(parsed.summary || parsed.rawText || '').toLowerCase();
  return /no visible questions|no questions|no exam questions|cover page|instruction page|information page|formula sheet/.test(summary);
};

const chunk = (items = [], size = PAGES_PER_BATCH) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const safeId = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120);
const timestampMillis = (value) => value?.toMillis?.() ?? value?.toDate?.().getTime()
  ?? (value ? new Date(value).getTime() : 0);
const runRefFor = (paperId, runId) => getDb().collection('questionPapers').doc(paperId).collection(RUNS_COLLECTION).doc(runId);
const queueTask = (name, data) => taskQueue(name).enqueue(data);
const queueDriveJsonOnlyPrepareTask = ({ paperId, runId }) => enqueueTaskOnce(
  'prepareQuestionPaperAnalysis',
  { paperId, runId },
  { id: stableTaskId('drive-json-prepare', `${paperId}:${runId}`) },
);
const queuePendingInitialGenerationAfterAnalysis = ({ paperId, runId }) => enqueueTaskOnce(
  'queuePendingInitialGenerationAfterPaperAnalysis',
  { paperId, runId },
  { id: stableTaskId('paper-initial-generation', `${paperId}:${runId}`) },
);
const paperQueueRef = () => getDb().collection(PAPER_QUEUE_COLLECTION);
const paperQueueStateRef = () => getDb().collection(PAPER_QUEUE_STATE_COLLECTION).doc('worker');
const paperAnalysisControlRef = () => getDb().collection(PAPER_ANALYSIS_CONTROL_COLLECTION).doc('global');

const requireAnalysisAdmin = async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in as an admin to manage question-paper analysis.');
  const actor = await getDb().collection('users').doc(uid).get();
  if (!actor.exists || actor.data()?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only an admin can manage question-paper analysis.');
  }
  return uid;
};

export const getQuestionPaperAnalysisControl = onCall(async (request) => {
  await requireAnalysisAdmin(request);
  const [controlSnapshot, stateSnapshot] = await Promise.all([
    paperAnalysisControlRef().get(),
    paperQueueStateRef().get(),
  ]);
  return {
    paused: controlSnapshot.data()?.paused === true,
    activePaperId: String(stateSnapshot.data()?.activePaperId ?? ''),
  };
});

export const setQuestionPaperAnalysisPaused = onCall(async (request) => {
  const uid = await requireAnalysisAdmin(request);
  if (typeof request.data?.paused !== 'boolean') {
    throw new HttpsError('invalid-argument', 'paused must be true or false.');
  }
  const paused = request.data.paused;
  const controlRef = paperAnalysisControlRef();
  const timestamp = FieldValue.serverTimestamp();
  await controlRef.set({
    paused,
    ...(paused ? { pausedAt: timestamp, pausedBy: uid } : { resumedAt: timestamp, resumedBy: uid }),
    updatedAt: timestamp,
    updatedBy: uid,
  }, { merge: true });

  if (!paused) await queueTask('dispatchQuestionPaperAnalysis', {});
  const stateSnapshot = await paperQueueStateRef().get();
  logger.info(`Question-paper analysis queue ${paused ? 'paused' : 'resumed'} by admin`, {
    uid,
    activePaperId: stateSnapshot.data()?.activePaperId ?? '',
  });
  return {
    paused,
    activePaperId: String(stateSnapshot.data()?.activePaperId ?? ''),
  };
});

export const queueLegacyDriveJsonAnalyses = onCall({ timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
  const uid = await requireAnalysisAdmin(request);
  const subject = String(request.data?.subject ?? '').trim().slice(0, 100);
  const grade = String(request.data?.grade ?? '').trim().slice(0, 32);
  if (!subject || !grade || subject.includes('/') || grade.includes('/')) {
    throw new HttpsError('invalid-argument', 'Provide a valid subject and grade.');
  }
  const maxPapers = Math.max(1, Math.min(50, Math.floor(Number(request.data?.maxPapers) || 50)));
  const db = getDb();
  const folder = await findDrivePastPaperGradeFolder({ subject, grade });
  if (!folder) throw new HttpsError('failed-precondition', `No ${grade} Drive folder for ${subject} exists under the configured past-papers root.`);
  const jsonFiles = await listDriveJsonFilesInGradeFolder(folder.id);
  const jsonByName = new Map();
  jsonFiles.forEach((file) => {
    const key = String(file.name ?? '').trim().toLocaleLowerCase();
    const matches = jsonByName.get(key) ?? [];
    matches.push(file);
    jsonByName.set(key, matches);
  });
  const [papersSnapshot, gradeSnapshot, controlSnapshot] = await Promise.all([
    db.collection('questionPapers').where('subject', '==', subject).select(
      'subject', 'grade', 'paperUrl', 'paperFileName', 'analysisStatus', 'availableForGeneration',
      'activeAnalysisRunId', 'queuedAnalysisRunId', 'analysisRevision',
    ).get(),
    db.collection('subjects').doc(subject).collection('grades').doc(grade).get(),
    paperAnalysisControlRef().get(),
  ]);
  const topicOptions = sanitizeAnalysisTopicOptions(gradeSnapshot.data()?.topics, gradeSnapshot.data()?.topicMetadata);
  const candidates = papersSnapshot.docs
    .filter((snapshot) => {
      const paper = snapshot.data();
      return paper.grade === grade && paper.paperUrl && paper.analysisStatus !== ANALYZED
        && paper.analysisStatus !== ANALYZING && !paper.activeAnalysisRunId && !paper.queuedAnalysisRunId
        && /\.pdf$/i.test(String(paper.paperFileName ?? ''));
    });
  let checkedCount = 0;
  let queuedCount = 0;
  let reviewCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  let processedCount = 0;

  for (const paperSnapshot of candidates) {
    if (queuedCount >= maxPapers) break;
    processedCount += 1;
    const paper = paperSnapshot.data();
    const jsonName = String(paper.paperFileName).replace(/\.pdf$/i, '.json').toLocaleLowerCase();
    const matchingFiles = jsonByName.get(jsonName) ?? [];
    if (matchingFiles.length > 1) {
      reviewCount += 1;
      await paperSnapshot.ref.set({
        driveAnalysisJsonStatus: 'review_required',
        driveAnalysisJsonReviewReason: `More than one ${jsonName} file exists in the subject and grade Drive folder.`,
        updatedAt: new Date(),
      }, { merge: true });
      continue;
    }
    if (!matchingFiles.length) {
      skippedCount += 1;
      continue;
    }

    checkedCount += 1;
    const file = matchingFiles[0];
    let text;
    try {
      text = await downloadDriveJsonFile(file.id);
    } catch (error) {
      errorCount += 1;
      logger.warn('Legacy Drive analysis JSON download failed for one paper', {
        uid,
        paperId: paperSnapshot.id,
        fileId: file.id,
        error: summarizeDriveJsonError(error),
      });
      continue;
    }
    try {
      parseDriveAnalysisJson({ text, paper, paperId: paperSnapshot.id, topicOptions });
    } catch (error) {
      reviewCount += 1;
      const reason = summarizeDriveJsonError(error);
      await paperSnapshot.ref.set({
        driveAnalysisJsonStatus: 'review_required',
        driveAnalysisJsonReviewReason: reason,
        updatedAt: new Date(),
      }, { merge: true });
      continue;
    }
    try {
      const queued = await db.runTransaction(async (transaction) => {
        const currentSnapshot = await transaction.get(paperSnapshot.ref);
        if (!currentSnapshot.exists) return false;
        const current = currentSnapshot.data();
        if (current.analysisStatus === ANALYZED || current.analysisStatus === ANALYZING
          || current.activeAnalysisRunId || current.queuedAnalysisRunId) return false;
        transaction.set(paperSnapshot.ref, {
          analysisStatus: ANALYZING,
          analysisSource: 'checking_drive_json',
          analysisStage: 'Queued',
          analysisProgressMessage: 'Queued for matching Drive analysis JSON',
          analysisProgressCurrent: 0,
          analysisProgressTotal: 1,
          analysisError: '',
          analysisRequestedAt: new Date(),
          analysisRevision: Number(current.analysisRevision ?? 0) + 1,
          driveAnalysisJsonStatus: 'available',
          driveAnalysisJsonReviewReason: '',
          updatedAt: new Date(),
        }, { merge: true });
        return true;
      });
      if (queued) queuedCount += 1;
      else skippedCount += 1;
    } catch (error) {
      const reason = summarizeDriveJsonError(error);
      errorCount += 1;
      logger.warn('Could not queue a validated legacy Drive analysis JSON file', {
        uid,
        paperId: paperSnapshot.id,
        fileId: file.id,
        error: reason,
      });
    }
  }

  return {
    subject,
    grade,
    checkedCount,
    queuedCount,
    reviewCount,
    skippedCount,
    errorCount,
    moreCandidates: processedCount < candidates.length,
    analysisPaused: controlSnapshot.data()?.paused === true,
  };
});

const releaseAnalysisSlot = async ({ paperId, runId }) => {
  const db = getDb();
  const stateRef = paperQueueStateRef();
  await db.runTransaction(async (transaction) => {
    const stateSnapshot = await transaction.get(stateRef);
    const state = stateSnapshot.data();
    if (state?.activePaperId !== paperId || state?.activeRunId !== runId) return;
    const paperRef = db.collection('questionPapers').doc(paperId);
    transaction.set(stateRef, {
      activePaperId: null,
      activeRunId: null,
      releasedAt: new Date(),
      updatedAt: new Date(),
    }, { merge: true });
    transaction.set(paperRef, { activeAnalysisRunId: null, updatedAt: new Date() }, { merge: true });
  });
  await queueTask('dispatchQuestionPaperAnalysis', {});
};

const markRunWaitingForDriveJson = async ({ paperId, runId, paperRef, runRef, expectedName = '' }) => {
  const message = expectedName
    ? `No matching ${expectedName} was found in the Google Drive grade folder. Add the analyzed JSON file, then retry this paper.`
    : 'No matching analyzed JSON was found in the Google Drive grade folder. Add the JSON file, then retry this paper.';
  const now = new Date();
  await runRef.set({
    status: 'WaitingForDriveJson',
    analysisSource: 'google_drive_json',
    driveAnalysisJsonStatus: 'not_found',
    error: '',
    waitingReason: message,
    updatedAt: now,
  }, { merge: true });
  await paperRef.set({
    analysisStatus: WAITING_FOR_DRIVE_JSON,
    analysisStage: 'WaitingForDriveJson',
    analysisSource: 'checking_drive_json',
    driveAnalysisJsonStatus: 'not_found',
    driveAnalysisJsonReviewReason: '',
    analysisProgressMessage: message,
    analysisError: '',
    availableForGeneration: false,
    updatedAt: now,
  }, { merge: true });
  await releaseAnalysisSlot({ paperId, runId });
};

export const cancelQuestionPaperAnalysis = onCall(async (request) => {
  const { paperId } = request.data ?? {};
  if (!paperId) throw new HttpsError('invalid-argument', 'paperId is required.');

  const db = getDb();
  const paperRef = db.collection('questionPapers').doc(paperId);
  const paperSnapshot = await paperRef.get();
  if (!paperSnapshot.exists) throw new HttpsError('not-found', 'Question paper not found.');

  const paper = paperSnapshot.data();
  const stateRef = paperQueueStateRef();
  const stateSnapshot = await stateRef.get();
  const state = stateSnapshot.data();
  const runIds = [...new Set([
    paper.activeAnalysisRunId,
    paper.queuedAnalysisRunId,
    state?.activePaperId === paperId ? state.activeRunId : '',
  ].filter(Boolean))];

  const queueSnapshot = await paperQueueRef().where('paperId', '==', paperId).get();
  const now = new Date();
  const batch = db.batch();

  queueSnapshot.docs.forEach((item) => batch.delete(item.ref));
  runIds.forEach((runId) => {
    batch.set(runRefFor(paperId, runId), {
      status: 'Cancelled',
      error: '',
      cancelledAt: now,
      updatedAt: now,
    }, { merge: true });
  });
  if (state?.activePaperId === paperId) {
    batch.set(stateRef, {
      activePaperId: null,
      activeRunId: null,
      cancelledAt: now,
      updatedAt: now,
    }, { merge: true });
  }
  batch.set(paperRef, {
    analysisStatus: 'Cancelled',
    analysisStage: 'Cancelled',
    analysisProgressMessage: 'Analysis stopped by user.',
    analysisError: '',
    activeAnalysisRunId: null,
    queuedAnalysisRunId: null,
    availableForGeneration: false,
    updatedAt: now,
  }, { merge: true });
  await batch.commit();

  await Promise.all(runIds.map(async (runId) => {
    const batchesSnapshot = await runRefFor(paperId, runId).collection(BATCHES_COLLECTION).get();
    await Promise.all(batchesSnapshot.docs
      .filter((item) => item.data()?.status !== 'Completed')
      .map((item) => item.ref.set({ status: 'Cancelled', error: '', updatedAt: new Date() }, { merge: true })));
    await storage.bucket().deleteFiles({ prefix: `questionPaperAnalysis/${paperId}/${runId}/` }).catch((error) => {
      logger.warn('Could not clean up cancelled question-paper analysis pages', { paperId, runId, message: error?.message });
    });
  }));

  await queueTask('dispatchQuestionPaperAnalysis', {});
  logger.info('Question paper analysis cancelled', { paperId, runIds });
  return { paperId, runIds, status: 'Cancelled' };
});

const canvasFactory = {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  },
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  },
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  },
};

const extractPageText = async (page) => {
  try {
    const textContent = await page.getTextContent();
    return textContent.items.map((item) => item.str).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  } catch (error) {
    logger.warn('PDF text extraction skipped for page', { message: error?.message });
    return '';
  }
};

const fetchDocument = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download document (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
};

const extractSinglePagePdf = async ({ url, pageNumber }) => {
  const buffer = await fetchDocument(url);
  const source = await PDFDocument.load(buffer);
  const target = await PDFDocument.create();
  const sourcePageIndex = Math.max(0, Math.min(source.getPageCount() - 1, Number(pageNumber) - 1));
  const [page] = await target.copyPages(source, [sourcePageIndex]);
  target.addPage(page);
  return Buffer.from(await target.save());
};

const assertPdf = ({ mimeType, fileName, label }) => {
  const normalizedMime = String(mimeType || '').toLowerCase();
  const normalizedName = String(fileName || '').toLowerCase();
  if (!normalizedMime.includes('pdf') && !normalizedName.endsWith('.pdf')) {
    throw new Error(`${label} must be a PDF. DOC, DOCX, and image analysis are not supported yet.`);
  }
};

const renderAndStorePdfPages = async ({ buffer, label, paperId, runId, fileFingerprint }) => {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    canvasFactory,
    disableWorker: true,
    wasmUrl: pdfWasmUrl,
  });
  const pdf = await loadingTask.promise;
  const analyzedPageCount = Math.min(pdf.numPages, MAX_PAGES_PER_DOCUMENT);
  const pages = [];
  const bucket = storage.bucket();

  for (let pageNumber = 1; pageNumber <= analyzedPageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport, canvasFactory }).promise;
    const imageBuffer = canvas.toBuffer('image/jpeg', 0.76);
    const storagePath = `questionPaperAnalysis/${paperId}/${runId}/${safeId(label)}/page-${pageNumber}.jpg`;
    await bucket.file(storagePath).save(imageBuffer, {
      resumable: false,
      contentType: 'image/jpeg',
      metadata: { cacheControl: 'private,max-age=3600' },
    });
    pages.push({
      label,
      pageNumber,
      totalPages: pdf.numPages,
      storagePath,
      text: await extractPageText(page),
      sourceFingerprint: fileFingerprint,
    });
    page.cleanup?.();
  }

  await pdf.destroy?.();
  return { pages, totalPages: pdf.numPages, analyzedPageCount };
};

const loadPageImage = async (storagePath) => {
  const [buffer] = await storage.bucket().file(storagePath).download();
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
};

const markRunFailed = async ({ paperId, runId, error }) => {
  const db = getDb();
  const paperRef = db.collection('questionPapers').doc(paperId);
  const runRef = runRefFor(paperId, runId);
  const message = error?.message ?? String(error);
  await runRef.set({ status: FAILED, error: message, failedAt: new Date(), updatedAt: new Date() }, { merge: true });
  const paperSnapshot = await paperRef.get();
  if (paperSnapshot.data()?.activeAnalysisRunId === runId) {
    await paperRef.set({
      analysisStatus: FAILED,
      availableForGeneration: false,
      analysisError: message,
      analysisProgressMessage: 'Analysis failed. Review the error and retry.',
      updatedAt: new Date(),
    }, { merge: true });
  }
  await storage.bucket().deleteFiles({ prefix: `questionPaperAnalysis/${paperId}/${runId}/` }).catch((cleanupError) => {
    logger.warn('Could not clean up failed question-paper analysis pages', { paperId, runId, message: cleanupError?.message });
  });
  await releaseAnalysisSlot({ paperId, runId });
};

const ensureActiveRun = async ({ paperId, runId }) => {
  const db = getDb();
  const [paperSnapshot, runSnapshot, stateSnapshot] = await Promise.all([
    db.collection('questionPapers').doc(paperId).get(),
    runRefFor(paperId, runId).get(),
    paperQueueStateRef().get(),
  ]);
  if (!paperSnapshot.exists || !runSnapshot.exists) return null;
  const paper = paperSnapshot.data();
  const run = runSnapshot.data();
  const state = stateSnapshot.data();
  if (paper.activeAnalysisRunId !== runId || state?.activePaperId !== paperId || state?.activeRunId !== runId || run.status === 'Superseded') return null;
  return { paper, run, runRef: runSnapshot.ref, paperRef: paperSnapshot.ref };
};

const enqueuePendingBatches = async ({ paperId, runId, runRef }) => {
  const snapshot = await runRef.collection(BATCHES_COLLECTION).get();
  await Promise.all(snapshot.docs
    .filter((item) => !item.data().taskQueued)
    .map(async (item) => {
      await queueTask('analyzeQuestionPaperBatch', { paperId, runId, batchId: item.id });
      await item.ref.set({ taskQueued: true, updatedAt: new Date() }, { merge: true });
    }));
};

const enqueueFinalizerIfComplete = async ({ paperId, runId, runRef, batchCount }) => {
  const snapshot = await runRef.collection(BATCHES_COLLECTION).get();
  const batches = snapshot.docs.map((item) => item.data());
  const paperBatches = batches.filter((batch) => batch.documentType === 'paper');
  const completedPaperCount = paperBatches.filter((batch) => batch.status === 'Completed').length;
  const completedCount = batches.filter((batch) => batch.status === 'Completed').length;
  const requiredCount = paperBatches.length || batchCount;
  if (completedPaperCount >= requiredCount) {
    await queueTask('finalizeQuestionPaperAnalysis', { paperId, runId });
  }
  return completedCount;
};

const normalizeQuestion = ({ item, index, paperId, fallbackSubject }) => {
  const questionReference = String(item?.questionReference ?? item?.questionNumber ?? item?.number ?? '').trim();
  if (!questionReference) return null;
  const pageNumber = Number(item?.pageNumber ?? item?.page ?? 1) || 1;
  const topics = (Array.isArray(item?.topics) ? item.topics : [item?.topic ?? item?.skill])
    .map((topic) => String(topic ?? '').trim())
    .filter(Boolean);
  const topic = topics[0] || 'Unclassified topic';
  return {
    id: String(item?.id ?? `${paperId}-${questionReference}`).replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80) || `${paperId}-${index + 1}`,
    paperId,
    questionReference,
    parentQuestion: String(item?.parentQuestion ?? questionReference.split('.')[0] ?? '').trim(),
    subject: String(item?.subject ?? fallbackSubject ?? '').trim(),
    topic,
    topics,
    difficulty: normalizeDifficulty(item?.difficulty),
    pageNumber,
    marks: Number(item?.marks ?? item?.totalMarks ?? 0) || 0,
    section: String(item?.section ?? '').trim(),
    instruction: '',
    memoSummary: '',
    sourceDocumentType: String(item?.sourceDocumentType ?? item?.documentType ?? '').trim(),
    sourceBatchId: String(item?.sourceBatchId ?? item?.batchId ?? '').trim(),
  };
};

const questionKey = (question = {}) => String(question.questionReference ?? '')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, '');

const mergeQuestionsFromBatches = ({ paperId, paper, batches }) => {
  const merged = new Map();
  const orderedQuestions = batches.flatMap((batch) => (Array.isArray(batch.questions) ? batch.questions : [])
    .map((question) => ({ ...question, sourceDocumentType: batch.documentType, sourceBatchId: batch.batchId })));

  orderedQuestions.forEach((item, index) => {
    const normalized = normalizeQuestion({ item, index, paperId, fallbackSubject: paper.subject });
    if (!normalized) return;
    const key = questionKey(normalized);
    if (!key) return;

    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, normalized);
      return;
    }

    const existingIsMemoOnly = existing.sourceDocumentType === 'memo';
    const nextIsPaper = item.sourceDocumentType === 'paper';
    const base = existingIsMemoOnly && nextIsPaper ? normalized : existing;
    const extra = existingIsMemoOnly && nextIsPaper ? existing : normalized;
    merged.set(key, {
      ...base,
      marks: base.marks || extra.marks || 0,
      topic: base.topic && base.topic !== 'Unclassified topic' ? base.topic : extra.topic,
      topics: [...new Set([...(base.topics ?? []), ...(extra.topics ?? [])])],
      section: base.section || extra.section,
      instruction: '',
      memoSummary: '',
    });
  });

  return [...merged.values()]
    .map((question, index) => ({
      ...question,
      id: String(question.id || `${paperId}-${question.questionReference}-${index + 1}`)
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9_.-]/g, '')
        .slice(0, 80),
    }))
    .slice(0, MAX_STORED_QUESTIONS);
};

const buildAnalysisFromBatches = ({ paperId, paper, batches, models, topicOptions = [] }) => {
  const questions = mergeQuestionsFromBatches({ paperId, paper, batches });
  const batchTopics = batches.flatMap((batch) => Array.isArray(batch.topics) ? batch.topics : []);
  const topics = [...new Set([
    ...questions.map((question) => question.topic),
    ...questions.flatMap((question) => question.topics ?? []),
    ...batchTopics,
  ].map((topic) => String(topic ?? '').trim()).filter(Boolean))]
    .filter((topic) => topic !== 'Unclassified topic')
    .slice(0, 80);
  const canonicalTopics = topicOptions.length ? constrainTopicList(topics, topicOptions) : topics;
  const knownDifficultyByTopic = new Map(topicOptions.map((item) => [
    normalizeTopicOption(typeof item === 'string' ? item : item?.topic),
    parseDifficulty(typeof item === 'string' ? '' : item?.difficulty),
  ]).filter(([, difficulty]) => Boolean(difficulty)));
  const generatedDifficultyByTopic = new Map();
  const addDifficulty = (label, difficulty) => {
    const topic = normalizeStoredTopicLabel(label);
    const parsedDifficulty = parseDifficulty(difficulty);
    const key = normalizeTopicOption(topic);
    if (!topic || !parsedDifficulty || !canonicalTopics.some((canonical) => normalizeTopicOption(canonical) === key)) return;
    const entries = generatedDifficultyByTopic.get(key) ?? [];
    entries.push(parsedDifficulty);
    generatedDifficultyByTopic.set(key, entries);
  };
  batches.forEach((batch) => {
    (Array.isArray(batch.topicMetadata) ? batch.topicMetadata : []).forEach((item) => addDifficulty(item?.topic ?? item?.label, item?.difficulty));
    (Array.isArray(batch.questions) ? batch.questions : []).forEach((question) => {
      const questionTopics = Array.isArray(question.topics) ? question.topics : [question.topic];
      questionTopics.forEach((topic) => addDifficulty(topic, question.difficulty));
    });
  });
  const topicMetadata = canonicalTopics.map((topic) => {
    const key = normalizeTopicOption(topic);
    const knownDifficulty = knownDifficultyByTopic.get(key);
    const generatedDifficulties = generatedDifficultyByTopic.get(key) ?? [];
    const counts = new Map();
    generatedDifficulties.forEach((difficulty) => counts.set(difficulty, (counts.get(difficulty) ?? 0) + 1));
    const difficulty = knownDifficulty || [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || (left[0] === 'medium' ? -1 : right[0] === 'medium' ? 1 : left[0].localeCompare(right[0])))[0]?.[0] || '';
    return difficulty ? { topic, difficulty } : null;
  }).filter(Boolean);
  const topicsWithDifficulty = new Set(topicMetadata.map((item) => normalizeTopicOption(item.topic)));
  const analyzedTopics = canonicalTopics.filter((topic) => topicsWithDifficulty.has(normalizeTopicOption(topic)));
  const summaries = batches.map((batch) => String(batch.summary ?? '').trim()).filter(Boolean);
  const readabilityNotes = [...new Set(batches.flatMap((batch) => Array.isArray(batch.readabilityNotes) ? batch.readabilityNotes : [])
    .map((note) => String(note).trim())
    .filter(Boolean))]
    .slice(0, 20);
  return {
    metadata: {
      year: Number(paper.year) || null,
      month: String(paper.month ?? '').trim(),
      subject: String(paper.subject ?? '').trim(),
      grade: String(paper.grade ?? '').trim(),
      region: String(paper.region ?? '').trim(),
      paperNumber: String(paper.paperNumber ?? 'Paper 1').trim(),
      copySuffix: String(paper.copySuffix ?? '').trim(),
      paperTitle: String(paper.displayName ?? '').trim().slice(0, 160),
      totalMarks: questions.reduce((sum, question) => sum + (Number(question.marks) || 0), 0),
      confidence: questions.length ? 'medium' : 'low',
      topicMetadata,
    },
    questions,
    topics: analyzedTopics,
    topicMetadata,
    summary: summaries.join('\n\n').slice(0, 1200),
    readabilityNotes,
    textModel: '',
    visionModels: models,
  };
};

const normalizedPaperIdentityValue = (value) => normalizeTopicOption(value);

const paperIdentityForAnalysisJson = (paper = {}) => {
  const metadata = paper.paperMetadata ?? {};
  return {
    subject: paper.subject ?? metadata.subject ?? '',
    grade: paper.grade ?? metadata.grade ?? '',
    region: paper.region ?? paper.province ?? metadata.region ?? metadata.province ?? '',
    month: paper.month ?? metadata.month ?? '',
    year: paper.year ?? metadata.year ?? '',
    paperNumber: paper.paperNumber ?? metadata.paperNumber ?? '',
  };
};

const parseDriveAnalysisJson = ({ text, paper, paperId, topicOptions = [] }) => {
  let source;
  try {
    source = JSON.parse(text);
  } catch {
    throw new Error('The matching Drive analysis JSON is not valid JSON.');
  }
  if (!source || Number(source.schemaVersion) !== 1 || !source.paper || !source.analysis) {
    throw new Error('The matching Drive analysis JSON must use schemaVersion 1 and include paper and analysis objects.');
  }

  const expected = paperIdentityForAnalysisJson(paper);
  const provided = source.paper;
  for (const field of ['subject', 'grade', 'region', 'month', 'year', 'paperNumber']) {
    const left = normalizedPaperIdentityValue(expected[field]);
    const right = normalizedPaperIdentityValue(provided[field]);
    if (!left || !right || left !== right) {
      throw new Error(`The Drive analysis JSON ${field} does not match the stored paper record.`);
    }
  }

  const sourceQuestions = Array.isArray(source.analysis.questions) ? source.analysis.questions : [];
  if (!sourceQuestions.length || sourceQuestions.length > MAX_STORED_QUESTIONS) {
    throw new Error(`The Drive analysis JSON must contain 1-${MAX_STORED_QUESTIONS} questions.`);
  }
  const seenReferences = new Set();
  const normalizedQuestions = sourceQuestions.map((item, index) => {
    const questionReference = String(item?.questionReference ?? '').trim();
    const questionKeyValue = questionReference.toLowerCase().replace(/\s+/g, '');
    const pageNumber = Number(item?.pageNumber);
    const marks = Number(item?.marks);
    const difficulty = normalizeDifficulty(item?.difficulty);
    if (!questionReference || !questionKeyValue) throw new Error(`Question ${index + 1} is missing questionReference.`);
    if (seenReferences.has(questionKeyValue)) throw new Error(`The Drive analysis JSON contains a duplicate question reference: ${questionReference}.`);
    seenReferences.add(questionKeyValue);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new Error(`Question ${questionReference} must have a positive integer pageNumber.`);
    if (!Number.isFinite(marks) || marks < 0) throw new Error(`Question ${questionReference} must have a non-negative marks value.`);
    if (!difficulty) throw new Error(`Question ${questionReference} must have difficulty easy, medium, or hard.`);

    const requestedTopics = Array.isArray(item?.topics) ? item.topics : [item?.topic];
    const topicLabels = [...new Set(requestedTopics.map((value) => normalizeStoredTopicLabel(value)).filter(Boolean))];
    const suppliedTopicLabels = requestedTopics.map((value) => String(value ?? '').trim()).filter(Boolean);
    if (topicLabels.length !== suppliedTopicLabels.length) {
      throw new Error(`Question ${questionReference} contains a topic that is not in Child | Parent format.`);
    }
    const constrainedTopics = constrainTopicList(topicLabels, topicOptions);
    if (topicLabels.length && constrainedTopics.length !== topicLabels.length) {
      throw new Error(`Question ${questionReference} contains duplicate or invalid topic labels.`);
    }
    const question = normalizeQuestion({
      item: {
        ...item,
        questionReference,
        parentQuestion: String(item?.parentQuestion ?? questionReference.split('.')[0]).trim(),
        topics: constrainedTopics,
        topic: constrainedTopics[0] ?? '',
        difficulty,
        pageNumber,
        marks,
        sourceDocumentType: 'paper',
        sourceBatchId: 'drive-json',
      },
      index,
      paperId,
      fallbackSubject: paper.subject,
    });
    return question;
  });

  const parsed = {
    topicMetadata: Array.isArray(source.analysis.topicMetadata) ? source.analysis.topicMetadata : [],
  };
  const topicMetadata = normalizeParsedTopicMetadata({ parsed, questions: normalizedQuestions, topicOptions });
  const topics = [...new Set(normalizedQuestions.flatMap((question) => question.topics ?? []))]
    .filter((topic) => topic !== 'Unclassified topic')
    .slice(0, 80);
  const summary = String(source.analysis.summary ?? '').trim().slice(0, 1200);
  const readabilityNotes = [...new Set((Array.isArray(source.analysis.readabilityNotes) ? source.analysis.readabilityNotes : [])
    .map((note) => String(note ?? '').trim())
    .filter(Boolean))].slice(0, 20);
  const batch = {
    batchId: 'drive-json',
    documentType: 'paper',
    questions: normalizedQuestions,
    topics,
    topicMetadata,
    summary,
    readabilityNotes,
  };
  return buildAnalysisFromBatches({ paperId, paper, batches: [batch], models: [], topicOptions });
};

const syncDriveTopicFileAfterAnalysis = async ({ subject, grade }) => {
  if (!subject || !grade || subject.includes('/') || grade.includes('/')) return;
  const gradeRef = getDb().collection('subjects').doc(subject).collection('grades').doc(grade);
  try {
    const snapshot = await gradeRef.get();
    const gradeData = snapshot.data() ?? {};
    if (gradeData.driveTopicCatalogSyncInitialized !== true) return;
    const topics = uniqueTopicLabelsForDrive(gradeData.topics);
    const topicMetadata = (Array.isArray(gradeData.topicMetadata) ? gradeData.topicMetadata : [])
      .map((item) => ({
        topic: normalizeStoredTopicLabel(item?.topic ?? item?.label),
        difficulty: parseDifficulty(item?.difficulty),
      }))
      .filter((item) => item.topic && item.difficulty && topics.some((topic) => normalizeTopicOption(topic) === normalizeTopicOption(item.topic)));
    const written = await writeDriveTopicsJson({
      subject,
      grade,
      document: { schemaVersion: 1, subject, grade, topics, topicMetadata, updatedAt: new Date().toISOString() },
    });
    await gradeRef.set({
      driveTopicSyncStatus: 'synced',
      driveTopicSyncError: '',
      driveTopicsFileId: written.file?.id ?? '',
      driveTopicsSyncedAt: new Date(),
      updatedAt: new Date(),
    }, { merge: true });
  } catch (error) {
    const message = summarizeDriveJsonError(error);
    await gradeRef.set({
      driveTopicSyncStatus: 'pending',
      driveTopicSyncError: message,
      updatedAt: new Date(),
    }, { merge: true }).catch(() => {});
    logger.warn('Could not sync analyzed global topics to Google Drive', { subject, grade, error: message });
  }
};

const uniqueTopicLabelsForDrive = (value) => [...new Set((Array.isArray(value) ? value : [])
  .map((topic) => normalizeStoredTopicLabel(typeof topic === 'string' ? topic : topic?.topic ?? topic?.label))
  .filter(Boolean))];

const persistQuestionPaperAnalysis = async ({
  active,
  analysis,
  source,
  sourceDetails = {},
  batches = [],
  paperAnalyzedPageCount = 0,
  memoAnalyzedPageCount = 0,
}) => {
  const analyzedTopicLabels = [
    ...analysis.topics,
    ...analysis.questions.flatMap((question) => question.topics ?? []),
  ];
  if (active.paper.subject && active.paper.grade && analyzedTopicLabels.length) {
    await mergeGlobalTopicLabels(getDb(), active.paper.subject, active.paper.grade, analyzedTopicLabels, {
      topicMetadata: analysis.topicMetadata,
    });
  }

  const completedAt = new Date();
  const paperOutputs = batches.filter((item) => item.documentType === 'paper');
  const memoOutputs = batches.filter((item) => item.documentType === 'memo');
  await active.runRef.set({
    status: ANALYZED,
    analysisSource: source,
    driveAnalysisJsonStatus: sourceDetails.driveJsonStatus ?? 'not_checked',
    driveAnalysisJsonReviewReason: sourceDetails.driveJsonReviewReason ?? '',
    visionModels: analysis.visionModels,
    questionCount: analysis.questions.length,
    completedAt,
    updatedAt: completedAt,
  }, { merge: true });
  await active.paperRef.set({
    analysisStatus: ANALYZED,
    analysisStage: 'Completed',
    analysisSource: source,
    analysisSourceMessage: source === 'google_drive_json' ? 'Loaded from the matching Google Drive analysis JSON.' : 'Analyzed from the question-paper PDF using AI.',
    driveAnalysisJsonStatus: sourceDetails.driveJsonStatus ?? 'not_checked',
    driveAnalysisJsonReviewReason: sourceDetails.driveJsonReviewReason ?? '',
    analysisSourceDriveJsonFileId: sourceDetails.file?.id ?? '',
    analysisSourceDriveJsonFileName: sourceDetails.file?.name ?? '',
    analysisSourceDriveJsonModifiedTime: sourceDetails.file?.modifiedTime ?? null,
    analysisSourceDriveJsonRevision: sourceDetails.file?.version ?? '',
    analysisSourceDriveJsonSha256: sourceDetails.jsonSha256 ?? '',
    availableForGeneration: analysis.questions.length > 0,
    paperMetadata: analysis.metadata,
    questions: analysis.questions,
    questionCount: analysis.questions.length,
    topics: analysis.topics,
    topicMetadata: analysis.topicMetadata,
    analysisBatchOutputs: batches.map((item) => ({
      batchNumber: item.batchId,
      batchPageKey: (item.pages ?? []).map((page) => `${page.label}:${page.pageNumber}`).join('|'),
      model: item.model ?? '',
      pages: (item.pages ?? []).map(({ label, pageNumber }) => ({ label, pageNumber })),
      text: item.text ?? '',
      sourceFingerprint: item.sourceFingerprint ?? '',
    })),
    paperDocumentAnalysis: paperOutputs.map((item) => item.text).filter(Boolean).join('\n\n').slice(0, 45000),
    memoDocumentAnalysis: memoOutputs.map((item) => item.text).filter(Boolean).join('\n\n').slice(0, 25000),
    paperDocumentAnalysisModel: [...new Set(paperOutputs.map((item) => item.model).filter(Boolean))].join(', '),
    memoDocumentAnalysisModel: [...new Set(memoOutputs.map((item) => item.model).filter(Boolean))].join(', '),
    paperDocumentAnalysisPageCount: paperAnalyzedPageCount,
    memoDocumentAnalysisPageCount: memoAnalyzedPageCount,
    paperAnalysisSummary: analysis.summary,
    analysisReadabilityNotes: analysis.readabilityNotes,
    analysisTextModel: analysis.textModel ?? '',
    analysisVisionModels: analysis.visionModels,
    analysisSourcePaperFingerprint: active.run.paperFingerprint ?? '',
    analysisSourceMemoFingerprint: active.run.memoFingerprint ?? '',
    analysisProgressMessage: analysis.questions.length ? `Analyzed ${analysis.questions.length} questions` : 'Analyzed, but no questions were identified',
    analysisProgressCurrent: Math.max(1, batches.length + 1),
    analysisProgressTotal: Math.max(1, batches.length + 1),
    analysisCompletedAt: completedAt,
    updatedAt: completedAt,
  }, { merge: true });
  await syncDriveTopicFileAfterAnalysis({ subject: active.paper.subject, grade: active.paper.grade });
  return completedAt;
};

const buildMinimalBatchPrompt = ({ paperId, paper, pages, topicOptions = [] }) => {
  const requestedShape = {
    topics: ['Topic name'],
    topicMetadata: [{ topic: 'Topic name', difficulty: 'easy | medium | hard' }],
    questions: [{
      questionReference: '1.1',
      parentQuestion: '1',
      topics: ['Topic name'],
      marks: 2,
      pageNumber: pages[0]?.pageNumber ?? 1,
      section: 'Section A',
      difficulty: 'easy | medium | hard',
    }],
    summary: 'Short page metadata summary',
  };

  return [
    `Analyze this South African ${paper.subject || 'school subject'} question-paper page for Examifying.`,
    `Saved paper id: ${paperId}.`,
    `Upload metadata: subject=${paper.subject}, grade=${paper.grade}, region=${paper.region}, month=${paper.month}, year=${paper.year}, paperNumber=${paper.paperNumber ?? 'Paper 1'}, copySuffix=${paper.copySuffix ?? ''}.`,
    'Return strict JSON only. Do not include markdown, comments, code fences, or explanation outside the JSON.',
    `Return JSON matching this shape: ${JSON.stringify(requestedShape)}`,
    'For each visible exam question or sub-question, return only these keys in this order: questionReference, parentQuestion, topics, marks, pageNumber, section, difficulty. Choose question difficulty as easy, medium, or hard based on the reasoning and steps required to solve that question.',
    'For every topic in topicMetadata, return its difficulty as easy, medium, or hard. If the supplied topic list includes an existing difficulty, copy that exact value and do not invent or change it. If an existing topic has no difficulty value, estimate one from the analyzed questions and return it. Do not omit topicMetadata for a topic used by a question.',
    'Do not return id, paperId, subject, batchId, instruction, memoSummary, solution, or full question text.',
    ...(topicOptions.length ? [
      'Use the approved Firestore topic list as the source of truth and choose an exact listed label whenever it accurately covers the question.',
      'Do not invent a new label when an approved topic fits. Only if none of the approved topics accurately covers the specific question, suggest a new topic using exactly the Child | Parent structure.',
      'Keep both Child and Parent concise and specific: each side must be a topic name of no more than three words, never a sentence. Split compound concepts into separate labels instead of combining them, for example Fractions | Fraction Concepts, Decimals | Decimal Concepts, and Percentages | Percentage Concepts. Use the narrowest useful parent category; split broad parent areas into distinct, precise parent names instead of reusing one catch-all parent.',
      'Return an empty topics array only when the question topic cannot be determined.',
      `Approved topic labels and any saved difficulty values for ${paper.subject}, ${paper.grade}: ${JSON.stringify(topicOptions.map((item) => typeof item === 'string' ? { topic: item, difficulty: null } : { topic: item.topic, difficulty: item.difficulty || null }))}`,
    ] : [
      `The Firestore topic list for ${paper.subject || 'this subject'}, ${paper.grade || 'this grade'} is currently empty. Suggest concise new topics in Child | Parent format for the questions, then those suggestions will be added to this subject and grade's global topic list.`,
      'Both Child and Parent must be specific topic names of no more than three words each, never sentences. Split combined areas into multiple topics and use the narrowest useful parent categories instead of one broad catch-all parent.',
      'If a question covers multiple topics, include up to three separate labels.',
    ]),
    'For pages with no visible questions, return {"topics":[],"topicMetadata":[],"questions":[],"summary":"No visible questions"}.',
    'If embedded PDF text is provided, use it as a helper but trust the page visual for scanned pages.',
    ...pages.map((page) => page.text ? `${page.label} page ${page.pageNumber} embedded text: ${page.text.slice(0, 1800)}` : `${page.label} page ${page.pageNumber}: no embedded text found.`),
  ].join('\n');
};

const normalizeParsedQuestions = ({ parsed, batch, paperId, subject, topicOptions = [] }) =>
  parsed.questions
    .map((item, index) => {
      const sourceTopics = Array.isArray(item?.topics) ? item.topics : [item?.topic ?? item?.skill];
      const topics = constrainTopicList(sourceTopics, topicOptions);
      return normalizeQuestion({
        item: { ...item, topic: topics[0] ?? '', topics, sourceDocumentType: batch.documentType, sourceBatchId: batch.batchId },
        index,
        paperId,
        fallbackSubject: subject,
      });
    })
    .filter(Boolean);

const normalizeParsedTopicMetadata = ({ parsed, questions, topicOptions }) => {
  const rows = new Map();
  const add = (label, difficulty) => {
    const sourceTopic = String(label ?? '').trim();
    const topic = constrainTopicList([sourceTopic], topicOptions)[0];
    const key = normalizeTopicOption(topic);
    const parsedDifficulty = parseDifficulty(difficulty);
    if (!topic || !key || !parsedDifficulty) return;
    const current = rows.get(key) ?? { topic, difficulties: [] };
    current.difficulties.push(parsedDifficulty);
    rows.set(key, current);
  };
  (Array.isArray(parsed.topicMetadata) ? parsed.topicMetadata : []).forEach((item) => add(item?.topic ?? item?.label, item?.difficulty));
  questions.forEach((question) => (question.topics ?? [question.topic]).forEach((topic) => add(topic, question.difficulty)));
  const knownDifficultyByTopic = new Map(topicOptions.map((item) => [
    normalizeTopicOption(typeof item === 'string' ? item : item?.topic),
    parseDifficulty(typeof item === 'string' ? '' : item?.difficulty),
  ]).filter(([, difficulty]) => Boolean(difficulty)));
  return [...rows.values()].map(({ topic, difficulties }) => {
    const counts = new Map();
    difficulties.forEach((difficulty) => counts.set(difficulty, (counts.get(difficulty) ?? 0) + 1));
    const difficulty = knownDifficultyByTopic.get(normalizeTopicOption(topic)) || [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || (left[0] === 'medium' ? -1 : right[0] === 'medium' ? 1 : left[0].localeCompare(right[0])))[0]?.[0] || 'medium';
    return { topic, difficulty };
  });
};

const shouldAnalyze = ({ before, after }) => {
  if (!after || after.analysisStatus !== ANALYZING || !after.paperUrl) return false;
  if (!before) return true;
  return before.analysisStatus !== ANALYZING ||
    before.paperUrl !== after.paperUrl ||
    before.analysisRevision !== after.analysisRevision;
};

export const analyzeQuestionPaper = onDocumentWritten(
  { document: 'questionPapers/{paperId}', timeoutSeconds: 60, memory: '256MiB' },
  async (event) => {
    const paperId = event.params.paperId;
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const paper = event.data?.after?.exists ? event.data.after.data() : null;
    if (!event.data?.after?.ref || !shouldAnalyze({ before, after: paper })) return;

    const runId = safeId(event.id);
    const paperRef = event.data.after.ref;
    const runRef = paperRef.collection(RUNS_COLLECTION).doc(runId);
    const runSnapshot = await runRef.get();
    if (runSnapshot.exists && runSnapshot.data()?.queueEntryCreated) {
      await queueTask('dispatchQuestionPaperAnalysis', {});
      return;
    }

    const db = getDb();
    const subject = String(paper.subject ?? '').trim();
    const grade = String(paper.grade ?? '').trim();
    const gradeTopicsRef = subject && grade && !subject.includes('/') && !grade.includes('/')
      ? db.collection('subjects').doc(subject).collection('grades').doc(grade)
      : null;
    let topicOptions = [];
    if (gradeTopicsRef) {
      const gradeTopicsSnapshot = await gradeTopicsRef.get();
      const gradeTopics = gradeTopicsSnapshot.data() ?? {};
      topicOptions = sanitizeAnalysisTopicOptions(gradeTopics.topics, gradeTopics.topicMetadata);
    }
    await runRef.set({
      paperId,
      runId,
      status: 'Queued',
      analysisSource: 'checking_drive_json',
      sourcePaperUrl: paper.paperUrl,
      sourceMemoUrl: paper.memoUrl ?? '',
      topicOptions,
      requestedRevision: paper.analysisRevision ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, { merge: true });
    await paperQueueRef().doc(runId).set({
      paperId,
      runId,
      status: 'Queued',
      createdAt: paper.analysisRequestedAt ?? paper.createdAt ?? new Date(),
      bulkUploadIndex: paper.bulkUploadIndex ?? null,
    });
    await paperRef.set({
      queuedAnalysisRunId: runId,
      analysisTopicOptions: FieldValue.delete(),
      analysisStatus: ANALYZING,
      analysisSource: 'checking_drive_json',
      analysisStage: 'Queued',
      analysisProgressMessage: 'Waiting for earlier question papers to finish',
      analysisProgressCurrent: 0,
      analysisProgressTotal: 1,
      availableForGeneration: false,
      analysisStartedAt: new Date(),
      analysisError: '',
      updatedAt: new Date(),
    }, { merge: true });

    await runRef.set({ queueEntryCreated: true, updatedAt: new Date() }, { merge: true });
    await queueTask('dispatchQuestionPaperAnalysis', {});
  }
);

export const dispatchQuestionPaperAnalysis = onTaskDispatched({
  ...TASK_OPTIONS,
  rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
  memory: '256MiB',
  cpu: 'gcf_gen1',
  timeoutSeconds: 60,
}, async () => {
  const db = getDb();
  const stateRef = paperQueueStateRef();
  const queuedQuery = paperQueueRef().orderBy('createdAt', 'asc').limit(1);
  const claimed = await db.runTransaction(async (transaction) => {
    const [controlSnapshot, stateSnapshot] = await Promise.all([
      transaction.get(paperAnalysisControlRef()),
      transaction.get(stateRef),
    ]);
    if (controlSnapshot.data()?.paused === true) return { paused: true };
    const state = stateSnapshot.data();
    if (state?.activeRunId) {
      const activeRunRef = runRefFor(state.activePaperId, state.activeRunId);
      const activeRunSnapshot = await transaction.get(activeRunRef);
      if (activeRunSnapshot.exists && activeRunSnapshot.data()?.status === 'Preparing' && !activeRunSnapshot.data()?.prepareTaskQueued) {
        return { paperId: state.activePaperId, runId: state.activeRunId, runRef: activeRunRef };
      }
      return null;
    }

    const queuedSnapshot = await transaction.get(queuedQuery);
    if (queuedSnapshot.empty) return null;
    const queueDocument = queuedSnapshot.docs[0];
    const { paperId, runId } = queueDocument.data();
    const paperRef = db.collection('questionPapers').doc(paperId);
    const runRef = paperRef.collection(RUNS_COLLECTION).doc(runId);
    const [paperSnapshot, runSnapshot] = await Promise.all([
      transaction.get(paperRef),
      transaction.get(runRef),
    ]);

    if (!paperSnapshot.exists || !runSnapshot.exists || runSnapshot.data()?.status !== 'Queued') {
      transaction.delete(queueDocument.ref);
      return { stale: true };
    }

    transaction.set(stateRef, { activePaperId: paperId, activeRunId: runId, claimedAt: new Date(), updatedAt: new Date() }, { merge: true });
    transaction.delete(queueDocument.ref);
    transaction.set(runRef, { status: 'Preparing', startedAt: new Date(), updatedAt: new Date() }, { merge: true });
    transaction.set(paperRef, {
      activeAnalysisRunId: runId,
      queuedAnalysisRunId: null,
      analysisStage: 'Preparing',
      analysisProgressMessage: 'Starting queued question-paper analysis',
      analysisStartedAt: new Date(),
      updatedAt: new Date(),
    }, { merge: true });
    return { paperId, runId, runRef };
  });

  if (!claimed) return;
  if (claimed.paused) {
    logger.info('Question-paper analysis queue is paused; leaving queued papers untouched.');
    return;
  }
  if (claimed.stale) {
    await queueTask('dispatchQuestionPaperAnalysis', {});
    return;
  }
  try {
    await queueTask('prepareQuestionPaperAnalysis', { paperId: claimed.paperId, runId: claimed.runId });
    await claimed.runRef.set({ prepareTaskQueued: true, updatedAt: new Date() }, { merge: true });
  } catch (error) {
    await markRunFailed({ paperId: claimed.paperId, runId: claimed.runId, error });
    throw error;
  }
});

export const prepareQuestionPaperAnalysis = onTaskDispatched(TASK_OPTIONS, async (request) => {
  const { paperId, runId } = request.data ?? {};
  if (!paperId || !runId) throw new Error('paperId and runId are required.');
  const active = await ensureActiveRun({ paperId, runId });
  if (!active) return;
  if (active.run.status === ANALYZED) {
    if (active.paper.analysisStatus === ANALYZED) {
      await queuePendingInitialGenerationAfterAnalysis({ paperId, runId });
      await releaseAnalysisSlot({ paperId, runId });
    }
    return;
  }
  const { paper, paperRef, runRef } = active;

  if (!driveJsonAnalysisOnly() && active.run.status === 'BatchesQueued') {
    await enqueuePendingBatches({ paperId, runId, runRef });
    return;
  }

  try {
    let driveJsonStatus = 'not_found';
    let driveJsonReviewReason = '';
    let driveJsonResult = null;
    let driveJsonAnalysis = null;
    try {
      driveJsonResult = await readDriveQuestionPaperAnalysisJson(paper);
      if (driveJsonResult.found) {
        try {
          driveJsonAnalysis = parseDriveAnalysisJson({
            text: driveJsonResult.text,
            paper,
            paperId,
            topicOptions: sanitizeAnalysisTopicOptions(active.run.topicOptions),
          });
          driveJsonStatus = 'used';
        } catch (error) {
          driveJsonStatus = 'review_required';
          driveJsonReviewReason = summarizeDriveJsonError(error);
          logger.warn('Drive analysis JSON did not match the expected paper schema', {
            paperId,
            fileId: driveJsonResult.file?.id ?? '',
            reason: driveJsonReviewReason,
          });
          if (driveJsonAnalysisOnly()) {
            await runRef.set({ driveAnalysisJsonStatus: driveJsonStatus, driveAnalysisJsonReviewReason: driveJsonReviewReason, updatedAt: new Date() }, { merge: true });
            await paperRef.set({ driveAnalysisJsonStatus: driveJsonStatus, driveAnalysisJsonReviewReason: driveJsonReviewReason, updatedAt: new Date() }, { merge: true });
            await markRunFailed({ paperId, runId, error: new Error(`Drive analysis JSON needs review: ${driveJsonReviewReason}`) });
            return;
          }
        }
      }
    } catch (error) {
      driveJsonStatus = error?.code === 'ambiguous' ? 'review_required' : 'lookup_error';
      driveJsonReviewReason = summarizeDriveJsonError(error);
      logger.warn(driveJsonStatus === 'review_required'
        ? 'Ambiguous Drive analysis JSON match'
        : 'Could not look up pre-analyzed JSON in Google Drive', {
        paperId,
        reason: driveJsonReviewReason,
      });
      if (driveJsonAnalysisOnly() && driveJsonStatus === 'review_required') {
        await runRef.set({ driveAnalysisJsonStatus: driveJsonStatus, driveAnalysisJsonReviewReason: driveJsonReviewReason, updatedAt: new Date() }, { merge: true });
        await paperRef.set({ driveAnalysisJsonStatus: driveJsonStatus, driveAnalysisJsonReviewReason: driveJsonReviewReason, updatedAt: new Date() }, { merge: true });
        await markRunFailed({ paperId, runId, error: new Error(`Drive analysis JSON needs review: ${driveJsonReviewReason}`) });
        return;
      }
      if (driveJsonAnalysisOnly()) {
        await paperRef.set({
          analysisSource: 'checking_drive_json',
          driveAnalysisJsonStatus: 'lookup_error',
          driveAnalysisJsonReviewReason: driveJsonReviewReason,
          analysisProgressMessage: 'Could not reach the Google Drive analysis JSON. Retrying the lookup.',
          updatedAt: new Date(),
        }, { merge: true });
        throw new Error(`Google Drive analysis JSON lookup failed: ${driveJsonReviewReason}`);
      }
    }

    if (driveJsonAnalysisOnly() && !driveJsonResult?.found) {
      await markRunWaitingForDriveJson({
        paperId,
        runId,
        paperRef,
        runRef,
        expectedName: driveJsonResult?.expectedName,
      });
      return;
    }

    if (driveJsonAnalysis && driveJsonResult?.found) {
      if (!await ensureActiveRun({ paperId, runId })) return;
      const jsonSha256 = sha256(driveJsonResult.text);
      const sourceDetails = {
        driveJsonStatus: 'used',
        file: driveJsonResult.file,
        jsonSha256,
      };
      await runRef.set({
        status: 'Structuring',
        analysisSource: 'google_drive_json',
        driveAnalysisJsonStatus: 'used',
        driveAnalysisJsonFileId: driveJsonResult.file.id,
        driveAnalysisJsonFileName: driveJsonResult.file.name,
        driveAnalysisJsonRevision: driveJsonResult.file.version ?? '',
        driveAnalysisJsonSha256: jsonSha256,
        updatedAt: new Date(),
      }, { merge: true });
      await paperRef.set({
        analysisSource: 'google_drive_json',
        analysisStage: 'Structuring',
        driveAnalysisJsonStatus: 'used',
        analysisProgressMessage: 'Using the matching pre-analyzed Google Drive JSON',
        analysisProgressCurrent: 0,
        analysisProgressTotal: 1,
        analysisError: '',
        updatedAt: new Date(),
      }, { merge: true });
      const completedAt = await persistQuestionPaperAnalysis({
        active,
        analysis: driveJsonAnalysis,
        source: 'google_drive_json',
        sourceDetails,
        paperAnalyzedPageCount: Math.max(...driveJsonAnalysis.questions.map((question) => question.pageNumber)),
      });
      await queuePendingInitialGenerationAfterAnalysis({ paperId, runId });
      await releaseAnalysisSlot({ paperId, runId });
      logger.info('Question paper analysis completed from Google Drive JSON', {
        paperId,
        runId,
        questionCount: driveJsonAnalysis.questions.length,
        jsonFileId: driveJsonResult.file.id,
        completedAt: completedAt.toISOString(),
      });
      return;
    }

    if (driveJsonAnalysisOnly()) {
      await markRunWaitingForDriveJson({ paperId, runId, paperRef, runRef });
      return;
    }

    await runRef.set({
      analysisSource: 'firebase_ai',
      driveAnalysisJsonStatus: driveJsonStatus,
      driveAnalysisJsonReviewReason: driveJsonReviewReason,
      ...(driveJsonResult?.file ? {
        driveAnalysisJsonFileId: driveJsonResult.file.id,
        driveAnalysisJsonFileName: driveJsonResult.file.name,
        driveAnalysisJsonModifiedTime: driveJsonResult.file.modifiedTime ?? null,
        driveAnalysisJsonRevision: driveJsonResult.file.version ?? '',
      } : {}),
      updatedAt: new Date(),
    }, { merge: true });
    assertPdf({ mimeType: paper.paperMimeType, fileName: paper.paperFileName, label: 'Question paper' });
    await runRef.set({ status: 'Rendering', startedAt: new Date(), updatedAt: new Date() }, { merge: true });
    await paperRef.set({
      analysisStatus: ANALYZING,
      analysisSource: 'firebase_ai',
      analysisStage: 'Rendering',
      driveAnalysisJsonStatus: driveJsonStatus,
      driveAnalysisJsonReviewReason: driveJsonReviewReason,
      analysisProgressMessage: driveJsonStatus === 'review_required'
        ? 'Drive JSON needs review; analyzing the PDF with AI'
        : driveJsonStatus === 'lookup_error'
          ? 'Drive JSON lookup failed; analyzing the PDF with AI'
          : 'No matching Drive JSON found; rendering PDF pages for AI analysis',
      analysisError: '',
      updatedAt: new Date(),
    }, { merge: true });

    const paperBuffer = await fetchDocument(paper.paperUrl);
    const paperFingerprint = sha256(paperBuffer);
    const memoFingerprint = '';
    const paperDocument = await renderAndStorePdfPages({ buffer: paperBuffer, label: 'Question paper', paperId, runId, fileFingerprint: paperFingerprint });
    if (!await ensureActiveRun({ paperId, runId })) {
      await storage.bucket().deleteFiles({ prefix: `questionPaperAnalysis/${paperId}/${runId}/` });
      return;
    }
    const allBatches = [
      ...chunk(paperDocument.pages).map((pages, index) => ({ id: `paper-${index + 1}`, documentType: 'paper', pages })),
    ];
    if (!allBatches.length) throw new Error('No question paper pages could be rendered for analysis.');

    const batchWrites = allBatches.map(({ id, documentType, pages }) => runRef.collection(BATCHES_COLLECTION).doc(id).set({
      batchId: id,
      documentType,
      pages,
      sourceFingerprint: documentType === 'paper' ? paperFingerprint : memoFingerprint,
      status: 'Queued',
      attemptCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    await Promise.all(batchWrites);
    await runRef.set({
      status: 'BatchesQueued',
      paperFingerprint,
      memoFingerprint,
      paperPageCount: paperDocument.totalPages,
      memoPageCount: 0,
      paperAnalyzedPageCount: paperDocument.analyzedPageCount,
      memoAnalyzedPageCount: 0,
      batchCount: allBatches.length,
      completedBatchCount: 0,
      updatedAt: new Date(),
    }, { merge: true });
    await paperRef.set({
      analysisStage: 'Extracting',
      analysisProgressMessage: `AI page extraction [0/${allBatches.length} batches]`,
      analysisProgressCurrent: 0,
      analysisProgressTotal: allBatches.length + 1,
      paperPageCount: paperDocument.totalPages,
      memoPageCount: 0,
      updatedAt: new Date(),
    }, { merge: true });
    await enqueuePendingBatches({ paperId, runId, runRef });
  } catch (error) {
    if (request.retryCount >= MAX_TASK_ATTEMPTS - 1) await markRunFailed({ paperId, runId, error });
    throw error;
  }
});

export const analyzeQuestionPaperBatch = onTaskDispatched(BATCH_TASK_OPTIONS, async (request) => {
  const { paperId, runId, batchId } = request.data ?? {};
  if (!paperId || !runId || !batchId) throw new Error('paperId, runId, and batchId are required.');
  const active = await ensureActiveRun({ paperId, runId });
  if (!active) return;
  if (driveJsonAnalysisOnly()) {
    await queueDriveJsonOnlyPrepareTask({ paperId, runId });
    return;
  }
  const batchRef = active.runRef.collection(BATCHES_COLLECTION).doc(batchId);
  const batchSnapshot = await batchRef.get();
  if (!batchSnapshot.exists) return;
  if (batchSnapshot.data().status === 'Completed') {
    await enqueueFinalizerIfComplete({ paperId, runId, runRef: active.runRef, batchCount: active.run.batchCount });
    return;
  }
  const batch = batchSnapshot.data();
  const attemptCount = Number(batch.attemptCount ?? 0) + 1;
  await batchRef.set({ status: 'Processing', attemptCount, error: '', updatedAt: new Date() }, { merge: true });

  try {
    if (batch.documentType !== 'paper') {
      await batchRef.set({
        status: 'Completed',
        model: '',
        fallbackUsed: false,
        fallbackFrom: '',
        text: 'Skipped: only question-paper pages are indexed for generation.',
        questions: [],
        topics: [],
        summary: '',
        readabilityNotes: [],
        completedAt: new Date(),
        updatedAt: new Date(),
      }, { merge: true });
      const completedBatchCount = await enqueueFinalizerIfComplete({ paperId, runId, runRef: active.runRef, batchCount: active.run.batchCount });
      await active.runRef.set({ completedBatchCount, updatedAt: new Date() }, { merge: true });
      await active.paperRef.set({
        analysisProgressMessage: `AI page extraction [${completedBatchCount}/${active.run.batchCount} batches]`,
        analysisProgressCurrent: completedBatchCount,
        updatedAt: new Date(),
      }, { merge: true });
      return;
    }

    const topicOptions = sanitizeAnalysisTopicOptions(active.run.topicOptions);
    const prompt = buildMinimalBatchPrompt({ paperId, paper: active.paper, pages: batch.pages, topicOptions });
    const useGeminiFallback = attemptCount >= GEMINI_BATCH_ATTEMPT;
    const result = useGeminiFallback
      ? await (async () => {
        const pageNumber = batch.pages[0]?.pageNumber ?? 1;
        const pdfPage = await extractSinglePagePdf({ url: active.paper.paperUrl, pageNumber });
        const geminiResult = await callGeminiGenerateContent({
          prompt,
          pdfBase64: pdfPage.toString('base64'),
          responseFormat: { type: 'json_object' },
          maxTokens: 2200,
          temperature: 0.1,
        });
        logger.info('Question paper batch used Gemini PDF fallback', {
          paperId,
          runId,
          batchId,
          pageNumber,
          model: geminiResult.model,
        });
        return { ...geminiResult, fallbackUsed: true, fallbackFrom: 'kilo-vision-retries' };
      })()
      : await (async () => {
        const images = await Promise.all(batch.pages.map((page) => loadPageImage(page.storagePath)));
        const kiloResult = await callKiloVisionWithFallback({
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...images.map((imageUrl) => ({ type: 'image_url', image_url: { url: imageUrl } })),
            ],
          }],
          maxTokens: 2200,
          temperature: 0.1,
          responseFormat: { type: 'json_object' },
          mode: 'general',
        });
        logger.info('Question paper batch used Kilo vision extraction', {
          paperId,
          runId,
          batchId,
          attemptCount,
          model: kiloResult.model,
          fallbackUsed: Boolean(kiloResult.fallbackUsed),
          fallbackFrom: kiloResult.fallbackFrom ?? '',
        });
        return kiloResult;
      })();
    const parsed = parseBatchAnalysis(result.text);
    const questions = normalizeParsedQuestions({ parsed, batch, paperId, subject: active.paper.subject, topicOptions });
    const topicMetadata = normalizeParsedTopicMetadata({ parsed, questions, topicOptions });
    if (questions.some((question) => !question.difficulty)) {
      throw new Error(`Question difficulty metadata was incomplete for ${batchId}; retrying before Gemini fallback.`);
    }
    if (!questions.length && !useGeminiFallback && !isIntentionallyEmptyPage(parsed)) {
      throw new Error(`No question metadata extracted for ${batchId}; retrying before Gemini fallback.`);
    }
    if (!await ensureActiveRun({ paperId, runId })) return;
    await batchRef.set({
      status: 'Completed',
      model: result.model ?? '',
      fallbackUsed: Boolean(result.fallbackUsed),
      fallbackFrom: result.fallbackFrom ?? '',
      text: (parsed.rawText || parsed.summary || String(result.text ?? '')).trim().slice(0, 6000),
      questions,
      topics: constrainTopicList(parsed.topics, topicOptions).slice(0, 40),
      topicMetadata,
      summary: parsed.summary.slice(0, 1200),
      readabilityNotes: parsed.readabilityNotes.map((note) => String(note).trim()).filter(Boolean).slice(0, 10),
      parseWarning: parsed.parseWarning,
      completedAt: new Date(),
      updatedAt: new Date(),
    }, { merge: true });

    const completedBatchCount = await enqueueFinalizerIfComplete({ paperId, runId, runRef: active.runRef, batchCount: active.run.batchCount });
    await active.runRef.set({ completedBatchCount, updatedAt: new Date() }, { merge: true });
    await active.paperRef.set({
      analysisProgressMessage: `AI page extraction [${completedBatchCount}/${active.run.batchCount} batches]`,
      analysisProgressCurrent: completedBatchCount,
      updatedAt: new Date(),
    }, { merge: true });
  } catch (error) {
    const latestBatch = await batchRef.get();
    if (latestBatch.data()?.status !== 'Completed') {
      await batchRef.set({ status: 'Failed', error: error?.message ?? String(error), updatedAt: new Date() }, { merge: true });
    }
    if (request.retryCount >= MAX_TASK_ATTEMPTS - 1) await markRunFailed({ paperId, runId, error });
    logger.error('Question paper batch analysis failed', { paperId, runId, batchId, attemptCount, message: error?.message });
    throw error;
  }
});

export const finalizeQuestionPaperAnalysis = onTaskDispatched(TASK_OPTIONS, async (request) => {
  const { paperId, runId } = request.data ?? {};
  if (!paperId || !runId) throw new Error('paperId and runId are required.');
  const active = await ensureActiveRun({ paperId, runId });
  if (!active) return;
  if (driveJsonAnalysisOnly()) {
    await queueDriveJsonOnlyPrepareTask({ paperId, runId });
    return;
  }
  if (active.run.status === ANALYZED) {
    const paperCompletedAt = timestampMillis(active.paper.analysisCompletedAt);
    const runCompletedAt = timestampMillis(active.run.completedAt);
    if (active.paper.analysisStatus === ANALYZED
      && paperCompletedAt > 0 && paperCompletedAt === runCompletedAt) {
      await queuePendingInitialGenerationAfterAnalysis({ paperId, runId });
    }
    await releaseAnalysisSlot({ paperId, runId });
    return;
  }

  let paperAnalysisCommitted = false;
  try {
    const batchesSnapshot = await active.runRef.collection(BATCHES_COLLECTION).get();
    const batches = batchesSnapshot.docs.map((item) => item.data());
    const paperBatches = batches.filter((batch) => batch.documentType === 'paper');
    if (!paperBatches.length || paperBatches.some((batch) => batch.status !== 'Completed')) {
      logger.warn('Finalization skipped because analysis batches are incomplete', { paperId, runId });
      return;
    }
    await active.runRef.set({ status: 'Structuring', updatedAt: new Date() }, { merge: true });
    await active.paperRef.set({
      analysisStatus: ANALYZING,
      analysisStage: 'Structuring',
      analysisProgressMessage: 'Combining extracted question index',
      analysisProgressCurrent: batches.length,
      updatedAt: new Date(),
    }, { merge: true });
    const ordered = batches.sort((left, right) => String(left.batchId).localeCompare(String(right.batchId), undefined, { numeric: true }));
    const paperOutputs = ordered.filter((item) => item.documentType === 'paper');
    const models = [...new Set(paperOutputs.map((item) => item.model).filter(Boolean))];
    const analysis = buildAnalysisFromBatches({
      paperId,
      paper: active.paper,
      batches: paperOutputs,
      models,
      topicOptions: sanitizeAnalysisTopicOptions(active.run.topicOptions),
    });
    if (!await ensureActiveRun({ paperId, runId })) return;
    await persistQuestionPaperAnalysis({
      active,
      analysis,
      source: active.run.analysisSource === 'google_drive_json' ? 'google_drive_json' : 'firebase_ai',
      sourceDetails: {
        driveJsonStatus: active.run.driveAnalysisJsonStatus ?? 'not_found',
        driveJsonReviewReason: active.run.driveAnalysisJsonReviewReason ?? '',
        file: active.run.driveAnalysisJsonFileId ? {
          id: active.run.driveAnalysisJsonFileId,
          name: active.run.driveAnalysisJsonFileName ?? '',
          version: active.run.driveAnalysisJsonRevision ?? '',
          modifiedTime: active.run.driveAnalysisJsonModifiedTime ?? null,
        } : null,
        jsonSha256: active.run.driveAnalysisJsonSha256 ?? '',
      },
      batches: ordered,
      paperAnalyzedPageCount: active.run.paperAnalyzedPageCount,
      memoAnalyzedPageCount: active.run.memoAnalyzedPageCount,
    });
    paperAnalysisCommitted = true;
    await queuePendingInitialGenerationAfterAnalysis({ paperId, runId });
    await storage.bucket().deleteFiles({ prefix: `questionPaperAnalysis/${paperId}/${runId}/` }).catch((error) => {
      logger.warn('Could not clean up rendered question-paper pages', { paperId, runId, message: error?.message });
    });
    await releaseAnalysisSlot({ paperId, runId });
    logger.info('Question paper analysis completed', { paperId, runId, questionCount: analysis.questions.length });
  } catch (error) {
    if (!paperAnalysisCommitted && request.retryCount >= MAX_TASK_ATTEMPTS - 1) {
      await markRunFailed({ paperId, runId, error });
    }
    throw error;
  }
});

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
import { callKiloVisionWithFallback } from './kilo.js';
import { callGeminiGenerateContent } from './gemini.js';

const ANALYZING = 'Analyzing';
const ANALYZED = 'Analyzed';
const FAILED = 'Failed';
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
    summary: String(parsed?.summary ?? fallbackSummary).trim(),
    readabilityNotes: Array.isArray(parsed?.readabilityNotes) ? parsed.readabilityNotes : [],
    rawText: String(parsed?.rawText ?? parsed?.extractedText ?? parsed?.summary ?? raw).trim(),
    parseWarning: parsed ? '' : 'Vision model returned non-JSON output; raw text was preserved.',
  };
};

const normalizeTopicOption = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9|]+/g, ' ')
  .replace(/\s*\|\s*/g, ' | ')
  .replace(/\s+/g, ' ')
  .trim();

const sanitizeAnalysisTopicOptions = (value) => (Array.isArray(value) ? value : [])
  .map((topic) => String(topic ?? '').trim().slice(0, 180))
  .filter((topic, index, topics) => topic.includes('|') && topics.indexOf(topic) === index)
  .slice(0, 300);

const constrainTopicList = (values, allowedTopics) => {
  const topics = Array.isArray(values) ? values : [];
  if (!allowedTopics?.length) return topics.map((topic) => String(topic ?? '').trim()).filter(Boolean);
  const allowedByKey = new Map(allowedTopics.map((topic) => [normalizeTopicOption(topic), topic]));
  return [...new Set(topics
    .map((topic) => allowedByKey.get(normalizeTopicOption(topic)))
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
const runRefFor = (paperId, runId) => getDb().collection('questionPapers').doc(paperId).collection(RUNS_COLLECTION).doc(runId);
const queueTask = (name, data) => taskQueue(name).enqueue(data);
const paperQueueRef = () => getDb().collection(PAPER_QUEUE_COLLECTION);
const paperQueueStateRef = () => getDb().collection(PAPER_QUEUE_STATE_COLLECTION).doc('worker');

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
    },
    questions,
    topics: canonicalTopics,
    summary: summaries.join('\n\n').slice(0, 1200),
    readabilityNotes,
    textModel: '',
    visionModels: models,
  };
};

const buildMinimalBatchPrompt = ({ paperId, paper, pages, topicOptions = [] }) => {
  const requestedShape = {
    topics: ['Topic name'],
    questions: [{
      questionReference: '1.1',
      parentQuestion: '1',
      topics: ['Topic name'],
      marks: 2,
      pageNumber: pages[0]?.pageNumber ?? 1,
      section: 'Section A',
    }],
    summary: 'Short page metadata summary',
  };

  return [
    `Analyze this South African ${paper.subject || 'school subject'} question-paper page for Examifying.`,
    `Saved paper id: ${paperId}.`,
    `Upload metadata: subject=${paper.subject}, grade=${paper.grade}, region=${paper.region}, month=${paper.month}, year=${paper.year}, paperNumber=${paper.paperNumber ?? 'Paper 1'}, copySuffix=${paper.copySuffix ?? ''}.`,
    'Return strict JSON only. Do not include markdown, comments, code fences, or explanation outside the JSON.',
    `Return JSON matching this shape: ${JSON.stringify(requestedShape)}`,
    'For each visible exam question or sub-question, return only these keys in this order: questionReference, parentQuestion, topics, marks, pageNumber, section.',
    'Do not return id, paperId, subject, batchId, instruction, memoSummary, solution, or full question text.',
    ...(topicOptions.length ? [
      'Choose topic labels exclusively and exactly from the approved frontend topic list below. Do not create aliases or labels.',
      'If no approved label fits a question, return an empty topics array for that question. If no approved label appears on the page, return an empty top-level topics array.',
      `Approved topic labels for ${paper.subject}, ${paper.grade}: ${JSON.stringify(topicOptions)}`,
    ] : [`Use concise ${paper.subject || 'subject'} topic names in Child | Parent format. If a question covers multiple topics, include up to three topics.`]),
    'For pages with no visible questions, return {"topics":[],"questions":[],"summary":"No visible questions"}.',
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

    await runRef.set({
      paperId,
      runId,
      status: 'Queued',
      sourcePaperUrl: paper.paperUrl,
      sourceMemoUrl: paper.memoUrl ?? '',
      topicOptions: sanitizeAnalysisTopicOptions(paper.analysisTopicOptions),
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
    const stateSnapshot = await transaction.get(stateRef);
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
  if (!active || active.run.status === ANALYZED) return;
  const { paper, paperRef, runRef } = active;

  if (active.run.status === 'BatchesQueued') {
    await enqueuePendingBatches({ paperId, runId, runRef });
    return;
  }

  try {
    assertPdf({ mimeType: paper.paperMimeType, fileName: paper.paperFileName, label: 'Question paper' });
    await runRef.set({ status: 'Rendering', startedAt: new Date(), updatedAt: new Date() }, { merge: true });
    await paperRef.set({ analysisStatus: ANALYZING, analysisStage: 'Rendering', analysisProgressMessage: 'Rendering PDF pages for analysis', analysisError: '', updatedAt: new Date() }, { merge: true });

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
  if (active.run.status === ANALYZED) {
    await releaseAnalysisSlot({ paperId, runId });
    return;
  }

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
    const memoOutputs = ordered.filter((item) => item.documentType === 'memo');
    const models = [...new Set(paperOutputs.map((item) => item.model).filter(Boolean))];
    const analysis = buildAnalysisFromBatches({
      paperId,
      paper: active.paper,
      batches: paperOutputs,
      models,
      topicOptions: sanitizeAnalysisTopicOptions(active.run.topicOptions),
    });
    if (!await ensureActiveRun({ paperId, runId })) return;
    const completedAt = new Date();
    await active.runRef.set({
      status: ANALYZED,
      visionModels: analysis.visionModels,
      questionCount: analysis.questions.length,
      completedAt,
      updatedAt: completedAt,
    }, { merge: true });
    await active.paperRef.set({
      analysisStatus: ANALYZED,
      analysisStage: 'Completed',
      availableForGeneration: analysis.questions.length > 0,
      paperMetadata: analysis.metadata,
      questions: analysis.questions,
      questionCount: analysis.questions.length,
      topics: analysis.topics,
      analysisBatchOutputs: ordered.map((item) => ({ batchNumber: item.batchId, batchPageKey: item.pages.map((page) => `${page.label}:${page.pageNumber}`).join('|'), model: item.model ?? '', pages: item.pages.map(({ label, pageNumber }) => ({ label, pageNumber })), text: item.text ?? '', sourceFingerprint: item.sourceFingerprint })),
      paperDocumentAnalysis: paperOutputs.map((item) => item.text).filter(Boolean).join('\n\n').slice(0, 45000),
      memoDocumentAnalysis: memoOutputs.map((item) => item.text).filter(Boolean).join('\n\n').slice(0, 25000),
      paperDocumentAnalysisModel: [...new Set(paperOutputs.map((item) => item.model).filter(Boolean))].join(', '),
      memoDocumentAnalysisModel: [...new Set(memoOutputs.map((item) => item.model).filter(Boolean))].join(', '),
      paperDocumentAnalysisPageCount: active.run.paperAnalyzedPageCount,
      memoDocumentAnalysisPageCount: active.run.memoAnalyzedPageCount,
      paperAnalysisSummary: analysis.summary,
      analysisReadabilityNotes: analysis.readabilityNotes,
      analysisTextModel: '',
      analysisVisionModels: analysis.visionModels,
      analysisSourcePaperFingerprint: active.run.paperFingerprint,
      analysisSourceMemoFingerprint: active.run.memoFingerprint,
      analysisProgressMessage: analysis.questions.length ? `Analyzed ${analysis.questions.length} questions` : 'Analyzed, but no questions were identified',
      analysisProgressCurrent: batches.length + 1,
      analysisProgressTotal: batches.length + 1,
      analysisCompletedAt: completedAt,
      updatedAt: completedAt,
    }, { merge: true });
    await storage.bucket().deleteFiles({ prefix: `questionPaperAnalysis/${paperId}/${runId}/` }).catch((error) => {
      logger.warn('Could not clean up rendered question-paper pages', { paperId, runId, message: error?.message });
    });
    await releaseAnalysisSlot({ paperId, runId });
    logger.info('Question paper analysis completed', { paperId, runId, questionCount: analysis.questions.length });
  } catch (error) {
    if (request.retryCount >= MAX_TASK_ATTEMPTS - 1) await markRunFailed({ paperId, runId, error });
    throw error;
  }
});

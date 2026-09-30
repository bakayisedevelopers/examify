import { createHash } from 'node:crypto';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { logger } from 'firebase-functions';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { getDb, storage, taskQueue } from './admin.js';
import { callKiloTextWithFallback, callKiloVisionWithFallback } from './kilo.js';

const ANALYZING = 'Analyzing';
const ANALYZED = 'Analyzed';
const FAILED = 'Failed';
const MAX_PAGES_PER_DOCUMENT = 40;
const PAGES_PER_BATCH = 2;
const PDF_RENDER_SCALE = 1.6;
const MAX_STORED_QUESTIONS = 180;
const MAX_TASK_ATTEMPTS = 5;
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

const parseStructuredAnalysis = (text = '') => {
  try {
    const parsed = JSON.parse(extractJsonObject(text));
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.questions) ? parsed : null;
  } catch {
    return null;
  }
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
  const completedSnapshot = await runRef.collection(BATCHES_COLLECTION).where('status', '==', 'Completed').get();
  if (completedSnapshot.size >= batchCount) {
    await queueTask('finalizeQuestionPaperAnalysis', { paperId, runId });
  }
  return completedSnapshot.size;
};

const normalizeQuestion = ({ item, index, paperId, fallbackSubject }) => {
  const questionReference = String(item?.questionReference ?? item?.questionNumber ?? item?.number ?? '').trim();
  if (!questionReference) return null;
  const pageNumber = Number(item?.pageNumber ?? item?.page ?? 1) || 1;
  return {
    id: String(item?.id ?? `${paperId}-${questionReference}`).replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80) || `${paperId}-${index + 1}`,
    paperId,
    questionReference,
    parentQuestion: String(item?.parentQuestion ?? questionReference.split('.')[0] ?? '').trim(),
    subject: String(item?.subject ?? fallbackSubject ?? '').trim(),
    topic: String(item?.topic ?? item?.skill ?? 'Unclassified topic').trim(),
    pageNumber,
    marks: Number(item?.marks ?? item?.totalMarks ?? 0) || 0,
    section: String(item?.section ?? '').trim(),
    instruction: String(item?.instruction ?? item?.summary ?? '').trim().slice(0, 700),
    memoSummary: String(item?.memoSummary ?? item?.memo ?? '').trim().slice(0, 700),
  };
};

const normalizeAnalysis = async ({ paperId, paper, paperOutputs, memoOutputs, models }) => {
  const requestedShape = {
    metadata: { year: paper.year, month: paper.month, subject: paper.subject, grade: paper.grade, region: paper.region, paperNumber: paper.paperNumber ?? 'Paper 1', copySuffix: paper.copySuffix ?? '', paperTitle: '', totalMarks: 0, confidence: 'medium' },
    topics: [],
    questions: [{ questionReference: '1.1', parentQuestion: '1', subject: paper.subject, topic: 'Topic name', pageNumber: 1, marks: 2, section: 'Section A', instruction: 'Short identification', memoSummary: 'Short memo summary' }],
    summary: 'Short description of the paper contents',
    readabilityNotes: [],
  };
  const result = await callKiloTextWithFallback({
    messages: [
      { role: 'system', content: 'You return strict JSON only. Do not include markdown, comments, or explanatory text.' },
      { role: 'user', content: [
        'Convert this OCR output into a concise question-paper index for Examifying.',
        'Do not include full copied paper text. Store only metadata and enough question detail to choose exercises later.',
        'Every question must use the exact paperId shown below and include a pageNumber that opens the original PDF.',
        'Use the uploaded subject when uncertain. If marks are unclear, set marks to 0.',
        `Paper id: ${paperId}`,
        `Uploaded metadata: ${JSON.stringify({ year: paper.year, month: paper.month, subject: paper.subject, grade: paper.grade, region: paper.region, paperNumber: paper.paperNumber ?? 'Paper 1', copySuffix: paper.copySuffix ?? '', displayName: paper.displayName ?? '', notes: paper.notes ?? '' })}`,
        `Return JSON matching this shape: ${JSON.stringify(requestedShape)}`,
        `Paper OCR batches: ${JSON.stringify(paperOutputs)}`,
        `Memo OCR batches: ${JSON.stringify(memoOutputs)}`,
      ].join('\n') },
    ],
    responseFormat: { type: 'json_object' },
    maxTokens: 5000,
    temperature: 0.1,
    validateText: (text) => Boolean(parseStructuredAnalysis(text)),
  });
  const parsed = parseStructuredAnalysis(result.text);
  if (!parsed) throw new Error('Kilo returned invalid question-paper JSON after all text-model attempts.');
  const questions = parsed.questions
    .map((item, index) => normalizeQuestion({ item, index, paperId, fallbackSubject: paper.subject }))
    .filter(Boolean)
    .slice(0, MAX_STORED_QUESTIONS);
  const topics = Array.isArray(parsed.topics)
    ? parsed.topics.map((topic) => String(topic).trim()).filter(Boolean).slice(0, 80)
    : [...new Set(questions.map((question) => question.topic).filter(Boolean))].slice(0, 80);
  return {
    metadata: {
      year: Number(parsed?.metadata?.year ?? paper.year) || Number(paper.year) || null,
      month: String(parsed?.metadata?.month ?? paper.month ?? '').trim(),
      subject: String(parsed?.metadata?.subject ?? paper.subject ?? '').trim(),
      grade: String(parsed?.metadata?.grade ?? paper.grade ?? '').trim(),
      region: String(parsed?.metadata?.region ?? paper.region ?? '').trim(),
      paperNumber: String(parsed?.metadata?.paperNumber ?? paper.paperNumber ?? 'Paper 1').trim(),
      copySuffix: String(paper.copySuffix ?? '').trim(),
      paperTitle: String(parsed?.metadata?.paperTitle ?? '').trim().slice(0, 160),
      totalMarks: Number(parsed?.metadata?.totalMarks ?? 0) || 0,
      confidence: String(parsed?.metadata?.confidence ?? 'medium').trim(),
    },
    questions,
    topics,
    summary: String(parsed?.summary ?? '').trim().slice(0, 1200),
    readabilityNotes: Array.isArray(parsed?.readabilityNotes) ? parsed.readabilityNotes.map((note) => String(note).trim()).filter(Boolean).slice(0, 20) : [],
    textModel: result.model ?? '',
    visionModels: models,
  };
};

const shouldAnalyze = ({ before, after }) => {
  if (!after || after.analysisStatus !== ANALYZING || !after.paperUrl) return false;
  if (!before) return true;
  return before.analysisStatus !== ANALYZING ||
    before.paperUrl !== after.paperUrl ||
    before.memoUrl !== after.memoUrl ||
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
    if (paper.memoUrl) assertPdf({ mimeType: paper.memoMimeType, fileName: paper.memoFileName, label: 'Memorandum' });
    await runRef.set({ status: 'Rendering', startedAt: new Date(), updatedAt: new Date() }, { merge: true });
    await paperRef.set({ analysisStatus: ANALYZING, analysisStage: 'Rendering', analysisProgressMessage: 'Rendering PDF pages for analysis', analysisError: '', updatedAt: new Date() }, { merge: true });

    const [paperBuffer, memoBuffer] = await Promise.all([
      fetchDocument(paper.paperUrl),
      paper.memoUrl ? fetchDocument(paper.memoUrl) : Promise.resolve(null),
    ]);
    const paperFingerprint = sha256(paperBuffer);
    const memoFingerprint = memoBuffer ? sha256(memoBuffer) : '';
    const [paperDocument, memoDocument] = await Promise.all([
      renderAndStorePdfPages({ buffer: paperBuffer, label: 'Question paper', paperId, runId, fileFingerprint: paperFingerprint }),
      memoBuffer ? renderAndStorePdfPages({ buffer: memoBuffer, label: 'Memorandum', paperId, runId, fileFingerprint: memoFingerprint }) : Promise.resolve({ pages: [], totalPages: 0, analyzedPageCount: 0 }),
    ]);
    if (!await ensureActiveRun({ paperId, runId })) {
      await storage.bucket().deleteFiles({ prefix: `questionPaperAnalysis/${paperId}/${runId}/` });
      return;
    }
    const allBatches = [
      ...chunk(paperDocument.pages).map((pages, index) => ({ id: `paper-${index + 1}`, documentType: 'paper', pages })),
      ...chunk(memoDocument.pages).map((pages, index) => ({ id: `memo-${index + 1}`, documentType: 'memo', pages })),
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
      memoPageCount: memoDocument.totalPages,
      paperAnalyzedPageCount: paperDocument.analyzedPageCount,
      memoAnalyzedPageCount: memoDocument.analyzedPageCount,
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
      memoPageCount: memoDocument.totalPages,
      updatedAt: new Date(),
    }, { merge: true });
    await enqueuePendingBatches({ paperId, runId, runRef });
  } catch (error) {
    if (request.retryCount >= MAX_TASK_ATTEMPTS - 1) await markRunFailed({ paperId, runId, error });
    throw error;
  }
});

export const analyzeQuestionPaperBatch = onTaskDispatched(TASK_OPTIONS, async (request) => {
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
    const images = await Promise.all(batch.pages.map((page) => loadPageImage(page.storagePath)));
    const result = await callKiloVisionWithFallback({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: [
            'Analyze these South African Mathematics exam document pages for Examifying.',
            `Saved paper id: ${paperId}.`,
            `Upload metadata: subject=${active.paper.subject}, grade=${active.paper.grade}, region=${active.paper.region}, month=${active.paper.month}, year=${active.paper.year}, paperNumber=${active.paper.paperNumber ?? 'Paper 1'}, copySuffix=${active.paper.copySuffix ?? ''}.`,
            'For every visible exam question or memo item, transcribe the question number, Maths topic or skill, mark allocation, page number, section heading, and any short instruction needed to identify the question later.',
            'If embedded PDF text is provided, use it as a helper but trust the image for scanned pages.',
            'Return concise plain text grouped by page. Do not return JSON yet.',
            ...batch.pages.map((page) => page.text ? `${page.label} page ${page.pageNumber} embedded text: ${page.text.slice(0, 2500)}` : `${page.label} page ${page.pageNumber}: no embedded text found.`),
          ].join('\n') },
          ...images.map((imageUrl) => ({ type: 'image_url', image_url: { url: imageUrl } })),
        ],
      }],
      maxTokens: 2600,
      temperature: 0.1,
      mode: 'general',
    });
    if (!await ensureActiveRun({ paperId, runId })) return;
    await batchRef.set({
      status: 'Completed',
      model: result.model ?? '',
      fallbackUsed: Boolean(result.fallbackUsed),
      fallbackFrom: result.fallbackFrom ?? '',
      text: String(result.text ?? '').trim().slice(0, 6000),
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
    if (!batches.length || batches.some((batch) => batch.status !== 'Completed')) {
      logger.warn('Finalization skipped because analysis batches are incomplete', { paperId, runId });
      return;
    }
    await active.runRef.set({ status: 'Structuring', updatedAt: new Date() }, { merge: true });
    await active.paperRef.set({
      analysisStatus: ANALYZING,
      analysisStage: 'Structuring',
      analysisProgressMessage: 'AI text model [Structuring question index]',
      analysisProgressCurrent: batches.length,
      updatedAt: new Date(),
    }, { merge: true });
    const ordered = batches.sort((left, right) => String(left.batchId).localeCompare(String(right.batchId), undefined, { numeric: true }));
    const paperOutputs = ordered.filter((item) => item.documentType === 'paper');
    const memoOutputs = ordered.filter((item) => item.documentType === 'memo');
    const models = [...new Set(ordered.map((item) => item.model).filter(Boolean))];
    const analysis = await normalizeAnalysis({ paperId, paper: active.paper, paperOutputs, memoOutputs, models });
    if (!await ensureActiveRun({ paperId, runId })) return;
    const completedAt = new Date();
    await active.runRef.set({
      status: ANALYZED,
      textModel: analysis.textModel,
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
      analysisTextModel: analysis.textModel,
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

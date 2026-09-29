import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { getDb } from './admin.js';
import { callKiloTextWithFallback, callKiloVisionWithFallback } from './kilo.js';

const ANALYZING = 'Analyzing';
const ANALYZED = 'Analyzed';
const FAILED = 'Failed';
const MAX_PAGES_PER_DOCUMENT = 40;
const PAGES_PER_BATCH = 2;
const PDF_RENDER_SCALE = 1.6;
const MAX_STORED_QUESTIONS = 180;
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

const chunk = (items = [], size = PAGES_PER_BATCH) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
};

const fetchArrayBuffer = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download document (${response.status}).`);
  return response.arrayBuffer();
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
    return textContent.items
      .map((item) => item.str)
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch (error) {
    logger.warn('PDF text extraction skipped for page', { message: error?.message });
    return '';
  }
};

const renderPdfPages = async ({ url, label }) => {
  if (!url) return [];
  const buffer = await fetchArrayBuffer(url);
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    canvasFactory,
    disableWorker: true,
    wasmUrl: pdfWasmUrl,
  });
  const pdf = await loadingTask.promise;
  const totalPages = Math.min(pdf.numPages, MAX_PAGES_PER_DOCUMENT);
  const pages = [];

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport, canvasFactory }).promise;
    const imageDataUrl = canvas.toDataURL('image/jpeg', 0.76);
    const text = await extractPageText(page);
    pages.push({ label, pageNumber, totalPages: pdf.numPages, imageDataUrl, text });
    page.cleanup?.();
  }

  await pdf.destroy?.();
  return pages;
};

const analyzePageBatches = async ({ pages, paperId, paper, paperRef, progressOffset = 0, progressTotal = 1, existingOutputs = [], preservedOutputs = [] }) => {
  const batches = chunk(pages, PAGES_PER_BATCH);
  const outputs = [...existingOutputs];
  const models = new Set(existingOutputs.map((item) => item.model).filter(Boolean));

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const batchPageKey = batch.map((page) => `${page.label}:${page.pageNumber}`).join('|');
    if (outputs.some((item) => item.batchPageKey === batchPageKey && item.text)) {
      const extractedPages = progressOffset + Math.min(pages.length, (batchIndex + 1) * PAGES_PER_BATCH);
      await paperRef?.set({
        analysisProgressMessage: `${batch[0]?.label ?? 'Document'} [${Math.min(pages.length, (batchIndex + 1) * PAGES_PER_BATCH)}/${pages.length} extracted]`,
        analysisProgressCurrent: extractedPages,
        analysisProgressTotal: progressTotal,
        updatedAt: new Date(),
      }, { merge: true });
      continue;
    }
    const result = await callKiloVisionWithFallback({
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              'Analyze these South African exam document pages for Examifying.',
              `Saved paper id: ${paperId}.`,
              `Upload metadata: subject=${paper.subject}, grade=${paper.grade}, region=${paper.region}, month=${paper.month}, year=${paper.year}, paperNumber=${paper.paperNumber ?? 'Paper 1'}, copySuffix=${paper.copySuffix ?? ''}.`,
              'For every visible exam question or memo item, transcribe the question number, topic or subject skill, mark allocation, page number, section heading, and any short instruction needed to identify the question later.',
              'If embedded PDF text is provided, use it as a helper but trust the image for scanned pages.',
              'Return concise plain text grouped by page. Do not return JSON yet.',
              ...batch.map((page) => page.text ? `${page.label} page ${page.pageNumber} embedded text: ${page.text.slice(0, 2500)}` : `${page.label} page ${page.pageNumber}: no embedded text found.`),
            ].join('\n'),
          },
          ...batch.map((page) => ({ type: 'image_url', image_url: { url: page.imageDataUrl } })),
        ],
      }],
      maxTokens: 2600,
      temperature: 0.1,
      mode: 'general',
    });

    if (result?.model) models.add(result.model);
    const output = {
      batchNumber: batchIndex + 1,
      batchPageKey,
      model: result?.model ?? '',
      pages: batch.map((page) => ({ label: page.label, pageNumber: page.pageNumber })),
      text: String(result?.text ?? '').trim(),
      extractedAt: new Date().toISOString(),
    };
    outputs.push(output);
    const extractedPages = progressOffset + Math.min(pages.length, (batchIndex + 1) * PAGES_PER_BATCH);
    await paperRef?.set({
      analysisProgressMessage: `${batch[0]?.label ?? 'Document'} [${Math.min(pages.length, (batchIndex + 1) * PAGES_PER_BATCH)}/${pages.length} extracted]`,
      analysisProgressCurrent: extractedPages,
      analysisProgressTotal: progressTotal,
      analysisBatchOutputs: [...preservedOutputs, ...outputs].map((item) => ({ ...item, text: item.text.slice(0, 6000) })),
      updatedAt: new Date(),
    }, { merge: true });
  }

  return { outputs, models: [...models] };
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
      {
        role: 'user',
        content: [
          'Convert this OCR output into a concise question-paper index for Examifying.',
          'Do not include full copied paper text. Store only metadata and enough question detail to choose exercises later.',
          'Every question must use the exact paperId shown below and must include a pageNumber that opens the question in the original PDF.',
          'Use the uploaded subject when uncertain. If marks are unclear, set marks to 0.',
          `Paper id: ${paperId}`,
          `Uploaded metadata: ${JSON.stringify({ year: paper.year, month: paper.month, subject: paper.subject, grade: paper.grade, region: paper.region, paperNumber: paper.paperNumber ?? 'Paper 1', copySuffix: paper.copySuffix ?? '', displayName: paper.displayName ?? '', notes: paper.notes ?? '' })}`,
          `Return JSON matching this shape: ${JSON.stringify(requestedShape)}`,
          `Paper OCR batches: ${JSON.stringify(paperOutputs)}`,
          `Memo OCR batches: ${JSON.stringify(memoOutputs)}`,
        ].join('\n'),
      },
    ],
    responseFormat: { type: 'json_object' },
    maxTokens: 5000,
    temperature: 0.1,
  });

  const parsed = JSON.parse(extractJsonObject(result?.text ?? '{}'));
  const questions = (Array.isArray(parsed?.questions) ? parsed.questions : [])
    .map((item, index) => normalizeQuestion({ item, index, paperId, fallbackSubject: paper.subject }))
    .filter(Boolean)
    .slice(0, MAX_STORED_QUESTIONS);
  const topics = Array.isArray(parsed?.topics)
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
    textModel: result?.model ?? '',
    visionModels: models,
  };
};

const buildDocumentPages = async ({ paper }) => {
  const [paperPages, memoPages] = await Promise.all([
    renderPdfPages({ url: paper.paperUrl, label: 'Question paper' }),
    paper.memoUrl ? renderPdfPages({ url: paper.memoUrl, label: 'Memorandum' }) : Promise.resolve([]),
  ]);
  return { paperPages, memoPages };
};

const shouldAnalyze = ({ before, after }) => {
  if (!after) return false;
  if (after.analysisStatus !== ANALYZING) return false;
  if (!after.paperUrl) return false;
  if (!before) return true;
  return before.analysisStatus !== ANALYZING ||
    before.paperUrl !== after.paperUrl ||
    before.memoUrl !== after.memoUrl ||
    before.analysisRevision !== after.analysisRevision;
};

export const analyzeQuestionPaper = onDocumentWritten(
  { document: 'questionPapers/{paperId}', timeoutSeconds: 540, memory: '1GiB' },
  async (event) => {
    const paperId = event.params.paperId;
    const before = event.data?.before?.exists ? event.data.before.data() : null;
    const paper = event.data?.after?.exists ? event.data.after.data() : null;
    if (!event.data?.after?.ref || !shouldAnalyze({ before, after: paper })) return;

    const db = getDb();
    const paperRef = db.collection('questionPapers').doc(paperId);

    await paperRef.set({
      analysisStatus: ANALYZING,
      analysisProgressMessage: 'Rendering PDF pages for analysis',
      analysisProgressCurrent: 0,
      analysisProgressTotal: 1,
      availableForGeneration: false,
      analysisStartedAt: new Date(),
      analysisError: '',
      updatedAt: new Date(),
    }, { merge: true });

    try {
      const { paperPages, memoPages } = await buildDocumentPages({ paper });
      if (!paperPages.length) throw new Error('No question paper pages could be rendered for analysis.');

      await paperRef.set({
        analysisProgressMessage: `Question paper [0/${paperPages.length} extracted]`,
        analysisProgressCurrent: 0,
        analysisProgressTotal: Math.max(1, paperPages.length + memoPages.length + 1),
        paperPageCount: paperPages[0]?.totalPages ?? paperPages.length,
        memoPageCount: memoPages[0]?.totalPages ?? memoPages.length,
        updatedAt: new Date(),
      }, { merge: true });

      const existingBatchOutputs = Array.isArray(paper.analysisBatchOutputs) ? paper.analysisBatchOutputs : [];
      const paperResult = await analyzePageBatches({
        pages: paperPages,
        paperId,
        paper,
        paperRef,
        progressOffset: 0,
        progressTotal: Math.max(1, paperPages.length + memoPages.length + 1),
        existingOutputs: existingBatchOutputs.filter((item) => item.pages?.some((page) => page.label === 'Question paper')),
        preservedOutputs: existingBatchOutputs.filter((item) => item.pages?.some((page) => page.label === 'Memorandum')),
      });
      await paperRef.set({ analysisProgressMessage: `Question paper [${paperPages.length}/${paperPages.length} extracted]`, analysisProgressCurrent: paperPages.length, updatedAt: new Date() }, { merge: true });

      const memoResult = memoPages.length ? await analyzePageBatches({
        pages: memoPages,
        paperId,
        paper,
        paperRef,
        progressOffset: paperPages.length,
        progressTotal: Math.max(1, paperPages.length + memoPages.length + 1),
        existingOutputs: existingBatchOutputs.filter((item) => item.pages?.some((page) => page.label === 'Memorandum')),
        preservedOutputs: paperResult.outputs,
      }) : { outputs: [], models: [] };
      await paperRef.set({ analysisProgressMessage: 'AI text model [Structuring question index]', analysisProgressCurrent: paperPages.length + memoPages.length, updatedAt: new Date() }, { merge: true });

      const analysis = await normalizeAnalysis({
        paperId,
        paper,
        paperOutputs: paperResult.outputs,
        memoOutputs: memoResult.outputs,
        models: [...new Set([...paperResult.models, ...memoResult.models])],
      });

      await paperRef.set({
        analysisStatus: ANALYZED,
        availableForGeneration: analysis.questions.length > 0,
        paperMetadata: analysis.metadata,
        questions: analysis.questions,
        questionCount: analysis.questions.length,
        topics: analysis.topics,
        analysisBatchOutputs: [...paperResult.outputs, ...memoResult.outputs].map((item) => ({ ...item, text: item.text.slice(0, 6000) })),
        paperDocumentAnalysis: paperResult.outputs.map((item) => item.text).filter(Boolean).join('\n\n').slice(0, 45000),
        memoDocumentAnalysis: memoResult.outputs.map((item) => item.text).filter(Boolean).join('\n\n').slice(0, 25000),
        paperDocumentAnalysisModel: paperResult.models.join(', '),
        memoDocumentAnalysisModel: memoResult.models.join(', '),
        paperDocumentAnalysisPageCount: paperPages.length,
        memoDocumentAnalysisPageCount: memoPages.length,
        paperAnalysisSummary: analysis.summary,
        analysisReadabilityNotes: analysis.readabilityNotes,
        analysisTextModel: analysis.textModel,
        analysisVisionModels: analysis.visionModels,
        analysisProgressMessage: analysis.questions.length ? `Analyzed ${analysis.questions.length} questions` : 'Analyzed, but no questions were identified',
        analysisProgressCurrent: Math.max(1, paperPages.length + memoPages.length + 1),
        analysisProgressTotal: Math.max(1, paperPages.length + memoPages.length + 1),
        analysisCompletedAt: new Date(),
        updatedAt: new Date(),
      }, { merge: true });

      logger.info('Question paper analysis completed', { paperId, questionCount: analysis.questions.length });
    } catch (error) {
      logger.error('Question paper analysis failed', { paperId, message: error?.message, stack: error?.stack });
      const latestSnapshot = await paperRef.get().catch(() => null);
      const latestPaper = latestSnapshot?.exists ? latestSnapshot.data() : paper;
      await paperRef.set({
        analysisStatus: FAILED,
        availableForGeneration: false,
        analysisError: error?.message ?? String(error),
        analysisProgressMessage: 'Analysis failed. Upload a clearer PDF or retry later.',
        analysisProgressCurrent: latestPaper?.analysisProgressCurrent ?? paper.analysisProgressCurrent ?? 0,
        analysisProgressTotal: latestPaper?.analysisProgressTotal ?? paper.analysisProgressTotal ?? 1,
        updatedAt: new Date(),
      }, { merge: true });
    }
  }
);
